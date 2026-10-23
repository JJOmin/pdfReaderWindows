import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// What the window is not allowed to do. Needs no speech models.
test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(mkdtempSync(join(tmpdir(), 'pdfreader-security-')), 'profile'),
  };
  // Set by VS Code's extension host; it would make Electron start as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', '--mute-audio'], env: env as Record<string, string> });
  page = await app.firstWindow();
  await expect(page.locator('#empty')).toBeVisible();
});

test.afterAll(async () => {
  await app.close();
});

test('the page is served with a policy that allows no embeds, forms or base address', async () => {
  const policy = await page.evaluate(async () =>
    (await fetch(location.href)).headers.get('content-security-policy'),
  );
  expect(policy).toContain("default-src 'self'");
  for (const directive of [
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    expect(policy).toContain(directive);
  }
});

test('the window never leaves the app, however it is asked to', async () => {
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toMatch(/^app:\/\/reader\//u);
});

test('the page may ask for the microphone and for nothing else', async () => {
  const answers = await page.evaluate(async () => ({
    notifications: await Notification.requestPermission(),
    geolocation: await new Promise<string>((resolve) =>
      navigator.geolocation.getCurrentPosition(
        () => resolve('granted'),
        (error) => resolve(error.code === error.PERMISSION_DENIED ? 'denied' : `error ${error.code}`),
      ),
    ),
  }));
  expect(answers).toEqual({ notifications: 'denied', geolocation: 'denied' });
});

test('the main process answers the app’s own page', async () => {
  // Through the page's own bridge: the origin check lets it in.
  const settings = await page.evaluate(() => window.api.getSettings());
  expect(settings).toHaveProperty('speed');
});
