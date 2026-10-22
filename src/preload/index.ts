import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api, NotesFile, OpenedPdf } from '../shared/types';

// The renderer gets these calls and nothing else: no file system, no arbitrary IPC.
const api: Api = {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  openInitial: () => ipcRenderer.invoke('pdf:initial'),
  // The path stays here: the renderer hands over the dropped file and never sees where it is.
  openDropped: (file) => ipcRenderer.invoke('pdf:open-path', webUtils.getPathForFile(file)),
  saveNotes: (notes) => ipcRenderer.invoke('notes:save', notes),
  exportMarkdown: (markdown) => ipcRenderer.invoke('notes:export', markdown),
  exportPdf: (marks, notes) => ipcRenderer.invoke('pdf:export', marks, notes),
  voices: () => ipcRenderer.invoke('tts:voices'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  saveProgress: (id, progress) => ipcRenderer.invoke('progress:save', id, progress),
  synthesize: (request) => ipcRenderer.invoke('tts:synthesize', request),
  prerender: (request) => ipcRenderer.invoke('tts:prerender', request),
  addPhoneAudio: (id, text, audio) => ipcRenderer.invoke('library:audio', id, text, audio),
  addPhonePage: (id, page, pages, sentences) =>
    ipcRenderer.invoke('library:page', id, page, pages, sentences),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncConnect: (backend, server) => ipcRenderer.invoke('sync:connect', backend, server),
  syncCancel: () => ipcRenderer.invoke('sync:cancel'),
  syncDisconnect: () => ipcRenderer.invoke('sync:disconnect'),
  syncKey: () => ipcRenderer.invoke('sync:key'),
  syncSetKey: (key) => ipcRenderer.invoke('sync:set-key', key),
  syncSetAuto: (on) => ipcRenderer.invoke('sync:set-auto', on),
  syncDocuments: () => ipcRenderer.invoke('sync:documents'),
  syncSetDocument: (docId, synced) => ipcRenderer.invoke('sync:set-document', docId, synced),
  syncRun: (full) => ipcRenderer.invoke('sync:run', full),
  phoneServer: () => ipcRenderer.invoke('phone:status'),
  phoneServerEnable: (on) => ipcRenderer.invoke('phone:enable', on),
  phoneRemove: (device) => ipcRenderer.invoke('phone:remove', device),
  phonePairing: (open) => ipcRenderer.invoke('phone:pairing', open),
  sendTargets: () => ipcRenderer.invoke('inbox:targets'),
  sendToPhone: (device) => ipcRenderer.invoke('inbox:send', device),
  onPhoneEvent: (listener) => {
    ipcRenderer.on('phone:pair', (_event, name: unknown) => {
      if (typeof name === 'string') listener({ kind: 'pair', name });
    });
    ipcRenderer.on('phone:changed', () => listener({ kind: 'changed' }));
  },
  phoneAnswer: (accept) => ipcRenderer.invoke('phone:answer', accept),
  onOpened: (listener) => {
    ipcRenderer.on('pdf:opened', (_event, opened: OpenedPdf) => listener(opened));
  },
  syncState: () => ipcRenderer.invoke('sync:state'),
  onSyncChanged: (listener) => {
    ipcRenderer.on('sync:changed', () => listener());
  },
  onNotesChanged: (listener) => {
    ipcRenderer.on('notes:changed', (_event, notes: unknown) => listener(notes as NotesFile));
  },
};

contextBridge.exposeInMainWorld('api', api);
