import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Needs the fixture (npm run fixtures) and the recommended speech models (npm run models).
const fixture = join(import.meta.dirname, '../fixtures/sample.pdf');
let app: ElectronApplication;
let page: Page;
let pdfPath: string;

const highlighted = (name: string): Promise<string | null> =>
  page.evaluate((n) => {
    const highlight = CSS.highlights.get(n);
    return highlight ? [...highlight].map((range) => range.toString()).join('') : null;
  }, name);

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
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('.textLayer span')].find((s) =>
      s.textContent.includes('Dieser'),
    )!;
    const text = span.firstChild!;
    const start = text.textContent!.indexOf('Dieser');
    const range = new Range();
    range.setStart(text, start);
    range.setEnd(text, start + 'Dieser Text'.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.click('#selection-menu [data-color="green"]');
  await expect(page.locator('#annotations blockquote')).toHaveText('Dieser Text');
  expect(await highlighted('note-green')).toBe('Dieser Text');

  await page.fill('#annotations textarea', 'Checks language detection.');
  await page.fill('#notes', 'Solid test document.');
  const notesPath = `${pdfPath}.notes.json`;
  await expect
    .poll(() => (existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : ''))
    .toContain('Solid test document.');
  expect(JSON.parse(readFileSync(notesPath, 'utf8')).annotations[0]).toMatchObject({
    page: 1,
    text: 'Dieser Text',
    color: 'green',
    comment: 'Checks language detection.',
  });

  await page.click('#export');
  await expect(page.locator('#status')).toContainText('Exported to');
  expect(readFileSync(`${pdfPath}.notes.md`, 'utf8')).toContain(
    '> Dieser Text\n\nChecks language detection.',
  );
});

test('reads aloud and moves the word highlight through the text in order', async () => {
  await page.click('#play');
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
    .toBeGreaterThanOrEqual(8);
  // The heading comes first, then the first sentence of the body.
  expect(words.slice(0, 3)).toEqual(['Vorlesen', 'wissenschaftlicher', 'Texte']);
  expect(words.slice(3)).toEqual(
    'Dieser Text prüft, ob das Programm'
      .replace(',', '')
      .split(' ')
      .slice(0, words.length - 3),
  );
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
