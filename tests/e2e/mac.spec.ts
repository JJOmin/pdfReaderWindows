import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// How a PDF reaches the app from outside its window, and the Mac's conventions (ADR 9 section 4).
test.describe.configure({ mode: 'serial' });

const fixture = join(import.meta.dirname, '..', 'fixtures', 'sample.pdf');
const mac = process.platform === 'darwin';
let app: ElectronApplication;
let page: Page;
let dir: string;

/** A copy of the fixture under another name, so the title shows which one is open. */
function copy(name: string): string {
  const path = join(dir, name);
  copyFileSync(fixture, path);
  return path;
}

/** What Finder does for Open With, a double click or a drop on the Dock icon. */
const openFromFinder = (path: string): Promise<void> =>
  app.evaluate(({ app }, file) => {
    app.emit('open-file', { preventDefault: () => undefined }, file);
  }, path);

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pdfreader-mac-'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  // Set by VS Code's extension host; it would make Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: ['.', copy('first.pdf'), '--mute-audio'],
    env: env as Record<string, string>,
  });
  page = await app.firstWindow();
  await expect(page.locator('#title')).toHaveText('first.pdf');
});

test.afterAll(async () => {
  await app.close();
});

test('a PDF opened from Finder replaces the one in the window', async () => {
  await openFromFinder(copy('second.pdf'));
  await expect(page.locator('#title')).toHaveText('second.pdf');
  await expect(page.locator('.textLayer span').first()).toBeAttached();
});

test('the Mac menu opens a PDF, and the shortcuts take Cmd', async () => {
  test.skip(!mac, 'Mac only');
  const third = copy('third.pdf');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [filePath] })) as never;
  }, third);
  const item = await app.evaluate(({ Menu }) => {
    const open = Menu.getApplicationMenu()!.getMenuItemById('open')!;
    open.click();
    return { label: open.label, accelerator: open.accelerator };
  });
  expect(item).toEqual({ label: 'Open…', accelerator: 'Cmd+O' });
  await expect(page.locator('#title')).toHaveText('third.pdf');

  await expect(page.locator('#open')).toHaveAttribute('title', 'Open a PDF (⌘O)');
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search (⌘F)');
  await page.locator('#scroller').click();
  await page.keyboard.press('Meta+f');
  await expect(page.locator('#search')).toBeFocused();
});

test('closing the window keeps the app, and a PDF from Finder opens a new one', async () => {
  test.skip(!mac, 'Mac only');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);

  const opened = app.waitForEvent('window');
  await openFromFinder(copy('fourth.pdf'));
  page = await opened;
  await expect(page.locator('#title')).toHaveText('fourth.pdf');

  // The Dock icon with no window opens an empty one; the command line's PDF is not opened again.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  const empty = app.waitForEvent('window');
  await app.evaluate(({ app }) => {
    app.emit('activate');
  });
  page = await empty;
  await expect(page.locator('#title')).toHaveText('No document');
});
