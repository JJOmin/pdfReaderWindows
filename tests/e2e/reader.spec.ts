import {
  _electron as electron,
  expect,
  test,
  type CDPSession,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { glyphBoxes, placeOnRaw } from '../../src/renderer/src/glyphs';
import { rawString, TEXT_CONTENT_OPTIONS, toRawItems } from '../../src/shared/items';
import { measureAlignment } from './ink';

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

/**
 * Selects a phrase inside one element of the visible view, as a mouse drag would. The phrase
 * may run over several text nodes: the text layer holds one span per word.
 */
const select = (elements: string, phrase: string): Promise<void> =>
  page.evaluate(
    ([selector, wanted]) => {
      const element = [...document.querySelectorAll(selector!)].find((e) => e.textContent.includes(wanted!))!;
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
      const start = nodes
        .map((n) => n.data)
        .join('')
        .indexOf(wanted!);
      const end = start + wanted!.length;
      const range = new Range();
      let at = 0;
      for (const node of nodes) {
        if (start >= at && start < at + node.length) range.setStart(node, start - at);
        if (end > at && end <= at + node.length) range.setEnd(node, end - at);
        at += node.length;
      }
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
  // One pixel per point, as on the PC. On a Retina Mac at 200 % zoom PDF.js caps the page canvas by
  // the screen's area and draws the visible part on a second canvas, so the ink measured below
  // would come from a canvas at less than half resolution.
  app = await electron.launch({
    args: ['.', pdfPath, '--mute-audio', '--force-device-scale-factor=1'],
    env: env as Record<string, string>,
  });
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
  await select('.textLayer', 'Dieser Text');
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
  await select('.textLayer', 'Sprachsynthese');
  await page.click('#selection-menu [data-kind="underline"]');
  await page.click('#selection-menu [data-color="red"]');
  expect(await highlighted('note-underline-red')).toBe('Sprachsynthese');
  // The chosen kind stays selected for the next mark, so pick the next one explicitly.
  await select('.textLayer', 'Zitate');
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

test('keeps every word highlight on its letters, at two zoom levels', async () => {
  const check = async (): Promise<{ words: number; worst: number; pixelsPerPoint: number }> => {
    const { words, skippedLines, pixelsPerPoint } = await measureAlignment(page, [1, 2]);
    // Heading, justified body and both columns of page 2 all take part.
    expect(words.filter((w) => w.page === 1).length).toBeGreaterThan(30);
    expect(words.filter((w) => w.page === 2).length).toBeGreaterThan(30);
    expect(skippedLines).toBeLessThan(4);
    const off = words.filter((w) => w.worst > 0.15).map((w) => `${w.text} ${w.worst.toFixed(2)}`);
    expect(off).toEqual([]);
    return { words: words.length, worst: Math.max(...words.map((w) => w.worst)), pixelsPerPoint };
  };
  const first = await check();
  const report = `alignment: ${first.words} words, worst ${first.worst.toFixed(3)} em at ${first.pixelsPerPoint.toFixed(2)} px/pt`;
  // PDF.js caps a page canvas at three times the screen's area (its capCanvasAreaFactor) and then
  // draws only the visible part sharp, so the ink of a whole page cannot be measured. Double the
  // zoom fits a 1920 x 1080 screen, not a 1440 x 900 MacBook Air.
  const fits = await page.evaluate((scale) => {
    const box = document.querySelector('.page')!.getBoundingClientRect();
    const pixels = box.width * box.height * (scale * devicePixelRatio) ** 2;
    return pixels <= screen.availWidth * screen.availHeight * devicePixelRatio ** 2 * 3;
  }, 1.1 ** 7);
  if (!fits) {
    console.log(`${report}; double the zoom not measured, the screen is too small`);
    return;
  }
  // Seven steps of 10 % are close to double.
  for (let i = 0; i < 7; i++) await page.click('#zoom-in');
  const second = await check();
  expect(second.pixelsPerPoint / first.pixelsPerPoint).toBeGreaterThan(1.9);
  console.log(
    `${report}; ${second.words} words, worst ${second.worst.toFixed(3)} em at ${second.pixelsPerPoint.toFixed(2)} px/pt`,
  );
  for (let i = 0; i < 7; i++) await page.click('#zoom-out');
});

interface MarkPicture {
  markTop: number;
  markBottom: number;
  markLeft: number;
  markRight: number;
  baseline: number;
  inkLeft: number;
  inkRight: number;
  size: number;
}

/** Finds the line a mark draws and the ink of its word in a screenshot of the word. */
async function pictureOf(name: string, colour: 'red' | 'blue'): Promise<MarkPicture> {
  const target = await page.evaluate((n) => {
    const range = [...CSS.highlights.get(n)!][0]! as Range;
    const element = range.startContainer.parentElement!;
    element.scrollIntoView({ block: 'center' });
    const rect = range.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      size: parseFloat(getComputedStyle(element).fontSize),
    };
  }, name);
  // Wide enough for the mark and a letter's overhang, too narrow to reach the next word.
  const margin = 0.2 * target.size;
  const lift = 0.35 * target.size;
  const clip = {
    x: target.x - margin,
    y: target.y - lift,
    width: target.width + 2 * margin,
    height: target.height + 2 * lift,
  };
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async ({ data, colour, size, margin, width }) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const { data: px } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      // The screenshot is in device pixels.
      const scale = bitmap.width / (width + 2 * margin);
      const isMark = (r: number, g: number, b: number): boolean =>
        colour === 'red' ? r > 190 && g < 110 && b < 110 : b > 180 && r < 100 && g > 90 && g < 180;
      const rows: number[] = new Array<number>(bitmap.height).fill(0);
      const marked: number[] = new Array<number>(bitmap.height).fill(0);
      const ink = { left: Infinity, right: -1 };
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
          const o = (y * bitmap.width + x) * 4;
          const [r, g, b] = [px[o]!, px[o + 1]!, px[o + 2]!];
          if (isMark(r, g, b)) marked[y]!++;
          else if (r < 110 && g < 110 && b < 110) {
            rows[y]!++;
            ink.left = Math.min(ink.left, x);
            ink.right = Math.max(ink.right, x);
          }
        }
      }
      // The mark is a line: rows where much of the word's width has its colour. Single pixels
      // of that colour are the colour fringes of antialiased letters.
      const mark = { top: Infinity, bottom: -1, left: Infinity, right: -1 };
      for (let y = 0; y < bitmap.height; y++) {
        if (marked[y]! < 0.5 * width * scale) continue;
        mark.top = Math.min(mark.top, y);
        mark.bottom = Math.max(mark.bottom, y);
        for (let x = 0; x < bitmap.width; x++) {
          const o = (y * bitmap.width + x) * 4;
          if (isMark(px[o]!, px[o + 1]!, px[o + 2]!)) {
            mark.left = Math.min(mark.left, x);
            mark.right = Math.max(mark.right, x);
          }
        }
      }
      // The baseline is the lowest row that many letters touch; descenders are few.
      const most = Math.max(...rows);
      let baseline = 0;
      rows.forEach((n, y) => {
        if (n >= 0.35 * most) baseline = y;
      });
      return {
        markTop: mark.top / scale,
        markBottom: (mark.bottom + 1) / scale,
        markLeft: mark.left / scale,
        markRight: (mark.right + 1) / scale,
        baseline: (baseline + 1) / scale,
        inkLeft: ink.left / scale,
        inkRight: (ink.right + 1) / scale,
        size,
      };
    },
    { data: png.toString('base64'), colour, size: target.size, margin, width: target.width },
  );
}

/** The underline and the strikethrough made earlier are drawn on their words, as the screen shows them. */
async function expectMarksOnTheirWords(): Promise<void> {
  // Red underline under "Sprachsynthese": just below the baseline, as wide as the letters.
  const under = await pictureOf('note-underline-red', 'red');
  const underAt = (under.markTop + under.markBottom) / 2;
  expect(underAt).toBeGreaterThan(under.baseline - 0.1 * under.size);
  expect(underAt).toBeLessThan(under.baseline + 0.35 * under.size);
  expect(Math.abs(under.markLeft - under.inkLeft)).toBeLessThan(0.15 * under.size);
  expect(Math.abs(under.markRight - under.inkRight)).toBeLessThan(0.15 * under.size);

  // Blue line through "Zitate": at the height of the lower-case letters, inside the line of text.
  const strike = await pictureOf('note-strike-blue', 'blue');
  const strikeAt = (strike.markTop + strike.markBottom) / 2;
  expect(strikeAt).toBeLessThan(strike.baseline - 0.1 * strike.size);
  expect(strikeAt).toBeGreaterThan(strike.baseline - 0.6 * strike.size);
  expect(Math.abs(strike.markLeft - strike.inkLeft)).toBeLessThan(0.15 * strike.size);
  expect(Math.abs(strike.markRight - strike.inkRight)).toBeLessThan(0.15 * strike.size);
}

test('draws underline and strikethrough on the line of their word', async () => {
  await page.evaluate(() => document.querySelector('#scroller')!.scrollTo(0, 0));
  await expectMarksOnTheirWords();
});

test('saves marks where the PDF itself draws the word', async () => {
  const outPath = join(pdfPath, '..', 'sample.annotated.pdf');
  const task = getDocument({ data: new Uint8Array(readFileSync(pdfPath)), verbosity: 0 });
  const original = await (await task.promise).getPage(1);
  const content = await original.getTextContent(TEXT_CONTENT_OPTIONS);
  const raw = rawString(toRawItems(content.items as never, original.view[1]!));
  const list = await original.getOperatorList();
  const place = placeOnRaw(
    raw,
    glyphBoxes(list.fnArray, list.argsArray, OPS, (name) => {
      if (!original.commonObjs.has(name)) return undefined;
      const font = original.commonObjs.get(name) as { fontMatrix?: number[]; vertical?: boolean };
      return { scale: font.fontMatrix?.[0] ?? 0.001, vertical: font.vertical === true };
    }),
  );
  const drawn = (word: string): [number, number] => {
    const at = raw.indexOf(word);
    expect(at).toBeGreaterThan(0);
    return [place.x0[at]!, place.x1[at + word.length - 1]!];
  };
  await task.destroy();

  // A word near the end of a justified line is where a layer that stretches the line evenly is
  // furthest off, so mark one and save a second copy.
  await page.evaluate(() => document.querySelector('#scroller')!.scrollTo(0, 0));
  // The scroll event can arrive after the selection and hide its menu, so select until it stays.
  await expect(async () => {
    await select('.textLayer', 'vollständig');
    await page.click('#selection-menu [data-kind="highlight"]', { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await page.click('#selection-menu [data-color="yellow"]');
  const secondPath = join(pdfPath, '..', 'sample.words.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath });
  }, secondPath);
  await page.click('#export-pdf');
  await expect(page.locator('#status')).toContainText('sample.words.pdf');
  // Leave the marks as the later tests expect them.
  await page.click('#annotations li[data-color="yellow"] .delete');

  const open = async (path: string): Promise<Record<string, unknown>[]> => {
    const savedTask = getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 });
    const saved = await (await savedTask.promise).getPage(1);
    const annotations = (await saved.getAnnotations()) as Record<string, unknown>[];
    await savedTask.destroy();
    return annotations;
  };
  // The body text is 11 pt, so 15 % of its height is 1.65 pt.
  const near = (rect: unknown, word: string): void => {
    const [left, , right] = rect as number[];
    const [drawnLeft, drawnRight] = drawn(word);
    expect(Math.abs(left! - drawnLeft)).toBeLessThan(1.65);
    expect(Math.abs(right! - drawnRight)).toBeLessThan(1.65);
  };
  near((await open(outPath)).find((a) => a.subtype === 'Underline')!.rect, 'Sprachsynthese');
  // The first highlight carries a comment; the new one has none.
  const fresh = (await open(secondPath)).find(
    (a) => a.subtype === 'Highlight' && (a.contentsObj as { str: string }).str === '',
  )!;
  near(fresh.rect, 'vollständig');
});

let input: CDPSession | undefined;

/** The keys that zoom, with the codes the German layout and the numpad send. */
const ZOOM_KEYS = {
  plus: ['+', 'BracketRight', 0xbb],
  minus: ['-', 'Slash', 0xbd],
  numpadPlus: ['+', 'NumpadAdd', 0x6b],
  numpadMinus: ['-', 'NumpadSubtract', 0x6d],
} as const;

/** Presses a key with Ctrl held, below the page, so the browser's own shortcuts see it too. */
async function ctrlKey(key: keyof typeof ZOOM_KEYS): Promise<void> {
  input ??= await page.context().newCDPSession(page);
  const [text, code, vk] = ZOOM_KEYS[key];
  const event = { key: text, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 };
  await input.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  await input.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

async function ctrlWheel(x: number, y: number, deltaY: number): Promise<void> {
  input ??= await page.context().newCDPSession(page);
  await page.mouse.move(x, y);
  await input.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 2 });
}

/** Width and height of what must not change when the document zooms. */
const chromeSizes = (): Promise<number[][]> =>
  page.evaluate(() =>
    [
      '#toolbar',
      '#open',
      '#play',
      '#stop',
      '#speed',
      '#search',
      '#toggle-reading',
      '#sidebar',
      '#status',
    ].map((selector) => {
      const { width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return [width, height];
    }),
  );

const pageWidth = (): Promise<number> =>
  page.evaluate(() => document.querySelector('.page[data-page-number="1"]')!.getBoundingClientRect().width);

/** Zoom of the window as a whole, which the document's zoom must leave alone. */
const windowZoom = (): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor());

/**
 * Centre of a word on page 1, in window coordinates. PDF.js hides the text layer while it
 * redraws after a zoom, so this waits until the word has a box.
 */
async function centreOf(word: string): Promise<{ x: number; y: number }> {
  const find = (): Promise<{ x: number; y: number; width: number }> =>
    page.evaluate((wanted) => {
      const layer = document.querySelector('.page[data-page-number="1"] .textLayer')!;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const at = node.data.indexOf(wanted);
        if (at < 0) continue;
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width };
      }
      return { x: 0, y: 0, width: 0 };
    }, word);
  await expect.poll(async () => (await find()).width, { message: word }).toBeGreaterThan(0);
  return find();
}

test('zooms the document and nothing else, by key and by wheel', async () => {
  await page.evaluate(() => document.querySelector('#scroller')!.scrollTo(0, 0));
  const chrome = await chromeSizes();
  expect(await windowZoom()).toBe(1);
  // The default menu's own zoom items would scale the toolbar too: they must be off.
  const menuZoom = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? [])
      .flatMap((top) => top.submenu?.items ?? [])
      .filter((item) => ['zoomin', 'zoomout', 'resetzoom'].includes(item.role ?? ''))
      .map((item) => item.enabled),
  );
  expect(menuZoom).toEqual([false, false, false]);

  const keys = [
    ['plus', 1.1],
    ['minus', 1 / 1.1],
    ['numpadPlus', 1.1],
    ['numpadMinus', 1 / 1.1],
  ] as const;
  for (const [key, ratio] of keys) {
    const before = await pageWidth();
    await ctrlKey(key);
    await expect.poll(pageWidth).not.toBe(before);
    expect((await pageWidth()) / before, key).toBeCloseTo(ratio, 1);
    expect(await chromeSizes(), key).toEqual(chrome);
    expect(await windowZoom(), key).toBe(1);
  }

  // Three notches of the wheel, in and out, with a word under the pointer that must stay under it.
  for (const deltaY of [-300, 300]) {
    const at = await centreOf('Programm');
    const before = await pageWidth();
    await ctrlWheel(at.x, at.y, deltaY);
    await expect.poll(pageWidth).not.toBe(before);
    expect((await pageWidth()) / before).toBeCloseTo(deltaY < 0 ? 1.1 ** 3 : 1.1 ** -3, 1);
    const now = await centreOf('Programm');
    expect(Math.abs(now.x - at.x)).toBeLessThan(3);
    expect(Math.abs(now.y - at.y)).toBeLessThan(3);
    expect(await chromeSizes()).toEqual(chrome);
    expect(await windowZoom()).toBe(1);
  }

  // Marks and highlights are still on their letters once the pages were redrawn larger.
  const at = await centreOf('Programm');
  await ctrlWheel(at.x, at.y, -300);
  const { words } = await measureAlignment(page, [1, 2]);
  expect(words.filter((w) => w.worst > 0.15).map((w) => w.text)).toEqual([]);
  await expectMarksOnTheirWords();
  await page.evaluate(() => document.querySelector('#scroller')!.scrollTo(0, 0));
  const back = await centreOf('Programm');
  await ctrlWheel(back.x, back.y, 300);
  await expect.poll(pageWidth).toBeLessThan(1100);
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
  // The audio clock stops a moment after the click, and a word can still arrive in that moment.
  await page.waitForTimeout(300);
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

test('zooms the reading view as text size, by key and by wheel', async () => {
  await expect(page.locator('#reading')).toBeVisible();
  const chrome = await chromeSizes();
  const textSize = (): Promise<number> =>
    page
      .locator('#reading-text p')
      .first()
      .evaluate((p) => parseFloat(getComputedStyle(p).fontSize));
  const start = await textSize();
  const steps = [
    ['plus', 2],
    ['minus', -2],
    ['numpadPlus', 2],
    ['numpadMinus', -2],
  ] as const;
  for (const [key, change] of steps) {
    const before = await textSize();
    await ctrlKey(key);
    await expect.poll(textSize, key).toBe(before + change);
    expect(await chromeSizes(), key).toEqual(chrome);
  }
  // One notch of the wheel is one step, as one press of a key is.
  for (const [deltaY, change] of [
    [-100, 2],
    [100, -2],
  ] as const) {
    const before = await textSize();
    await ctrlWheel(600, 450, deltaY);
    await expect.poll(textSize).toBe(before + change);
    expect(await chromeSizes()).toEqual(chrome);
  }
  expect(await textSize()).toBe(start);
  expect(await windowZoom()).toBe(1);
  // The marks are still on their words after the text reflowed.
  expect(await highlighted('note-highlight-green')).toBe('Dieser Text');
});

/** Distance of the middle of a highlight from the middle of the view that scrolls; NaN if none is painted. */
const offCentre = (name: string): Promise<number> =>
  page.evaluate((highlightName) => {
    const highlight = CSS.highlights.get(highlightName);
    if (!highlight) return Number.NaN;
    const boxes = [...highlight]
      .map((range) => (range as Range).getBoundingClientRect())
      .filter((box) => box.height > 0);
    if (boxes.length === 0) return Number.NaN;
    const reading = document.querySelector<HTMLElement>('#reading')!;
    const view = (reading.hidden ? document.querySelector('#scroller')! : reading).getBoundingClientRect();
    const middle = (Math.min(...boxes.map((b) => b.top)) + Math.max(...boxes.map((b) => b.bottom))) / 2;
    return middle - (view.top + view.height / 2);
  }, name);

const scrollTop = (): Promise<number> =>
  page.evaluate(() => {
    const reading = document.querySelector<HTMLElement>('#reading')!;
    return (reading.hidden ? document.querySelector('#scroller')! : reading).scrollTop;
  });

/** Waits for the voice to move on to another sentence than `previous`. */
async function nextSentence(previous: string | null): Promise<string> {
  await expect
    .poll(
      async () => {
        const now = await highlighted('spoken-sentence');
        return now !== null && now !== previous;
      },
      { timeout: 60_000, intervals: [40] },
    )
    .toBe(true);
  return (await highlighted('spoken-sentence'))!;
}

/** Waits until the highlight is within 20 px of the middle of the view. */
const expectCentred = (name: string): Promise<void> =>
  expect
    .poll(async () => Math.abs(await offCentre(name)), { message: name, timeout: 6000, intervals: [50] })
    .toBeLessThanOrEqual(20);

/** Makes the window short, so that a sentence of a few lines is most of the view. */
const windowHeight = (height: number): Promise<void> =>
  app.evaluate(({ BrowserWindow }, h) => BrowserWindow.getAllWindows()[0]!.setSize(1400, h), height);

/** Puts the voice on the first sentence of a phrase on page 2, in the view that is showing. */
async function readFrom(phrase: string): Promise<void> {
  const reading = await page.locator('#reading').isVisible();
  if (!reading) {
    await page.evaluate(() => {
      const second = document.querySelector<HTMLElement>('.page[data-page-number="2"]')!;
      document.querySelector('#scroller')!.scrollTo(0, second.offsetTop);
    });
    await expect(page.locator('.page[data-page-number="2"] .textLayer span').first()).toBeAttached();
    await expect
      .poll(() => page.locator('.page[data-page-number="2"] .textLayer span').count())
      .toBeGreaterThan(5);
  }
  // Scrolling hides the selection menu, and a view that was just switched is still scrolling,
  // so the selection and the click are made again until the menu is there for both.
  await expect(async () => {
    await select(reading ? '#reading-text p' : '.textLayer', phrase);
    await page.click('#read-from-here', { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

test('focus mode keeps the spoken sentence in the middle of the view, in both views', async () => {
  // Off until switched on, and then the view is left to its old behaviour.
  await expect(page.locator('#focus-mode')).toHaveAttribute('aria-pressed', 'false');
  await page.click('#toggle-reading');
  await expect(page.locator('#viewer-container')).toBeVisible();
  await page.fill('#search', '');
  // Smaller pages put the sentence well above the middle on any screen. A Mac's window is
  // shorter, because macOS keeps it inside a 900 px screen.
  for (let i = 0; i < 3; i++) await page.click('#zoom-out');
  await readFrom('Die linke Spalte');
  const first = await nextSentence(null);
  const topBefore = await scrollTop();
  // A sentence near the top of the view is where PDF.js's old rule leaves it alone.
  expect(Math.abs(await offCentre('spoken-sentence'))).toBeGreaterThan(40);
  await nextSentence(first);
  await page.waitForTimeout(500);
  expect(Math.abs((await scrollTop()) - topBefore)).toBeLessThanOrEqual(1);
  expect(Math.abs(await offCentre('spoken-sentence'))).toBeGreaterThan(40);

  // Switched on: the current sentence moves to the middle at once, and so does each new one,
  // even when the user has just scrolled it away.
  await page.click('#focus-mode');
  await expect(page.locator('#focus-mode')).toHaveAttribute('aria-pressed', 'true');
  await expectCentred('spoken-sentence');
  const settingsPath = join(pdfPath, '..', 'profile', 'settings.json');
  await expect
    .poll(() => (existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')).focusMode : null))
    .toBe(true);
  await page.mouse.move(500, 400);
  let sentence = (await highlighted('spoken-sentence'))!;
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 200);
    sentence = await nextSentence(sentence);
    await expectCentred('spoken-sentence');
  }
  await page.click('#stop');
  for (let i = 0; i < 3; i++) await page.click('#zoom-in');

  // The same in the reading view.
  await page.click('#toggle-reading');
  await expect(page.locator('#reading')).toBeVisible();
  await readFrom('Die linke Spalte');
  sentence = await nextSentence(null);
  await expectCentred('spoken-sentence');
  await page.mouse.move(500, 400);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 200);
    sentence = await nextSentence(sentence);
    await expectCentred('spoken-sentence');
  }
  await page.click('#stop');
});

test('focus mode follows the line of the current word in a sentence taller than 60 % of the view', async () => {
  // Reading view: large, widely spaced text in a short window, so that a sentence fills the view.
  await page.fill('#reading-size', '40');
  await page.fill('#reading-lineHeight', '2.6');
  await windowHeight(480);
  await readFrom('Wissenschaftliche');
  const sentence = await nextSentence(null);
  const heights = await page.evaluate(() => {
    const boxes = [...CSS.highlights.get('spoken-sentence')!].map((r) =>
      (r as Range).getBoundingClientRect(),
    );
    const top = Math.min(...boxes.map((b) => b.top));
    const bottom = Math.max(...boxes.map((b) => b.bottom));
    return {
      sentence: bottom - top,
      view: document.querySelector('#reading')!.getBoundingClientRect().height,
    };
  });
  expect(heights.sentence).toBeGreaterThan(0.6 * heights.view);

  // As the words advance onto new lines, each such line is brought to the middle.
  const lines = new Set<number>();
  let word: string | null = null;
  const deadline = Date.now() + 90_000;
  while (lines.size < 3 && Date.now() < deadline) {
    const now = await highlighted('spoken-word');
    if (now === null || now === word || (await highlighted('spoken-sentence')) !== sentence) {
      await page.waitForTimeout(40);
      continue;
    }
    word = now;
    await page.click('#play');
    // A word can still arrive while the audio stops; it is centred too, so measure once it is quiet.
    await page.waitForTimeout(300);
    await expectCentred('spoken-word');
    const top = await page.evaluate(() => {
      const [range] = [...CSS.highlights.get('spoken-word')!] as Range[];
      return Math.round(range!.getBoundingClientRect().top + document.querySelector('#reading')!.scrollTop);
    });
    lines.add(top);
    await page.click('#play');
  }
  expect(lines.size).toBe(3);
  await page.click('#stop');
  await page.fill('#reading-size', '28');
  await page.fill('#reading-lineHeight', '1.7');

  // PDF view: zoom until the same sentence is tall there too.
  await page.click('#toggle-reading');
  await expect(page.locator('#viewer-container')).toBeVisible();
  for (let i = 0; i < 12; i++) await ctrlKey('plus');
  await readFrom('Wissenschaftliche');
  const pdfSentence = await nextSentence(null);
  const pdfHeights = await page.evaluate(() => {
    const boxes = [...CSS.highlights.get('spoken-sentence')!].map((r) =>
      (r as Range).getBoundingClientRect(),
    );
    return {
      sentence: Math.max(...boxes.map((b) => b.bottom)) - Math.min(...boxes.map((b) => b.top)),
      view: document.querySelector('#scroller')!.getBoundingClientRect().height,
    };
  });
  expect(pdfHeights.sentence).toBeGreaterThan(0.6 * pdfHeights.view);
  const pdfLines = new Set<number>();
  word = null;
  const pdfDeadline = Date.now() + 90_000;
  while (pdfLines.size < 3 && Date.now() < pdfDeadline) {
    const now = await highlighted('spoken-word');
    if (now === null || now === word || (await highlighted('spoken-sentence')) !== pdfSentence) {
      await page.waitForTimeout(40);
      continue;
    }
    word = now;
    await page.click('#play');
    // A word can still arrive while the audio stops; it is centred too, so measure once it is quiet.
    await page.waitForTimeout(300);
    await expectCentred('spoken-word');
    const top = await page.evaluate(() => {
      const [range] = [...CSS.highlights.get('spoken-word')!] as Range[];
      return Math.round(range!.getBoundingClientRect().top + document.querySelector('#scroller')!.scrollTop);
    });
    pdfLines.add(top);
    await page.click('#play');
  }
  expect(pdfLines.size).toBe(3);
  await page.click('#stop');
  for (let i = 0; i < 12; i++) await ctrlKey('minus');
  await windowHeight(950);
});

interface Launched {
  app: ElectronApplication;
  page: Page;
}

/** Starts another copy of the app on the same profile and file as an earlier one. */
async function launchOn(dir: string, file: string): Promise<Launched> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const second = await electron.launch({
    args: ['.', file, '--mute-audio'],
    env: env as Record<string, string>,
  });
  const window = await second.firstWindow();
  window.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  return { app: second, page: window };
}

/** Runs `body` with the helpers above pointed at another app window, then puts them back. */
async function using<T>(other: Launched, body: () => Promise<T>): Promise<T> {
  const saved = { app, page, input };
  [app, page, input] = [other.app, other.page, undefined];
  try {
    return await body();
  } finally {
    [app, page, input] = [saved.app, saved.page, saved.input];
  }
}

test('reopens a document where it was left: view, zoom, place and the sentence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfreader-progress-'));
  const file = join(dir, 'sample.pdf');
  copyFileSync(fixture, file);
  const progressFile = join(dir, 'profile', 'progress.json');
  const stored = (): Record<string, unknown> | undefined => {
    try {
      const { documents } = JSON.parse(readFileSync(progressFile, 'utf8')) as { documents: object };
      return Object.values(documents)[0] as Record<string, unknown>;
    } catch {
      // Not written yet, or being written.
      return undefined;
    }
  };
  const sentenceIndex = (): number | undefined => (stored()?.sentence as { index: number } | null)?.index;

  // First run: zoom in, read two sentences on page 2, scroll a little, and close at once.
  const run1 = await launchOn(dir, file);
  const left = await using(run1, async () => {
    await expect(page.locator('#title')).toHaveText('sample.pdf');
    await expect(page.locator('#page-info')).toHaveText('1 / 2');
    for (let i = 0; i < 3; i++) await ctrlKey('plus');
    await readFrom('Die linke Spalte');
    const one = await nextSentence(null);
    await expect.poll(sentenceIndex, { timeout: 5000 }).toBeDefined();
    const first = sentenceIndex()!;
    const two = await nextSentence(one);
    await page.click('#stop');
    // The place of the second sentence has reached the file (within about a second).
    await expect.poll(sentenceIndex, { timeout: 5000 }).toBeGreaterThan(first);
    await page.evaluate(() => document.querySelector('#scroller')!.scrollBy(0, 180));
    await page.waitForTimeout(400);

    // However often it changes, the file is written at most about once a second.
    const writes = new Set<number>();
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => document.querySelector('#scroller')!.scrollBy(0, 7));
      await page.waitForTimeout(200);
      writes.add(statSync(progressFile).mtimeMs);
    }
    expect(writes.size).toBeGreaterThanOrEqual(2);
    expect(writes.size).toBeLessThanOrEqual(4);

    // The last change comes within a second of a write, so only closing the window can save it.
    await page.evaluate(() => document.querySelector('#scroller')!.scrollBy(0, 137));
    await page.waitForTimeout(350);
    return {
      sentence: two,
      pageInfo: await page.locator('#page-info').textContent(),
      width: await pageWidth(),
      top: await scrollTop(),
    };
  });
  await run1.app.close();
  expect(stored()).toMatchObject({ view: 'pdf', page: 2, sentence: { page: 2 } });
  expect(left.pageInfo).toBe('2 / 2');

  // Second run: same view, zoom and place, and Play goes on from the sentence the voice was in.
  const run2 = await launchOn(dir, file);
  const second = await using(run2, async () => {
    await expect(page.locator('#viewer-container')).toBeVisible();
    await expect(page.locator('#page-info')).toHaveText(left.pageInfo!);
    await expect.poll(async () => Math.abs((await pageWidth()) - left.width)).toBeLessThan(3);
    await expect
      .poll(async () => Math.abs((await scrollTop()) - left.top), { timeout: 8000 })
      .toBeLessThan(6);
    await page.click('#play');
    expect(await nextSentence(null)).toBe(left.sentence);
    await page.click('#stop');
    // Leave in the reading view, scrolled.
    await page.click('#toggle-reading');
    await expect(page.locator('#reading')).toBeVisible();
    await expect(page.locator('#reading-text section')).toHaveCount(2);
    await page.evaluate(() => document.querySelector('#reading')!.scrollTo(0, 260));
    await page.waitForTimeout(500);
    return { top: await scrollTop() };
  });
  await run2.app.close();
  expect(stored()).toMatchObject({ view: 'reading' });

  // Third run: the reading view, at the same place, and the PDF's zoom is still there behind it.
  const run3 = await launchOn(dir, file);
  await using(run3, async () => {
    await expect(page.locator('#reading')).toBeVisible();
    await expect(page.locator('#viewer-container')).toBeHidden();
    await expect
      .poll(async () => Math.abs((await scrollTop()) - second.top), { timeout: 8000 })
      .toBeLessThan(6);
    await page.click('#toggle-reading');
    await expect(page.locator('#viewer-container')).toBeVisible();
    await expect.poll(async () => Math.abs((await pageWidth()) - left.width)).toBeLessThan(3);
  });
  await run3.app.close();
});
