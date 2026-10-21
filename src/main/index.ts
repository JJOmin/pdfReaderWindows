import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, shell } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNotes } from '../shared/notes';
import { parseSynthRequest } from '../shared/requests';
import {
  normalizeProgress,
  normalizeSettings,
  parseProgressStore,
  rememberProgress,
  type ProgressStore,
} from '../shared/settings';
import type { NotesFile, OpenedPdf, Settings, SynthRequest } from '../shared/types';
import { annotate, parseMarks } from './annotate';
import { PhoneLibrary, sha256, type LibraryDocument } from './library';
import { resourcePaths } from './resources';
import { SyncManager } from './sync/manager';
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
const { modelsDir, helperScript } = resourcePaths({
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  modelsOverride: process.env.PDFREADER_MODELS,
});
const tts = new Tts(modelsDir, {
  cacheDir: join(app.getPath('userData'), 'voice-cache'),
  helperScript,
});

/** The PDF the window shows. Notes are only ever written next to this file. */
let currentPdf: string | undefined;
/** The same PDF as the phone library names it, by the hash of the bytes that were opened. */
let currentDoc: LibraryDocument | undefined;
const libraryRoot = join(app.getPath('userData'), 'phone-library');
const library = new PhoneLibrary(libraryRoot);
const sync = new SyncManager({
  configPath: join(app.getPath('userData'), 'sync.json'),
  libraryRoot,
  box: {
    encrypt: (text) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('This system cannot keep secrets safely');
      return safeStorage.encryptString(text).toString('base64');
    },
    decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
  },
  // Only addresses the sync code built itself are opened, and only as web pages.
  openUrl: (url) => {
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url);
  },
});
/** Names the current opening, so that a late message about the previous document is ignored. */
let currentId = 0;

const progressPath = (): string => join(app.getPath('userData'), 'progress.json');
const PROGRESS_WRITE_MS = 1000;
let progress: ProgressStore | undefined;
let progressDirty = false;
let progressWrittenAt = 0;
let progressTimer: ReturnType<typeof setTimeout> | undefined;

async function progressStore(): Promise<ProgressStore> {
  if (!progress) {
    try {
      progress = parseProgressStore(JSON.parse(await readFile(progressPath(), 'utf8')));
    } catch {
      // No file yet, or one that is not ours: nothing is remembered.
      progress = parseProgressStore(null);
    }
  }
  return progress;
}

/** Writes the progress file now. Used on close, when there is no time to wait. */
function writeProgress(): void {
  clearTimeout(progressTimer);
  progressTimer = undefined;
  if (!progress || !progressDirty) return;
  progressDirty = false;
  progressWrittenAt = Date.now();
  try {
    writeFileSync(progressPath(), JSON.stringify(progress));
  } catch {
    // Losing the place in a document is not worth interrupting the user for.
  }
}

/** Writes soon, but never twice within a second. */
function scheduleProgressWrite(): void {
  progressDirty = true;
  if (progressTimer) return;
  const wait = Math.max(0, progressWrittenAt + PROGRESS_WRITE_MS - Date.now());
  progressTimer = setTimeout(writeProgress, wait);
}

async function loadPdf(path: string): Promise<OpenedPdf> {
  const data = new Uint8Array(await readFile(path));
  let notes: NotesFile | null = null;
  try {
    notes = parseNotes(JSON.parse(await readFile(`${path}.notes.json`, 'utf8')));
  } catch {
    // No notes yet, or a file that is not ours: start empty.
  }
  const { documents } = await progressStore();
  currentPdf = path;
  currentDoc = { docId: sha256(data), name: basename(path), path };
  currentId += 1;
  return {
    id: currentId,
    name: basename(path),
    data,
    notes,
    progress: normalizeProgress(documents[resolve(path)]),
  };
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
  ipcMain.handle('progress:save', async (_event, id: unknown, value: unknown) => {
    const place = normalizeProgress(value);
    if (!currentPdf || id !== currentId || !place) return;
    rememberProgress(await progressStore(), resolve(currentPdf), place, Date.now());
    scheduleProgressWrite();
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
  ipcMain.handle('pdf:export', async (event, marks: unknown, notes: unknown) => {
    if (!currentPdf || typeof notes !== 'string') return null;
    // Always a new file: the original PDF is never modified.
    const { filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
      defaultPath: currentPdf.replace(/\.pdf$/iu, '') + '.annotated.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!filePath) return null;
    if (normalize(filePath) === normalize(currentPdf))
      throw new Error('Choose a different name than the open PDF');
    await writeFile(filePath, await annotate(await readFile(currentPdf), parseMarks(marks), notes));
    return filePath;
  });
  // Only for the document on screen: a late message from a previous one is refused.
  const libraryDoc = (id: unknown): LibraryDocument => {
    if (!currentDoc || id !== currentId) throw new Error('The document was closed');
    return currentDoc;
  };
  ipcMain.handle('library:audio', (_event, id: unknown, text: unknown, audio: unknown) =>
    library.addAudio(libraryDoc(id), text, audio),
  );
  ipcMain.handle('library:page', (_event, id: unknown, page: unknown, pages: unknown, sentences: unknown) =>
    library.addPage(libraryDoc(id), page, pages, sentences),
  );
  ipcMain.handle('sync:status', () => sync.getStatus());
  ipcMain.handle('sync:connect', (_event, backend: unknown, server: unknown) =>
    sync.connect(backend, server),
  );
  ipcMain.handle('sync:cancel', () => sync.cancel());
  ipcMain.handle('sync:disconnect', () => sync.disconnect());
  ipcMain.handle('sync:key', () => sync.key());
  ipcMain.handle('sync:set-key', (_event, key: unknown) => sync.setKey(key));
  ipcMain.handle('sync:run', () => sync.run());
  ipcMain.handle('tts:voices', () => tts.voices());
  // Whatever the renderer sends is checked here: it is a sandboxed page, not trusted code.
  const request = (value: unknown): SynthRequest => {
    const parsed = parseSynthRequest(value);
    if (!parsed) throw new Error('Invalid speech request');
    return parsed;
  };
  ipcMain.handle('tts:synthesize', (_event, value: unknown) => tts.synthesize(request(value)));
  ipcMain.handle('tts:prerender', (_event, value: unknown) => tts.prerender(request(value)));
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
  // The place in the document is written at most once a second, so the last change may still be waiting.
  window.on('close', writeProgress);
  window.once('ready-to-show', () => {
    // The document zooms on its own. The default menu's zoom items would scale the toolbar
    // too, by key and from the menu bar, so they are switched off.
    const zoomRoles = ['zoomin', 'zoomout', 'resetzoom'];
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      for (const item of top.submenu?.items ?? []) {
        if (item.role && zoomRoles.includes(item.role)) item.enabled = false;
      }
    }
    window.show();
  });
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
// The GPU voice's helper holds GPU memory until it is told to go.
app.on('will-quit', () => tts.close());
