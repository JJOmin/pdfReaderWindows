import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emptyNotes, parseNotes } from '../shared/notes';
import { parseDictation } from '../shared/dictation';
import { stampChanges } from '../shared/notes-merge';
import { isTrustedOrigin, mayUseDevice, parseSynthRequest } from '../shared/requests';
import {
  normalizeProgress,
  normalizeSettings,
  parseProgressStore,
  rememberProgress,
  type ProgressStore,
} from '../shared/settings';
import { AutoSync } from '../shared/auto-sync';
import { addOffer, removeOffers } from '../shared/inbox';
import { InboxFile } from './inbox-file';
import { placeOffer, type DeviceState } from '../shared/phone-library';
import type { SyncFacts } from '../shared/sync-state';
import type {
  NotesFile,
  OpenedPdf,
  PlaceOffer,
  Settings,
  SendTarget,
  SyncedDocument,
  SyncReport,
  SynthRequest,
} from '../shared/types';
import { annotate, parseMarks } from './annotate';
import { PhoneLibrary, sha256, type LibraryDocument } from './library';
import { PhoneServer } from './phone-server';
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
  // Nothing in the window embeds, submits or re-bases anything.
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
/** The dev server's address, in development only; the packaged app has none. */
const devUrl = process.env.ELECTRON_RENDERER_URL;

// The computer's name, as phones list it. PDFREADER_DEVICE_NAME lets a test app be told from the real one.
const computerName = process.env.PDFREADER_DEVICE_NAME || hostname();
// PDFREADER_USER_DATA lets tests run against a throwaway profile.
if (process.env.PDFREADER_USER_DATA) app.setPath('userData', process.env.PDFREADER_USER_DATA);
// The installed app keeps its data where it always was, in the folder named for the app's old name,
// "PDF Reader" (ADR 9): the settings, the phone library and the paired phones stay when the product
// is renamed. A development run has its own folder, named for the package.
else if (app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'PDF Reader'));
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
/** Secrets for both kinds of sync, encrypted with what the operating system keeps for this user. */
const secretBox = {
  encrypt: (text: string): string => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system cannot keep secrets safely');
    return safeStorage.encryptString(text).toString('base64');
  },
  decrypt: (text: string): string => safeStorage.decryptString(Buffer.from(text, 'base64')),
};
const library = new PhoneLibrary(libraryRoot);
/** The store sync as the sync button shows it; the rest of its facts are read when asked. */
const storeSync = { busy: false, changedAt: 0, syncedAt: 0, failed: false };
/** Tells the window that the sync button may have to change. */
const syncChanged = (): void => BrowserWindow.getAllWindows()[0]?.webContents.send('sync:changed');
/** Something the store should get: new or changed marks, or a newly prepared document. */
const changedForStore = (): void => {
  storeSync.changedAt = Date.now();
  syncChanged();
  auto.changed('content');
};
/** "Send to phone" (ADR 10 section 6). */
const inbox = new InboxFile(join(app.getPath('userData'), 'inbox.json'));
/** Syncs with the store by itself (ADR 10 section 3); `sync` is made below, and used only later. */
const auto = new AutoSync({
  run: async () => {
    if (storeSync.busy || (await sync.getStatus()).backend === 'none') return;
    await runStoreSync(false);
  },
  now: Date.now,
});
const sync = new SyncManager({
  configPath: join(app.getPath('userData'), 'sync.json'),
  memoPath: join(app.getPath('userData'), 'sync-memo.json'),
  inbox,
  deviceName: hostname(),
  libraryRoot,
  box: secretBox,
  // The marks a sync brought for the open document are shown at once, as a phone's over Wi-Fi are.
  onNotesChanged: (docId) => {
    if (currentDoc?.docId !== docId || !currentPdf) return;
    void readNotesFile(currentPdf)
      .then((file) => mirrorNotes(currentDoc!, file))
      .then((merged) => {
        if (merged) BrowserWindow.getAllWindows()[0]?.webContents.send('notes:changed', merged);
      });
  },
  // Only addresses the sync code built itself are opened, and only as web pages.
  openUrl: (url) => {
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url);
  },
});
/** The answer to the "Pair with …?" the window is showing, if one is open. */
let pairAnswer: ((accept: boolean) => void) | undefined;
const phones = new PhoneServer({
  dir: app.getPath('userData'),
  libraryRoot,
  name: computerName,
  stopped: () => sync.stopped(),
  inbox: {
    offers: async (device) => (await inbox.load())[device] ?? [],
    handled: async (device, docId) => {
      await inbox.update((offers) => removeOffers(offers, device, [docId]));
      // The journal carries the offers too: a phone away from home must not see it again.
      changedForStore();
    },
  },
  box: secretBox,
  askPair: (name) =>
    new Promise((resolve) => {
      pairAnswer?.(false);
      pairAnswer = resolve;
      BrowserWindow.getAllWindows()[0]?.webContents.send('phone:pair', name);
    }),
  onChange: () => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('phone:changed');
    syncChanged();
  },
  // A phone's marks reach the open document at once; for another one they wait in the library
  // until it is opened.
  onNotes: (docId, merged) => {
    changedForStore();
    if (currentDoc?.docId !== docId || !currentPdf) return;
    void writeFile(`${currentPdf}.notes.json`, JSON.stringify(merged, null, 2));
    BrowserWindow.getAllWindows()[0]?.webContents.send('notes:changed', merged);
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
    if (pendingState) {
      mkdirSync(dirname(pendingState.path), { recursive: true });
      writeFileSync(pendingState.path, pendingState.json);
      pendingState = undefined;
    }
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

/** This computer's place in a prepared document, written with the progress file (step S6). */
let pendingState: { path: string; json: string } | undefined;

/** Another device's newer place in this document, with its sentence found here. */
async function offerFor(docId: string, ownUpdated: number | undefined): Promise<PlaceOffer | null> {
  if (!(await library.isPrepared(docId))) return null;
  const state = placeOffer(await library.states(docId), await sync.deviceId(), ownUpdated);
  if (!state) return null;
  const sentence = state.sentence && {
    page: state.sentence.page,
    index: await library.sentenceIndex(docId, state.sentence),
  };
  return { from: state.name, page: state.page, offset: state.offset, sentence };
}

const readNotesFile = async (pdfPath: string): Promise<NotesFile | null> => {
  try {
    return parseNotes(JSON.parse(await readFile(`${pdfPath}.notes.json`, 'utf8')));
  } catch {
    // No notes yet, or a file that is not ours: start empty.
    return null;
  }
};

/**
 * The notes of a prepared document are kept where phones read them as well as next to the PDF
 * (ADR 7 section 1): both are merged per mark, and the file next to the PDF is brought up to date.
 * Returns the notes the window should show.
 */
async function mirrorNotes(doc: LibraryDocument, fileNotes: NotesFile | null): Promise<NotesFile | null> {
  if (!(await library.isPrepared(doc.docId))) return fileNotes;
  const merged = await library.mergeNotesInto(doc.docId, fileNotes ?? emptyNotes());
  // Nothing to say, and nothing from a phone: an untouched document leaves no file behind.
  if (isBlank(merged)) return fileNotes;
  if (!fileNotes || JSON.stringify(fileNotes) !== JSON.stringify(merged)) {
    await writeFile(`${doc.path}.notes.json`, JSON.stringify(merged, null, 2));
  }
  return merged;
}

const isBlank = (notes: NotesFile): boolean =>
  notes.annotations.length === 0 && notes.notes === '' && !notes.removed;

async function loadPdf(path: string): Promise<OpenedPdf> {
  const data = new Uint8Array(await readFile(path));
  const notes = await readNotesFile(path);
  const { documents } = await progressStore();
  currentPdf = path;
  currentDoc = { docId: sha256(data), name: basename(path), path };
  currentId += 1;
  const saved = documents[resolve(path)];
  return {
    id: currentId,
    name: basename(path),
    data,
    notes: await mirrorNotes(currentDoc, notes),
    progress: normalizeProgress(saved),
    offer: await offerFor(currentDoc.docId, saved?.updated),
  };
}

/** A PDF from Finder or the File menu that waits for a window to ask for it. */
let pendingPath: string | undefined;
/** False from creating a window until its page asked for its first document. */
let windowReady = false;
/** The PDF named on the command line is opened by the first window only. */
let argvUsed = false;

/**
 * Opens a PDF that did not come from the window's own Open button: from Finder (`open-file`)
 * or the Mac's File menu. A window that is up shows it at once; otherwise it waits for one.
 */
function openFile(path: string): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window && windowReady) {
    void loadPdf(path).then((opened) => window.webContents.send('pdf:opened', opened));
    window.show();
    return;
  }
  pendingPath = path;
  if (!window && app.isReady()) createWindow();
}

async function chooseAndOpen(): Promise<void> {
  const window = BrowserWindow.getAllWindows()[0];
  const options = { properties: ['openFile' as const], filters: [{ name: 'PDF', extensions: ['pdf'] }] };
  const { filePaths } = await (window
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options));
  if (filePaths[0]) openFile(filePaths[0]);
}

/** One sync with the store, shown by the sync button. Used by the button and by the timer. */
async function runStoreSync(full: boolean): Promise<SyncReport> {
  const started = Date.now();
  storeSync.busy = true;
  syncChanged();
  try {
    const report = await sync.run(full);
    storeSync.syncedAt = started;
    storeSync.failed = false;
    return report;
  } catch (error) {
    storeSync.failed = true;
    throw error;
  } finally {
    storeSync.busy = false;
    syncChanged();
  }
}

/** The phones a document can be sent to: paired over Wi-Fi, or known from their journals in the store. */
async function sendTargets(): Promise<SendTarget[]> {
  const targets = new Map<string, SendTarget>();
  for (const { device, name } of await sync.devices()) targets.set(device, { device, name });
  for (const { device, name } of (await phones.status()).phones) targets.set(device, { device, name });
  return [...targets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The prepared documents, each with whether the user still syncs it. */
async function syncedDocuments(): Promise<SyncedDocument[]> {
  const stopped = new Set(await sync.stopped());
  return (await library.list()).map((d) => ({ ...d, synced: !stopped.has(d.docId) }));
}

function registerIpc(): void {
  // Every call must come from the app's own page: the window never navigates (will-navigate is
  // refused), so this holds unless something other than the app's files got into it.
  const handle: typeof ipcMain.handle = (channel, listener) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedOrigin(event.senderFrame?.url ?? '', devUrl)) throw new Error('Refused');
      return listener(event, ...args);
    });
  handle('pdf:open', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)!;
    const { filePaths } = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return filePaths[0] ? loadPdf(filePaths[0]) : null;
  });
  // The preload sends the path of a file dropped on the window; anything else is refused.
  handle('pdf:open-path', (_event, path: unknown) =>
    typeof path === 'string' && /\.pdf$/iu.test(path) && existsSync(path) ? loadPdf(path) : null,
  );
  handle('pdf:initial', () => {
    windowReady = true;
    const fromArgv = argvUsed
      ? undefined
      : process.argv.slice(1).find((arg) => /\.pdf$/iu.test(arg) && existsSync(arg));
    argvUsed = true;
    const path = pendingPath ?? fromArgv;
    pendingPath = undefined;
    return path ? loadPdf(path) : null;
  });
  handle('progress:save', async (_event, id: unknown, value: unknown) => {
    const place = normalizeProgress(value);
    if (!currentPdf || id !== currentId || !place) return;
    const now = Date.now();
    rememberProgress(await progressStore(), resolve(currentPdf), place, now);
    // A prepared document's place also goes where phones read it, under this computer's id.
    const doc = currentDoc;
    if (doc && (await library.isPrepared(doc.docId))) {
      const device = await sync.deviceId();
      const key =
        place.sentence && (await library.sentenceKey(doc.docId, place.sentence.page, place.sentence.index));
      const state: DeviceState = {
        device,
        name: computerName,
        updated: now,
        page: place.page,
        offset: place.offset,
        sentence: place.sentence && key ? { ...place.sentence, key } : null,
      };
      if (doc === currentDoc) {
        pendingState = { path: library.statePath(doc.docId, device), json: JSON.stringify(state) };
        auto.changed('place');
      }
    }
    scheduleProgressWrite();
  });
  handle('notes:save', async (_event, value: unknown) => {
    const notes = parseNotes(value);
    if (!currentPdf || !notes) throw new Error('No open PDF or invalid notes');
    // Changes are stamped here by comparing with what was stored, so that the sidebar needs no
    // knowledge of timestamps or removals (ADR 7 section 1).
    const stamped = stampChanges(await readNotesFile(currentPdf), notes, Date.now());
    await writeFile(`${currentPdf}.notes.json`, JSON.stringify(stamped, null, 2));
    if (currentDoc && (await library.isPrepared(currentDoc.docId))) {
      await library.mergeNotesInto(currentDoc.docId, stamped);
      changedForStore();
    }
  });
  handle('notes:export', async (_event, markdown: unknown) => {
    if (!currentPdf || typeof markdown !== 'string') return null;
    const path = `${currentPdf}.notes.md`;
    await writeFile(path, markdown);
    return path;
  });
  handle('pdf:export', async (event, marks: unknown, notes: unknown) => {
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
  handle('library:audio', (_event, id: unknown, text: unknown, audio: unknown) =>
    library.addAudio(libraryDoc(id), text, audio),
  );
  // An opened PDF is in the library at once, without audio, and synced from then on (ADR 11).
  handle('library:add', async (_event, id: unknown, pages: unknown) => {
    const doc = libraryDoc(id);
    const known = await library.isPrepared(doc.docId);
    const manifest = await library.add(doc, pages);
    if (!known) {
      // Marks made before are put where phones read them.
      const merged = await mirrorNotes(doc, await readNotesFile(doc.path));
      if (merged) BrowserWindow.getAllWindows()[0]?.webContents.send('notes:changed', merged);
      changedForStore();
    }
    return { voiced: manifest.voiced, voices: manifest.voices };
  });
  handle(
    'library:page',
    async (_event, id: unknown, page: unknown, pages: unknown, sentences: unknown, voices: unknown) => {
      await library.addPage(libraryDoc(id), page, pages, sentences, voices);
      // Each page goes to the phones as soon as it is written.
      changedForStore();
    },
  );
  handle('sync:status', () => sync.getStatus());
  handle('sync:state', async (): Promise<SyncFacts> => {
    const [status, lan] = await Promise.all([sync.getStatus(), phones.status()]);
    return {
      store: status.backend !== 'none',
      phones: lan.enabled && lan.phones.length > 0,
      busy: storeSync.busy,
      document: currentDoc !== undefined,
      prepared: currentDoc !== undefined && (await library.isPrepared(currentDoc.docId)),
      changedAt: storeSync.changedAt,
      syncedAt: storeSync.syncedAt,
      failed: storeSync.failed,
    };
  });
  handle('sync:connect', (_event, backend: unknown, server: unknown) =>
    sync.connect(backend, server).finally(syncChanged),
  );
  handle('sync:cancel', () => sync.cancel());
  handle('sync:disconnect', () => sync.disconnect().finally(syncChanged));
  handle('sync:key', () => sync.key());
  handle('sync:set-key', (_event, key: unknown) => sync.setKey(key));
  handle('sync:set-auto', async (_event, on: unknown) => {
    const status = await sync.setAuto(on);
    auto.setEnabled(status.auto);
    return status;
  });
  handle('sync:documents', () => syncedDocuments());
  handle('sync:set-document', async (_event, docId: unknown, synced: unknown) => {
    await sync.setStopped(docId, synced === false);
    return syncedDocuments();
  });
  handle('sync:run', (_event, full: unknown) => runStoreSync(full === true));
  handle('inbox:targets', () => sendTargets());
  handle('inbox:send', async (_event, device: unknown) => {
    const doc = currentDoc;
    const targets = await sendTargets();
    const target = targets.find((t) => t.device === device);
    if (!doc || !target) throw new Error('No document is open, or that phone is not known');
    const manifest = await library.manifest(doc.docId);
    if (!manifest) throw new Error('Prepare the document for the phone first');
    await inbox.update((offers) =>
      addOffer(offers, target.device, {
        docId: doc.docId,
        name: manifest.name,
        bytes: manifest.bytes,
        sent: Date.now(),
      }),
    );
    // A document that is sent is synced from then on.
    await sync.setStopped(doc.docId, false);
    changedForStore();
    return target.name;
  });
  handle('phone:status', () => phones.status());
  handle('phone:enable', (_event, on: unknown) => phones.setEnabled(on).finally(syncChanged));
  handle('phone:remove', (_event, device: unknown) => phones.remove(device).finally(syncChanged));
  handle('phone:pairing', (_event, open: unknown) => {
    phones.setPairing(open);
    // A question nobody can see any more is a no.
    if (open !== true) {
      pairAnswer?.(false);
      pairAnswer = undefined;
    }
  });
  handle('phone:answer', (_event, accept: unknown) => {
    pairAnswer?.(accept === true);
    pairAnswer = undefined;
  });
  handle('tts:voices', () => tts.voices());
  // Whatever the renderer sends is checked here: it is a sandboxed page, not trusted code.
  const request = (value: unknown): SynthRequest => {
    const parsed = parseSynthRequest(value);
    if (!parsed) throw new Error('Invalid speech request');
    return parsed;
  };
  handle('tts:synthesize', (_event, value: unknown) => tts.synthesize(request(value)));
  handle('tts:prerender', (_event, value: unknown) => tts.prerender(request(value)));
  // The Mac asks the user once; Windows has no such question for a desktop app.
  handle('dictation:access', () =>
    process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true,
  );
  handle('dictation:transcribe', (_event, value: unknown) => {
    const samples = parseDictation(value);
    if (!samples) throw new Error('Invalid recording');
    return tts.transcribe(samples);
  });
  handle('settings:get', async (): Promise<Settings> => {
    try {
      return normalizeSettings(JSON.parse(await readFile(settingsPath(), 'utf8')));
    } catch {
      return normalizeSettings(null);
    }
  });
  handle('settings:set', (_event, value: unknown) =>
    writeFile(settingsPath(), JSON.stringify(normalizeSettings(value), null, 2)),
  );
}

/**
 * The Mac's menu bar, which is always shown: the standard menus plus File, Open…. Windows keeps
 * Electron's default menu, hidden until Alt is pressed.
 */
function macMenu(): Menu {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { id: 'open', label: 'Open…', accelerator: 'Cmd+O', click: () => void chooseAndOpen() },
        {
          label: 'Send to Phone…',
          click: () => BrowserWindow.getAllWindows()[0]?.webContents.send('menu:send'),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}

function createWindow(): void {
  windowReady = false;
  const window = new BrowserWindow({
    width: 1400,
    height: 950,
    // Below this the toolbar's own row and a readable page no longer fit.
    minWidth: 480,
    minHeight: 360,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // Stated, though they are the defaults: the page is sandboxed, cut off from Node and from the
      // preload's world, and never runs or loads anything insecure.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  // The place in the document is written at most once a second, so the last change may still be waiting.
  window.on('close', writeProgress);
  // On the Mac the app outlives its window; nothing is shown, so nothing may be written for it.
  window.on('closed', () => {
    currentPdf = undefined;
    currentDoc = undefined;
  });
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
  void window.loadURL(devUrl ?? 'app://reader/index.html');
}

// A standard scheme gives the renderer a real origin, so fetch and module workers behave as on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

void app.whenReady().then(() => {
  // Electron allows every permission a page asks for unless told otherwise. The window may ask for
  // the microphone, to speak a comment, and for nothing else.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(
      mayUseDevice(
        permission,
        details.requestingUrl,
        (details as { mediaTypes?: string[] }).mediaTypes,
        devUrl,
      ),
    ),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) =>
    mayUseDevice(
      permission,
      origin,
      [(details as { mediaType?: string }).mediaType ?? ''].filter(Boolean),
      devUrl,
    ),
  );
  protocol.handle('app', async (request) => {
    const path = normalize(join(RENDERER_DIR, decodeURIComponent(new URL(request.url).pathname)));
    if (!path.startsWith(RENDERER_DIR + sep)) return new Response('Forbidden', { status: 403 });
    const file = await net.fetch(pathToFileURL(path).href);
    const headers = new Headers(file.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(file.body, { status: file.status, headers });
  });
  registerIpc();
  if (process.platform === 'darwin') Menu.setApplicationMenu(macMenu());
  createWindow();
  void phones.start();
  void sync.getStatus().then((status) => {
    auto.setEnabled(status.auto);
    auto.start();
  });
});

// A Mac app keeps running without a window (ADR 9): the Dock icon opens one again.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
});
// Finder's Open With, a double click and a drop on the Dock icon; it can come before the app is ready.
app.on('open-file', (event, path) => {
  event.preventDefault();
  openFile(path);
});
// Whatever the store has not got yet is sent before the app goes, but never for more than 8 seconds.
let flushedOnQuit = false;
app.on('before-quit', (event) => {
  if (flushedOnQuit) return;
  flushedOnQuit = true;
  event.preventDefault();
  writeProgress();
  void Promise.race([auto.flush(), new Promise((resolve) => setTimeout(resolve, 8000))]).finally(() =>
    app.quit(),
  );
});
// The GPU voice's helper holds GPU memory until it is told to go.
app.on('will-quit', () => {
  tts.close();
  phones.close();
});
