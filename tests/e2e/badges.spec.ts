import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The icon above a marked section that has a comment: a note for typed text, a microphone for a
// comment the phone wrote out from speech. Needs no speech models.
test.describe.configure({ mode: 'serial' });

const fixture = join(import.meta.dirname, '..', 'fixtures', 'sample.pdf');
let app: ElectronApplication;
let page: Page;

const mark = (id: string, text: string, over: Record<string, unknown>) => ({
  id,
  page: 1,
  // Found again by its text, so the offsets need not be exact.
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

/** A badge, and where the first line of its mark is, in client coordinates. */
const geometry = (id: string) =>
  page.evaluate((markId) => {
    const badge = document.querySelector<HTMLElement>(`.mark-badge[data-id="${markId}"]`);
    if (!badge) return null;
    const b = badge.getBoundingClientRect();
    // Every painted mark of the badge's colour; the badge belongs to the one whose text starts nearest.
    const ranges = [...(CSS.highlights.get(`note-highlight-${badge.dataset.color}`) ?? [])] as Range[];
    const lines = ranges
      .map((r) => r.getClientRects()[0]!)
      .sort(
        (x, y) =>
          Math.abs(x.left - b.left) +
          Math.abs(x.top - b.bottom) -
          (Math.abs(y.left - b.left) + Math.abs(y.top - b.bottom)),
      );
    const line = lines[0]!;
    return { badgeBottom: b.bottom, badgeLeft: b.left, lineTop: line.top, lineLeft: line.left };
  }, id);

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfreader-badges-'));
  const pdfPath = join(dir, 'sample.pdf');
  copyFileSync(fixture, pdfPath);
  writeFileSync(
    `${pdfPath}.notes.json`,
    JSON.stringify({
      version: 1,
      notes: '',
      annotations: [
        mark('typed', 'Dieser Text', { comment: 'Typed by hand.' }),
        mark('spoken', 'Die Verarbeitung', { comment: 'Said aloud.', via: 'speech', color: 'blue' }),
        mark('silent', 'Hauptstimme', { comment: '   ' }),
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
    args: ['.', pdfPath, '--mute-audio', '--force-device-scale-factor=1'],
    env: env as Record<string, string>,
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test('shows a note over a typed comment and a microphone over a spoken one, and nothing else', async () => {
  // The first launch on a cold machine loads the PDF engine: more than the default five seconds.
  await expect(page.locator('.textLayer span').first()).toBeAttached({ timeout: 30_000 });
  await expect(page.locator('.mark-badge')).toHaveCount(2);
  await expect(page.locator('.mark-badge[data-id="typed"]')).toHaveAttribute('data-badge', 'note');
  await expect(page.locator('.mark-badge[data-id="spoken"]')).toHaveAttribute('data-badge', 'speech');
  // A blank comment and a mark with none have no icon.
  await expect(page.locator('.mark-badge[data-id="silent"]')).toHaveCount(0);
  await expect(page.locator('.mark-badge[data-id="bare"]')).toHaveCount(0);
});

test('puts the icon above the first line of its text, at the start', async () => {
  for (const id of ['typed', 'spoken']) {
    const g = (await geometry(id))!;
    expect(g.badgeBottom, id).toBeLessThanOrEqual(g.lineTop + 4);
    expect(g.badgeBottom, id).toBeGreaterThan(g.lineTop - 24);
    expect(Math.abs(g.badgeLeft - g.lineLeft), id).toBeLessThan(2);
  }
});

test('moves with the text when the document scrolls', async () => {
  const before = (await geometry('typed'))!;
  await page.evaluate(() => (document.querySelector('#scroller')!.scrollTop += 30));
  const after = (await geometry('typed'))!;
  expect(after.lineTop).toBeLessThan(before.lineTop - 20);
  expect(after.badgeBottom - after.lineTop).toBeCloseTo(before.badgeBottom - before.lineTop, 0);
});

test('a click on the icon shows the comment in the sidebar', async () => {
  await page.click('.mark-badge[data-id="spoken"]');
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#annotations li.focused')).toHaveAttribute('data-id', 'spoken');
  await expect(page.locator('#annotations li.focused textarea')).toHaveValue('Said aloud.');
});

test('an icon comes with the first words typed into a comment and goes with the last', async () => {
  await page.click('#annotations li[data-id="bare"] .edit');
  const box = page.locator('#annotations li[data-id="bare"] textarea');
  await box.fill('Now it has one.');
  await expect(page.locator('.mark-badge[data-id="bare"]')).toHaveAttribute('data-badge', 'note');
  await box.fill('');
  await expect(page.locator('.mark-badge[data-id="bare"]')).toHaveCount(0);
});

test('the reading view shows them too', async () => {
  await page.click('#toggle-reading');
  await expect(page.locator('#reading')).toBeVisible();
  await expect(page.locator('#reading .mark-badge')).toHaveCount(2);
  await expect(page.locator('#reading .mark-badge[data-badge="speech"]')).toHaveCount(1);
  await expect(page.locator('#reading .mark-badge[data-badge="note"]')).toHaveCount(1);
  // Back in the pages, the reading view's badges are gone and the pages' are back.
  await page.click('#toggle-reading');
  await expect(page.locator('#scroller .mark-badge')).toHaveCount(2);
  await expect(page.locator('#reading .mark-badge')).toHaveCount(0);
});
