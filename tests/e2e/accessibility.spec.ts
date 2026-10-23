import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// What a screen reader and a keyboard need from the window. Checks the page itself, so that a new
// button without a name, or a control too small to hit, is found by the test and not by a user.
// Needs no speech models.
test.describe.configure({ mode: 'serial' });

const fixture = join(import.meta.dirname, '..', 'fixtures', 'sample.pdf');
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfreader-a11y-'));
  const pdfPath = join(dir, 'sample.pdf');
  copyFileSync(fixture, pdfPath);
  writeFileSync(
    `${pdfPath}.notes.json`,
    JSON.stringify({
      version: 1,
      notes: '',
      annotations: [
        {
          id: 'one',
          page: 1,
          start: 0,
          end: 11,
          text: 'Dieser Text',
          quote: 'Dieser Text',
          kind: 'highlight',
          color: 'yellow',
          comment: 'Typed by hand.',
          created: '2026-10-23T09:00:00.000Z',
        },
      ],
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  // Set by VS Code's extension host; it would make Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', pdfPath, '--mute-audio'], env: env as Record<string, string> });
  page = await app.firstWindow();
  // The first launch on a cold machine loads the PDF engine: more than the default five seconds.
  await expect(page.locator('.textLayer span').first()).toBeAttached({ timeout: 30_000 });
  await page.evaluate(() => (document.querySelector<HTMLElement>('#sidebar')!.hidden = false));
  // A card open for changes shows every control it has.
  await page.click('#annotations li .edit');
});

test.afterAll(async () => {
  await app.close();
});

/** Every control that is on screen, with the name a screen reader would give it. */
const controls = () =>
  page.evaluate(() => {
    const name = (el: HTMLElement): string => {
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled) {
        return labelled
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
      }
      return (
        el.getAttribute('aria-label') ||
        (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
        el.getAttribute('title') ||
        el.textContent?.trim() ||
        el.getAttribute('placeholder') ||
        ''
      ).trim();
    };
    return [
      ...document.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, [role="button"]'),
    ]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && !el.closest('[hidden], dialog:not([open])');
      })
      .map((el) => {
        const box = el.getBoundingClientRect();
        return {
          what: `${el.tagName.toLowerCase()}#${el.id}.${el.className} ${name(el)}`.trim(),
          name: name(el),
          width: box.width,
          height: box.height,
          inSidebar: !!el.closest('#sidebar'),
        };
      });
  });

test('every control on screen has a name', async () => {
  const unnamed = (await controls()).filter((c) => c.name === '').map((c) => c.what);
  expect(unnamed).toEqual([]);
});

test('the controls in the notes are at least 24 by 24 pixels, as WCAG 2.2 asks', async () => {
  const small = (await controls())
    .filter((c) => c.inSidebar && (c.width < 24 || c.height < 24))
    // A text field is as wide as its sidebar; it is the height of one line at least.
    .map((c) => `${c.what}: ${c.width}x${c.height}`);
  expect(small).toEqual([]);
});

test('the page has a language, landmarks and a labelled sidebar', async () => {
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  for (const landmark of ['header', 'main', 'aside[aria-label]', 'footer']) {
    await expect(page.locator(landmark).first()).toBeAttached();
  }
});

test('every dialog is named by its heading', async () => {
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll('dialog')]
      .filter((d) => {
        const id = d.getAttribute('aria-labelledby');
        return !id || !document.getElementById(id)?.textContent?.trim();
      })
      .map((d) => d.id),
  );
  expect(unnamed).toEqual([]);
});

test('a control that is on or off says which, not by colour alone', async () => {
  const pressed = page.locator('#annotations li .tools [aria-pressed]');
  expect(await pressed.count()).toBeGreaterThan(0);
  for (const value of await pressed.evaluateAll((els) => els.map((e) => e.getAttribute('aria-pressed')))) {
    expect(['true', 'false']).toContain(value);
  }
  // A colour is named, so that it can be told apart without seeing it.
  await expect(page.locator('#annotations li [data-color="green"]')).toHaveAttribute('aria-label', 'Green');
});

test('the keyboard reaches the pencil and shows where it is', async () => {
  const edit = page.locator('#annotations li .edit');
  await page.locator('#notes').focus();
  // Tab until the pencil has the focus: it must be reachable, and in a sensible number of presses.
  let presses = 0;
  while (!(await edit.evaluate((el) => el === document.activeElement)) && presses < 30) {
    await page.keyboard.press('Tab');
    presses += 1;
  }
  expect(presses).toBeLessThan(30);
  expect(await edit.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  // Enter on the pencil closes the card.
  await page.keyboard.press('Enter');
  await expect(page.locator('#annotations li')).toHaveAttribute('data-editing', 'false');
});
