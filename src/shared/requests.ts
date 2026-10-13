import { MAX_SPEED, MIN_SPEED } from './settings.ts';
import { LANGS, type SynthRequest } from './types.ts';

/** A sentence is a few hundred characters; this only stops a runaway request. */
export const MAX_REQUEST_TEXT = 2000;
const MAX_WORDS = 1000;

/** Checks a speech request that came from the renderer. Returns a clean copy, or undefined. */
export function parseSynthRequest(value: unknown): SynthRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { text, words, lang, voice, speed } = value as Record<string, unknown>;
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_REQUEST_TEXT) return undefined;
  if (!Array.isArray(words) || words.length > MAX_WORDS || !words.every((w) => typeof w === 'string')) {
    return undefined;
  }
  if (!LANGS.includes(lang as SynthRequest['lang'])) return undefined;
  const ref = voice as Partial<SynthRequest['voice']> | null;
  if (typeof ref?.model !== 'string' || !Number.isInteger(ref.sid)) return undefined;
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return undefined;
  return {
    text,
    words: words as string[],
    lang: lang as SynthRequest['lang'],
    voice: { model: ref.model, sid: ref.sid! },
    speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)),
  };
}
