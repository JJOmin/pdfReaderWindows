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
};

contextBridge.exposeInMainWorld('api', api);
