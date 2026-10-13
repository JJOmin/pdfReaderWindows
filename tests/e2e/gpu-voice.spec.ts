import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Needs the fixture (npm run fixtures), the CPU speech models (npm run models) and the GPU voice
// (npm run gpu-voice -- --accept-licence). Without the GPU voice the test is skipped.
const root = join(import.meta.dirname, '../..');
const fixture = join(import.meta.dirname, '../fixtures/sample.pdf');
const python = join(
  root,
  'models/xtts-env',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const installed = existsSync(python) && existsSync(join(root, 'models/xtts-v2/model.pth'));

test.skip(!installed, 'The XTTS voice is not installed: npm run gpu-voice -- --accept-licence');
// Loading the model takes about 20 seconds, rendering the fixture about a minute.
test.setTimeout(600_000);

let app: ElectronApplication | undefined;
test.afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Starts the app on a throwaway profile and a copy of the fixture. */
async function launch(): Promise<{
  page: Page;
  cache: string;
  rendered: () => string[];
  errors: string[];
}> {
  const dir = mkdtempSync(join(tmpdir(), 'pdfreader-gpu-'));
  const pdf = join(dir, 'sample.pdf');
  copyFileSync(fixture, pdf);
  const cache = join(dir, 'profile', 'voice-cache');
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's extension host; would start Electron as plain Node
  app = await electron.launch({ args: ['.', pdf, '--mute-audio'], env: env as Record<string, string> });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await expect(page.locator('#title')).toHaveText('sample.pdf');
  const rendered = (): string[] =>
    existsSync(cache) ? readdirSync(cache).filter((n) => n.endsWith('.wav')) : [];
  return { page, cache, rendered, errors };
}

/** Chooses XTTS for every role in both languages, through the voices dialog. */
async function chooseXtts(page: Page): Promise<void> {
  await page.click('#open-voices');
  for (const lang of ['en', 'de']) {
    await page.selectOption(`#voice-${lang}-main`, 'xtts:0');
    await page.selectOption(`#voice-${lang}-quote`, '');
    await page.selectOption(`#voice-${lang}-heading`, '');
  }
  await page.keyboard.press('Escape');
}

const highlighted = (page: Page, name: string): Promise<string | null> =>
  page.evaluate((n) => {
    const highlight = CSS.highlights.get(n);
    return highlight ? [...highlight].map((range) => range.toString()).join('') : null;
  }, name);

/** Collects the spoken word highlight until `count` different words were seen. */
async function spokenWords(page: Page, count: number): Promise<string[]> {
  const words: string[] = [];
  await expect
    .poll(
      async () => {
        const word = await highlighted(page, 'spoken-word');
        if (word && words.at(-1) !== word) words.push(word);
        return words.length;
      },
      { timeout: 120_000, intervals: [40] },
    )
    .toBeGreaterThanOrEqual(count);
  return words;
}

test('renders the document with XTTS in the background while another voice reads, then plays it from the cache', async () => {
  const { page, cache, rendered, errors } = await launch();
  const button = page.locator('#prerender');
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Pre-render');

  // The voices dialog offers the GPU voice for both languages.
  await page.click('#open-voices');
  for (const lang of ['en', 'de']) {
    await expect(page.locator(`#voice-${lang}-main option[value="xtts:0"]`)).toHaveCount(1);
  }
  await page.keyboard.press('Escape');

  // Start rendering; the default CPU voices keep reading while it runs.
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.click('#play');
  const meanwhile = await spokenWords(page, 5);
  expect(meanwhile.slice(0, 3)).toEqual(['Vorlesen', 'wissenschaftlicher', 'Texte']);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.click('#stop');

  await expect(button).toHaveText('Rendered ✓', { timeout: 300_000 });
  const count = rendered().length;
  expect(count).toBeGreaterThan(5);
  // Real audio: a 16-bit mono WAV at the decoder's own 24 kHz, a second or more long.
  const clip = readFileSync(join(cache, rendered()[0]!));
  expect(clip.toString('ascii', 0, 4)).toBe('RIFF');
  expect(clip.readUInt32LE(24)).toBe(24000);
  expect(clip.length).toBeGreaterThan(24000 * 2);
  const renderedBy = Date.now();

  // Choose XTTS for everything and read from the top.
  await chooseXtts(page);
  await page.evaluate(() => document.querySelector('#scroller')!.scrollTo(0, 0));
  await page.click('#play');
  const words = await spokenWords(page, 8);
  expect(words.slice(0, 3)).toEqual(['Vorlesen', 'wissenschaftlicher', 'Texte']);
  expect(await highlighted(page, 'spoken-sentence')).toContain('Dieser Text prüft');
  await page.click('#stop');

  // Everything was found in the cache: reading rendered nothing new, and the files it used were
  // touched (a hit refreshes the file's time, so that the cache evicts what is used least).
  expect(rendered().length).toBe(count);
  const used = rendered().filter((name) => statSync(join(cache, name)).mtimeMs >= renderedBy);
  expect(used.length).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('reads with XTTS without any pre-rendering, rendering each sentence as it is needed', async () => {
  const { page, rendered, errors } = await launch();
  await chooseXtts(page);
  expect(rendered()).toHaveLength(0);

  await page.click('#play');
  // A three-word heading, then an eleven-word sentence: twenty words is into the second sentence,
  // so the voice has crossed a sentence boundary on rendering done as it went.
  const words = await spokenWords(page, 20);
  expect(words.slice(0, 3)).toEqual(['Vorlesen', 'wissenschaftlicher', 'Texte']);
  expect(await highlighted(page, 'spoken-sentence')).not.toContain('Dieser Text prüft');
  await page.click('#stop');

  // What was read, and the sentences prepared ahead of it, are in the cache now.
  expect(rendered().length).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});
