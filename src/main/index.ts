import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNotes } from '../shared/notes';
import { normalizeSettings } from '../shared/settings';
import type { NotesFile, OpenedPdf, Settings, SynthRequest } from '../shared/types';
import { Tts } from './tts';

const RENDERER_DIR = join(import.meta.dirname, '../renderer');
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
].join('; ');

// PDFREADER_USER_DATA lets tests run against a throwaway profile.
if (process.env.PDFREADER_USER_DATA) app.setPath('userData', process.env.PDFREADER_USER_DATA);
const settingsPath = (): string => join(app.getPath('userData'), 'settings.json');
const modelsDir =
  process.env.PDFREADER_MODELS ??
  (app.isPackaged ? join(app.getPath('userData'), 'models') : join(app.getAppPath(), 'models'));
const tts = new Tts(modelsDir);

/** The PDF the window shows. Notes are only ever written next to this file. */
let currentPdf: string | undefined;

async function loadPdf(path: string): Promise<OpenedPdf> {
  const data = new Uint8Array(await readFile(path));
  let notes: NotesFile | null = null;
  try {
    notes = parseNotes(JSON.parse(await readFile(`${path}.notes.json`, 'utf8')));
  } catch {
    // No notes yet, or a file that is not ours: start empty.
  }
  currentPdf = path;
  return { name: basename(path), data, notes };
}

function registerIpc(): void {
  ipcMain.handle('pdf:open', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)!;
    const { filePaths } = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return filePaths[0] ? loadPdf(filePaths[0]) : null;
  });
  ipcMain.handle('pdf:initial', () => {
    const path = process.argv.slice(1).find((arg) => /\.pdf$/iu.test(arg) && existsSync(arg));
    return path ? loadPdf(path) : null;
  });
  ipcMain.handle('notes:save', async (_event, value: unknown) => {
    const notes = parseNotes(value);
    if (!currentPdf || !notes) throw new Error('No open PDF or invalid notes');
    await writeFile(`${currentPdf}.notes.json`, JSON.stringify(notes, null, 2));
  });
  ipcMain.handle('notes:export', async (_event, markdown: unknown) => {
    if (!currentPdf || typeof markdown !== 'string') return null;
    const path = `${currentPdf}.notes.md`;
    await writeFile(path, markdown);
    return path;
  });
  ipcMain.handle('tts:voices', () => tts.voices());
  ipcMain.handle('tts:synthesize', (_event, request: SynthRequest) => tts.synthesize(request));
  ipcMain.handle('settings:get', async (): Promise<Settings> => {
    try {
      return normalizeSettings(JSON.parse(await readFile(settingsPath(), 'utf8')));
    } catch {
      return normalizeSettings(null);
    }
  });
  ipcMain.handle('settings:set', (_event, value: unknown) =>
    writeFile(settingsPath(), JSON.stringify(normalizeSettings(value), null, 2)),
  );
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 950,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  // Links inside a PDF open in the system browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/iu.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  void window.loadURL(process.env.ELECTRON_RENDERER_URL ?? 'app://reader/index.html');
}

// A standard scheme gives the renderer a real origin, so fetch and module workers behave as on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

void app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const path = normalize(join(RENDERER_DIR, decodeURIComponent(new URL(request.url).pathname)));
    if (!path.startsWith(RENDERER_DIR + sep)) return new Response('Forbidden', { status: 403 });
    const file = await net.fetch(pathToFileURL(path).href);
    const headers = new Headers(file.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(file.body, { status: file.status, headers });
  });
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
