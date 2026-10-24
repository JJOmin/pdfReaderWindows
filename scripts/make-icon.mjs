// Renders build/<name>.svg to build/<name>.png at 1024 px, the size electron-builder turns into the
// Mac's .icns (icon) and Windows' .ico (icon-win). Run with: npm run icon
// One icon per run: a second capture in the same run never finished.
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'build');
const name = process.argv[2] ?? 'icon';
const svg = readFileSync(join(dir, `${name}.svg`), 'utf8').replace(
  '<svg ',
  '<svg width="1024" height="1024" ',
);
const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;

// Electron holds back "ready" until this module has loaded, so a top-level await on it never returns.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const image = await window.webContents.capturePage();
  writeFileSync(join(dir, `${name}.png`), image.resize({ width: 1024, height: 1024 }).toPNG());
  console.log(`Wrote ${join(dir, `${name}.png`)}`);
  app.quit();
});
