import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The cards in the sidebar: the icon for written or spoken, changing kind and colour afterwards,
// and speaking a comment on the desktop. The microphone is Chromium's fake one, which plays a
// sample of the recogniser's own German test recordings. Dictation needs the recogniser model.
test.describe.configure({ mode: 'serial' });

const root = join(import.meta.dirname, '..', '..');
const fixture = join(root, 'tests', 'fixtures', 'sample.pdf');
const model = join(
  root,
  'models',
  readdirSync(join(root, 'models')).find((d) => d.includes('nemo'))!,
);
let app: ElectronApplication;
let page: Page;
let notesPath: string;

const mark = (id: string, text: string, over: Record<string, unknown>) => ({
  id,
  page: 1,
  start: 0,
  end: text.length,
  text,
  quote: text,
  kind: 'highlight',
  color: 'yellow',
  comment: '',
  created: '2026-10-23T09:00:00.000Z',
  ...over,
});

const saved = (id: string) => {
  const file = JSON.parse(readFileSync(notesPath, 'utf8')) as { annotations: Record<string, unknown>[] };
  return file.annotations.find((a) => a.id === id)!;
};

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfreader-notes-edit-'));
  const pdfPath = join(dir, 'sample.pdf');
  notesPath = `${pdfPath}.notes.json`;
  copyFileSync(fixture, pdfPath);
  writeFileSync(
    notesPath,
    JSON.stringify({
      version: 1,
      notes: '',
      annotations: [
        mark('typed', 'Dieser Text', { comment: 'Typed by hand.' }),
        mark('spoken', 'Die Verarbeitung', { comment: 'Said aloud.', via: 'speech', color: 'blue' }),
        mark('bare', 'Sprachsynthese', {}),
      ],
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  // Set by VS Code's extension host; it would make Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [
      '.',
      pdfPath,
      '--mute-audio',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // The sandboxed audio service cannot read the sample file the fake microphone plays.
      '--no-sandbox',
      `--use-file-for-fake-audio-capture=${join(model, 'test_wavs', 'de-german.wav')}`,
    ],
    env: env as Record<string, string>,
  });
  page = await app.firstWindow();
  // The Mac would ask its user; the test must not wait for a dialog.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('dictation:access');
    ipcMain.handle('dictation:access', () => true);
  });
  // The first launch on a cold machine loads the PDF engine: more than the default five seconds.
  await expect(page.locator('.textLayer span').first()).toBeAttached({ timeout: 30_000 });
  await page.evaluate(() => (document.querySelector<HTMLElement>('#sidebar')!.hidden = false));
});

test.afterAll(async () => {
  await app.close();
});

const card = (id: string) => page.locator(`#annotations li[data-id="${id}"]`);

test('each card shows a note for a written comment, a microphone for a spoken one, nothing without', async () => {
  await expect(card('typed').locator('.how')).toHaveAttribute('data-how', 'note');
  await expect(card('typed').locator('.how svg')).toBeVisible();
  await expect(card('spoken').locator('.how')).toHaveAttribute('data-how', 'speech');
  await expect(card('spoken').locator('.how svg')).toBeVisible();
  await expect(card('bare').locator('.how svg')).toHaveCount(0);
});

test('a card only shows until its pencil opens it: no tools, no Delete, a comment that cannot be changed', async () => {
  const typed = card('typed');
  await expect(typed).toHaveAttribute('data-editing', 'false');
  await expect(typed.locator('textarea')).toHaveJSProperty('readOnly', true);
  await expect(typed.locator('.tools')).toBeHidden();
  await expect(typed.locator('[data-color]').first()).toBeHidden();
  await expect(typed.locator('.delete')).toBeHidden();
  // Typing into it does nothing.
  await typed.locator('textarea').click();
  await page.keyboard.type('x');
  await expect(typed.locator('textarea')).toHaveValue('Typed by hand.');

  await typed.locator('.edit').click();
  await expect(typed).toHaveAttribute('data-editing', 'true');
  await expect(typed.locator('textarea')).toHaveJSProperty('readOnly', false);
  await expect(typed.locator('.tools')).toBeVisible();
  await expect(typed.locator('.delete')).toBeVisible();
  // The check mark closes it again.
  await typed.locator('.edit').click();
  await expect(typed.locator('.tools')).toBeHidden();
  await expect(typed.locator('textarea')).toHaveJSProperty('readOnly', true);
});

test('the icon on a card follows the comment as it is typed', async () => {
  await card('bare').locator('.edit').click();
  await card('bare').locator('textarea').fill('Now written.');
  await expect(card('bare').locator('.how')).toHaveAttribute('data-how', 'note');
  await card('bare').locator('textarea').fill('');
  await expect(card('bare').locator('.how svg')).toHaveCount(0);
});

test('changes the colour of a mark: on the card, on the text and in the file', async () => {
  await card('typed').locator('.edit').click();
  await card('typed').locator('[data-color="green"]').click();
  await expect(card('typed')).toHaveAttribute('data-color', 'green');
  await expect(card('typed').locator('[data-color="green"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card('typed').locator('[data-color="yellow"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.mark-badge[data-id="typed"]')).toHaveAttribute('data-color', 'green');
  await expect.poll(() => saved('typed').color).toBe('green');
  // Nothing else about the mark changed.
  expect(saved('typed')).toMatchObject({ kind: 'highlight', comment: 'Typed by hand.' });
});

test('changes the kind of a mark and keeps what was typed in its comment', async () => {
  await card('typed').locator('textarea').focus();
  await card('typed').locator('[data-mark-kind="underline"]').click();
  await expect(card('typed')).toHaveAttribute('data-kind', 'underline');
  await expect(card('typed').locator('[data-mark-kind="underline"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => saved('typed').kind).toBe('underline');
  await expect(card('typed').locator('textarea')).toHaveValue('Typed by hand.');
  const painted = await page.evaluate(() => CSS.highlights.has('note-underline-green'));
  expect(painted).toBe(true);
});

test('a spoken comment is written out into the card and marked as spoken', async () => {
  const field = card('bare').locator('textarea');
  await card('bare').locator('.mic').click();
  await expect(card('bare').locator('.mic')).toHaveAttribute('aria-pressed', 'true');
  // The other microphones wait while this one listens.
  await expect(card('typed').locator('.mic')).toBeDisabled();
  await page.waitForTimeout(3500);
  await card('bare').locator('.mic').click();
  await expect(field).not.toHaveValue('', { timeout: 60_000 });
  await expect(card('bare').locator('.how')).toHaveAttribute('data-how', 'speech');
  await expect(page.locator('.mark-badge[data-id="bare"]')).toHaveAttribute('data-badge', 'speech');
  await expect.poll(() => saved('bare').via).toBe('speech');
  expect((saved('bare').comment as string).length).toBeGreaterThan(5);
});

test('the offer to continue is only as tall as its words', async () => {
  const sizes = await page.evaluate(() => {
    document.querySelector<HTMLElement>('#place-offer-text')!.textContent =
      'Continue where you stopped on Galaxy S20 FE, page 1?';
    document.querySelector<HTMLElement>('#place-offer')!.hidden = false;
    const height = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height;
    return { offer: height('#place-offer'), main: height('main'), status: height('#statusbar') };
  });
  expect(sizes.offer).toBeLessThan(60);
  expect(sizes.main).toBeGreaterThan(300);
  expect(sizes.status).toBeLessThan(60);
});
