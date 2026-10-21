import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest, parsePageIndex, type PageIndex } from '../../src/shared/phone-library.ts';

// Step S4 of ADR 7: "Add this document" prepares the fixture for the phone. Needs the fixture
// (npm run fixtures) and the recommended speech models (npm run models).
const fixture = join(import.meta.dirname, '../fixtures/sample.pdf');
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, '../golden/page-words-sample.json'), 'utf8'),
) as {
  pages: { page: number; wordCount: number; wordsHash: string }[];
};

let app: ElectronApplication | undefined;
let page: Page;
let dir: string;
const pageErrors: string[] = [];

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pdfreader-phone-'));
  copyFileSync(fixture, join(dir, 'sample.pdf'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's extension host; would start Electron as plain Node
  app = await electron.launch({
    args: ['.', join(dir, 'sample.pdf'), '--mute-audio'],
    env: env as Record<string, string>,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
});

test.afterAll(async () => {
  await app?.close();
});

/** In the window: an Ogg Opus file's length in milliseconds, by Chromium's own decoder. */
const decodedMs = (file: Buffer): Promise<number> =>
  page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer);
    return audio.duration * 1000;
  }, file.toString('base64'));

test('Add this document writes the phone library', async () => {
  await expect(page.locator('#page-info')).toHaveText('1 / 2');
  await page.click('#open-phone');
  await page.click('#phone-add');
  await expect(page.locator('#phone-cancel')).toBeVisible();
  await expect(page.locator('#phone-status')).toContainText('Added sample.pdf', { timeout: 170_000 });
  await expect(page.locator('#phone-add')).toBeEnabled();

  const pdf = readFileSync(fixture);
  const docId = createHash('sha256').update(pdf).digest('hex');
  const folder = join(dir, 'profile', 'phone-library', docId);
  expect(readFileSync(join(folder, 'document.pdf')).equals(pdf)).toBe(true);

  const manifest = parseManifest(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')));
  expect(manifest).toMatchObject({ docId, name: 'sample.pdf', pages: 2 });

  const indexes: PageIndex[] = [];
  for (const { page: n, wordCount, wordsHash } of golden.pages) {
    // Parsing checks that the sentences tile the words and every word lies within its audio.
    const index = parsePageIndex(JSON.parse(readFileSync(join(folder, 'pages', `${n}.json`), 'utf8')));
    expect(index, `page ${n}`).not.toBeNull();
    // The words the phone compares with its own, so the page is read with these sentences.
    expect(index).toMatchObject({ wordCount, wordsHash });
    indexes.push(index!);
  }
  const sentences = indexes.flatMap((i) => i.sentences);
  expect(manifest!.sentences).toBe(sentences.length);

  // One file per distinct sentence, and nothing else.
  const keys = new Set(sentences.map((s) => s.key));
  const audio = readdirSync(join(folder, 'audio'));
  expect(audio.sort()).toEqual([...keys].map((k) => `${k}.opus`).sort());

  for (const sentence of sentences) {
    for (const [start, end] of sentence.words) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(sentence.ms);
    }
  }
  // The index's length for each sentence is the length of the audio the phone will play.
  for (const key of keys) {
    const ms = sentences.find((s) => s.key === key)!.ms;
    expect(
      Math.abs((await decodedMs(readFileSync(join(folder, 'audio', `${key}.opus`)))) - ms),
      key,
    ).toBeLessThan(20);
  }
  console.log(
    `${sentences.length} sentences, ${keys.size} audio files, ` +
      `${(manifest!.bytes / 1024).toFixed(0)} KB in ${folder}`,
  );
  expect(pageErrors).toEqual([]);
});
