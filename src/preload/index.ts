import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/types';

// The renderer gets these calls and nothing else: no file system, no arbitrary IPC.
const api: Api = {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  openInitial: () => ipcRenderer.invoke('pdf:initial'),
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
  syncRun: () => ipcRenderer.invoke('sync:run'),
};

contextBridge.exposeInMainWorld('api', api);
