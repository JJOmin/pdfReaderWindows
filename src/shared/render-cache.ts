import type { SynthRequest, VoiceRef } from './types.ts';

/**
 * The GPU voice's `VoiceRef.model`. It is not in models.json: it is a Python environment next to
 * the models, set up by `npm run gpu-voice`, not an archive to unpack.
 */
export const XTTS_MODEL = 'xtts';

/** A voice that is rendered into a cache ahead of time, as opposed to one spoken on demand. */
export const isRenderedVoice = (voice: VoiceRef): boolean => voice.model === XTTS_MODEL;

/** Bump when the engine, the helper or its settings change what a request sounds like. */
export const RENDER_VERSION = 1;

/**
 * Names the sound a request produces: the same string means the same audio can be reused.
 * The words are left out on purpose, they only matter for timing, which is measured again.
 * Hashing is left to the caller, as this file has no Node APIs.
 */
export function requestKey({ voice, lang, speed, text }: SynthRequest): string {
  return JSON.stringify([RENDER_VERSION, voice.model, voice.sid, lang, speed.toFixed(2), text]);
}

export interface CachedFile {
  name: string;
  size: number;
  /** When the file was last used, in any unit. */
  mtime: number;
}

/** The files to delete so that the rest fits in `maxBytes`: least recently used first. */
export function selectEvictions(files: readonly CachedFile[], maxBytes: number): string[] {
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const evict: string[] = [];
  for (const file of [...files].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    evict.push(file.name);
    total -= file.size;
  }
  return evict;
}
