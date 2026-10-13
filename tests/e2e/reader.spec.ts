import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Needs the fixture (npm run fixtures) and the recommended speech models (npm run models).
// The tests share one app window and build on each other, in order.
const fixture = join(import.meta.dirname, '../fixtures/sample.pdf');
let app: ElectronApplication;
let page: Page;
let pdfPath: string;
const pageErrors: string[] = [];

// Later tests use the marks made by earlier ones, so a failure skips the rest instead of
// running them against a fresh app.
test.describe.configure({ mode: 'serial' });

/** The text currently painted under a named highlight, or null if nothing is. */
const highlighted = (name: string): Promise<string | null> =>
  page.evaluate((n) => {
    const highlight = CSS.highlights.get(n);
    return highlight ? [...highlight].map((range) => range.toString()).join('') : null;
  }, name);

/** Selects a phrase inside one element of the visible view, as a mouse drag would. */
const select = (elements: string, phrase: string): Promise<void> =>
  page.evaluate(
    ([selector, wanted]) => {
      const element = [...document.querySelectorAll(selector!)].find((e) => e.textContent.includes(wanted!))!;
      const text = element.firstChild!;
      const start = text.textContent!.indexOf(wanted!);
      const range = new Range();
      range.setStart(text, start);
      range.setEnd(text, start + wanted!.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    [elements, phrase],
  );

/** Collects the spoken word highlight until `count` different words were seen. */
async function spokenWords(count: number): Promise<string[]> {
  const words: string[] = [];
  await expect
    .poll(
      async () => {
        const word = await highlighted('spoken-word');
        if (word && words.at(-1) !== word) words.push(word);
        return words.length;
      },
      { timeout: 120_000, intervals: [40] },
    )
    .toBeGreaterThanOrEqual(count);
  return words;
}

test.beforeAll(async () => {
  // A copy in a temp folder keeps notes files and settings out of the repository and the real profile.
  const dir = mkdtempSync(join(tmpdir(), 'pdfreader-'));
  pdfPath = join(dir, 'sample.pdf');
  copyFileSync(fixture, pdfPath);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  // Set by VS Code's extension host; it would make Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', pdfPath, '--mute-audio'], env: env as Record<string, string> });
  page = await app.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
});

// An exception in the window fails the test it happened in, even if the page still looks right.
test.afterEach(() => {
  expect(pageErrors.splice(0)).toEqual([]);
});

test.afterAll(async () => {
  await app.close();
});

test('opens the PDF given on the command line', async () => {
  await expect(page.locator('#title')).toHaveText('sample.pdf');
  await expect(page.locator('#page-info')).toHaveText('1 / 2');
  await expect(page.locator('.textLayer span').first()).toBeAttached();
});

test('highlights a selection, saves the comment and exports Markdown', async () => {
  await select('.textLayer span', 'Dieser Text');
  await page.click('#selection-menu [data-color="green"]');
  await expect(page.locator('#annotations blockquote')).toHaveText('Dieser Text');
  expect(await highlighted('note-highlight-green')).toBe('Dieser Text');

  await page.fill('#annotations textarea', 'Checks language detection.');
  await page.fill('#notes', 'Solid test document.');
  const notesPath = `${pdfPath}.notes.json`;
  await expect
    .poll(() => (existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : ''))
    .toContain('Solid test document.');
  expect(JSON.parse(readFileSync(notesPath, 'utf8')).annotations[0]).toMatchObject({
    page: 1,
    text: 'Dieser Text',
    kind: 'highlight',
    color: 'green',
    comment: 'Checks language detection.',
  });

  await page.click('#export');
  await expect(page.locator('#status')).toContainText('Exported to');
  expect(readFileSync(`${pdfPath}.notes.md`, 'utf8')).toContain(
    '> Dieser Text\n\nChecks language detection.',
  );
});

test('underlines and strikes through, and saves a PDF that other programs can read', async () => {
  await select('.textLayer span', 'Sprachsynthese');
  await page.click('#selection-menu [data-kind="underline"]');
  await page.click('#selection-menu [data-color="red"]');
  expect(await highlighted('note-underline-red')).toBe('Sprachsynthese');
  // The chosen kind stays selected for the next mark, so pick the next one explicitly.
  await select('.textLayer span', 'Zitate');
  await page.click('#selection-menu [data-kind="strike"]');
  await page.click('#selection-menu [data-color="blue"]');
  expect(await highlighted('note-strike-blue')).toBe('Zitate');

  // The save dialog cannot be driven, so answer it from the main process.
  const outPath = join(pdfPath, '..', 'sample.annotated.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, outPath);
  await page.click('#export-pdf');
  await expect(page.locator('#status')).toContainText('sample.annotated.pdf');

  // Read the result back with PDF.js alone, as a browser's PDF viewer would.
  const task = getDocument({ data: new Uint8Array(readFileSync(outPath)), verbosity: 0 });
  const saved = await (await task.promise).getPage(1);
  const annotations = await saved.getAnnotations();
  expect(annotations.map((a) => a.subtype).sort()).toEqual(['Highlight', 'StrikeOut', 'Text', 'Underline']);
  const bySubtype = (subtype: string): Record<string, unknown> =>
    annotations.find((a) => a.subtype === subtype)!;
  expect((bySubtype('Highlight').contentsObj as { str: string }).str).toBe('Checks language detection.');
  expect((bySubtype('Text').contentsObj as { str: string }).str).toBe('Solid test document.');

  // The underline must sit on the word it marks: compare with where the PDF itself draws that word.
  const content = await saved.getTextContent();
  const run = content.items.find((i) => 'str' in i && i.str.includes('Sprachsynthese')) as {
    str: string;
    transform: number[];
    width: number;
    height: number;
  };
  const [left, bottom, right, top] = bySubtype('Underline').rect as number[];
  const baseline = run.transform[5]!;
  expect(bottom!).toBeLessThan(baseline + 1);
  expect(top!).toBeGreaterThan(baseline + run.height * 0.5);
  expect(top! - bottom!).toBeLessThan(run.height * 2);
  expect(left!).toBeGreaterThan(run.transform[4]! - 2);
  expect(right!).toBeLessThan(run.transform[4]! + run.width + 2);
  expect(right! - left!).toBeGreaterThan(40);
  await task.destroy();
});

test('searches the document and steps through the matches', async () => {
  await page.fill('#search', 'spalte');
  // All matches are on page 2: the search has to go there and render it.
  await expect(page.locator('#search-count')).toHaveText('1 / 4');
  await expect.poll(() => highlighted('search-current')).toBe('Spalte');
  await expect(page.locator('#page-info')).toHaveText('2 / 2');
  await page.press('#search', 'Enter');
  await expect(page.locator('#search-count')).toHaveText('2 / 4');
  await page.press('#search', 'Shift+Enter');
  await page.press('#search', 'Shift+Enter');
  await expect(page.locator('#search-count')).toHaveText('4 / 4');

  // A phrase broken over two lines in the PDF is still found.
  await page.fill(
    '#search',
    'ob das Programm deutsche und englische Sätze richtig erkennt. Die Verarbeitung',
  );
  await expect(page.locator('#search-count')).toHaveText('1 / 1');
  await page.fill('#search', 'nicht vorhanden');
  await expect(page.locator('#search-count')).toHaveText('No results');
  await page.press('#search', 'Escape');
  await expect(page.locator('#search-count')).toHaveText('');
  expect(await highlighted('search-match')).toBeNull();
});

test('reads aloud and moves the word highlight through the text in order', async () => {
  await page.evaluate(() => document.querySelector('#scroller')!.scrollTo(0, 0));
  await expect(page.locator('#page-info')).toHaveText('1 / 2');
  await page.click('#play');
  const words = await spokenWords(8);
  // The heading comes first, then the first sentence of the body.
  expect(words.slice(0, 3)).toEqual(['Vorlesen', 'wissenschaftlicher', 'Texte']);
  expect(words.slice(3)).toEqual('Dieser Text prüft ob das Programm'.split(' ').slice(0, words.length - 3));
  expect(await highlighted('spoken-sentence')).toContain('Dieser Text prüft');

  // Pausing freezes the highlight; stopping clears it.
  await page.click('#play');
  const paused = await highlighted('spoken-word');
  await page.waitForTimeout(1200);
  expect(await highlighted('spoken-word')).toBe(paused);
  await page.click('#stop');
  expect(await highlighted('spoken-word')).toBeNull();
  expect(await highlighted('spoken-sentence')).toBeNull();
});

test('shows the reading view with the same marks, speech and search', async () => {
  await page.click('#toggle-reading');
  await expect(page.locator('#reading')).toBeVisible();
  await expect(page.locator('#viewer-container')).toBeHidden();
  await expect(page.locator('#reading-text h2').first()).toHaveText('Vorlesen wissenschaftlicher Texte');
  // Hyphenation at the PDF's line ends is undone, and page numbers are not part of the text.
  const text = await page.locator('#reading-text').innerText();
  expect(text).toContain('Silbentrennung am Zeilenende muss dabei rückgängig gemacht werden');
  expect(text).not.toMatch(/\n[12]\n/u);

  // Marks made on the PDF pages show up here, and marks made here are saved like any other.
  expect(await highlighted('note-highlight-green')).toBe('Dieser Text');
  expect(await highlighted('note-underline-red')).toBe('Sprachsynthese');
  await select('#reading-text p', 'vollständig lokal');
  await page.click('#selection-menu [data-kind="highlight"]');
  await page.click('#selection-menu [data-color="yellow"]');
  expect(await highlighted('note-highlight-yellow')).toBe('vollständig lokal');
  await expect(page.locator('#annotations blockquote')).toHaveCount(4);

  // The text settings apply at once and are remembered.
  await page.selectOption('#reading-font', 'OpenDyslexic');
  await page.fill('#reading-size', '28');
  const style = await page
    .locator('#reading-text p')
    .first()
    .evaluate((p) => getComputedStyle(p));
  expect(style.fontFamily).toContain('OpenDyslexic');
  expect(style.fontSize).toBe('28px');
  expect(await page.evaluate(() => document.fonts.check('28px OpenDyslexic'))).toBe(true);

  // Speech highlights words here exactly as on the PDF pages.
  await select('#reading-text p', 'Die Verarbeitung');
  await page.click('#read-from-here');
  const words = await spokenWords(5);
  expect(words).toEqual(
    'Die Verarbeitung erfolgt vollständig lokal auf dem'.split(' ').slice(0, words.length),
  );

  // Switching back keeps the voice and its highlight, now on the PDF page.
  await page.click('#toggle-reading');
  await expect(page.locator('#viewer-container')).toBeVisible();
  await expect.poll(() => highlighted('spoken-sentence')).not.toBeNull();
  expect(await highlighted('note-highlight-yellow')).toBe('vollständig lokal');
  await page.click('#stop');

  // Search works in the reading view too.
  await page.click('#toggle-reading');
  await page.fill('#search', 'Hauptstimme');
  await expect(page.locator('#search-count')).toHaveText('1 / 1');
  expect(await highlighted('search-current')).toBe('Hauptstimme');
});
