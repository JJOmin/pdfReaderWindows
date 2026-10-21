import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeviceState, parsePageIndex } from '../../src/shared/phone-library.ts';

// Step S6 of ADR 7: a place a phone wrote is offered when the document opens, and the desktop
// writes its own place where phones read it. Needs the fixture and the speech models.
const fixture = join(import.meta.dirname, '../fixtures/sample.pdf');
const PHONE = 'c'.repeat(32);

test.describe.configure({ mode: 'serial' });

let dir: string;
let pdf: string;
let app: ElectronApplication | undefined;
let page: Page;
const docId = createHash('sha256').update(readFileSync(fixture)).digest('hex');
const folder = (): string => join(dir, 'profile', 'phone-library', docId);

async function launch(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's extension host; would start Electron as plain Node
  app = await electron.launch({ args: ['.', pdf, '--mute-audio'], env: env as Record<string, string> });
  page = await app.firstWindow();
  await expect(page.locator('#page-info')).toHaveText(/ \/ 2$/u);
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pdfreader-place-'));
  pdf = join(dir, 'sample.pdf');
  copyFileSync(fixture, pdf);
  await launch();
  await page.click('#open-phone');
  await page.click('#phone-add');
  await expect(page.locator('#phone-progress')).toContainText('is ready', { timeout: 170_000 });
  await app!.close();
});

test.afterAll(async () => {
  await app?.close();
});

test('offers the phone’s newer place and continues at its sentence, found by key', async () => {
  const index = parsePageIndex(JSON.parse(readFileSync(join(folder(), 'pages', '2.json'), 'utf8')))!;
  mkdirSync(join(folder(), 'state'), { recursive: true });
  // The index is wrong on purpose: the key must win.
  const state = {
    device: PHONE,
    name: 'Galaxy S20 FE',
    updated: Date.now(),
    page: 2,
    offset: 0,
    sentence: { page: 2, index: 3, key: index.sentences[1]!.key },
  };
  writeFileSync(join(folder(), 'state', `${PHONE}.json`), JSON.stringify(state));

  await launch();
  await expect(page.locator('#place-offer')).toBeVisible();
  await expect(page.locator('#place-offer-text')).toHaveText(
    'Continue where you stopped on Galaxy S20 FE, page 2?',
  );
  await page.click('#place-continue');
  await expect(page.locator('#place-offer')).toBeHidden();
  await expect(page.locator('#page-info')).toHaveText('2 / 2');
  await page.click('#play');
  // The voice reads the sentence the phone stopped at, and keeps reading from there.
  await expect(page.locator('#status')).toContainText('Reading page 2', { timeout: 60_000 });
  await page.click('#stop');
});

test('writes this computer’s own place, and then offers nothing', async () => {
  const stateDir = join(folder(), 'state');
  const own = async (): Promise<ReturnType<typeof parseDeviceState>> => {
    const file = readdirSync(stateDir).find((f) => f !== `${PHONE}.json`);
    return file ? parseDeviceState(JSON.parse(readFileSync(join(stateDir, file), 'utf8'))) : null;
  };
  const index = parsePageIndex(JSON.parse(readFileSync(join(folder(), 'pages', '2.json'), 'utf8')))!;
  // Play started at the phone's sentence: the second of page 2, found by its key.
  await expect.poll(async () => (await own())?.sentence, { timeout: 10_000 }).toMatchObject({ page: 2 });
  const state = (await own())!;
  expect(state.page).toBe(2);
  expect(state.sentence!.index).toBeGreaterThanOrEqual(1);
  expect(index.sentences[state.sentence!.index]!.key).toBe(state.sentence!.key);
  expect(readdirSync(stateDir)).toContain(`${state.device}.json`);
  await app!.close();

  await launch();
  await expect(page.locator('#place-offer')).toBeHidden();
  expect(existsSync(join(stateDir, `${PHONE}.json`))).toBe(true);
});
