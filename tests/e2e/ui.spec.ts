import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The window at any size: nothing is cut off, what does not fit is in the "⋯" menu.
test.describe.configure({ mode: 'serial' });

const fixture = join(import.meta.dirname, '..', 'fixtures', 'sample.pdf');
let app: ElectronApplication;
let page: Page;

const resize = async (width: number, height = 700): Promise<void> => {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!),
    [width, height],
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
};

/** Every toolbar control that is shown lies inside the window. */
const cutOff = (): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#toolbar button, #toolbar input, #toolbar #title')]
      .filter((e) => e.offsetParent !== null && !e.closest('#more-menu'))
      .filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5)
      .map((e) => e.id || e.textContent!),
  );

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfreader-ui-'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  // Set by VS Code's extension host; it would make Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', '--mute-audio'], env: env as Record<string, string> });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
});

test('with no document the window offers to open one', async () => {
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty-open')).toBeVisible();
  const pdf = join(mkdtempSync(join(tmpdir(), 'pdfreader-ui-')), 'sample.pdf');
  copyFileSync(fixture, pdf);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [filePath] })) as never;
  }, pdf);
  await page.click('#empty-open');
  await expect(page.locator('#title')).toHaveText('sample.pdf');
  await expect(page.locator('#empty')).toBeHidden();
});

test('a wide window shows the whole toolbar, a narrow one moves the rest into the menu', async () => {
  await resize(1400);
  await expect(page.locator('#more')).toBeHidden();
  expect(await cutOff()).toEqual([]);

  await resize(600);
  await expect(page.locator('#more')).toBeVisible();
  expect(await cutOff()).toEqual([]);
  await expect(page.locator('#play')).toBeVisible();
  await expect(page.locator('#focus-mode')).toBeHidden();

  // From the menu a control works as before, and a button that is done closes the menu.
  await page.click('#more');
  await expect(page.locator('#more-menu #focus-mode')).toBeVisible();
  await page.click('#focus-mode');
  await expect(page.locator('#focus-mode')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#more-menu')).toBeHidden();
  await page.click('#more');
  await page.click('#focus-mode');
  await expect(page.locator('#focus-mode')).toHaveAttribute('aria-pressed', 'false');
  await page.click('#more');
  await page.keyboard.press('Escape');
  await expect(page.locator('#more-menu')).toBeHidden();

  // Back to wide: every item is in its place again.
  await resize(1400);
  await expect(page.locator('#more')).toBeHidden();
  await expect(page.locator('#toolbar > #focus-mode')).toBeVisible();
});

test('the page keeps the window width, and the notes lie over it in a narrow window', async () => {
  await resize(1400);
  const pageWidth = (): Promise<number> =>
    page.evaluate(() => document.querySelector('.page')!.getBoundingClientRect().width);
  const scroller = (): Promise<number> =>
    page.evaluate(() => document.querySelector('#scroller')!.clientWidth);
  const wide = await pageWidth();
  await resize(800);
  await expect.poll(pageWidth).toBeLessThan(wide);
  expect(await pageWidth()).toBeLessThanOrEqual(await scroller());

  // Narrow: the notes close, and opened again they do not squeeze the page.
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-pressed', 'false');
  const before = await scroller();
  await page.click('#toggle-sidebar');
  await expect(page.locator('#sidebar')).toBeVisible();
  expect(await scroller()).toBe(before);
  await page.click('#toggle-sidebar');
  await expect(page.locator('#sidebar')).toBeHidden();
});
