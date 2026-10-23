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

/** The origin of the app's own page, which `protocol.handle('app')` serves. */
const APP_ORIGIN = 'app://reader';

const originOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    // A user part or a look-alike host never makes the origin the app's.
    // Built by hand: Node calls the origin of a custom scheme such as app: "null".
    return parsed.username || parsed.password ? undefined : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
};

/**
 * Whether a page or frame is the app's own window. Every call from the renderer and every
 * permission it asks for is checked against this, so that a page that got into the window by any
 * means other than the app's own files has no power over the main process.
 */
export function isTrustedOrigin(url: string, devUrl?: string): boolean {
  const origin = originOf(url);
  return (
    origin !== undefined && (origin === APP_ORIGIN || (devUrl !== undefined && origin === originOf(devUrl)))
  );
}

/** The only thing the window may ask the system for: the microphone, to speak a comment. */
export function mayUseDevice(
  permission: string,
  url: string,
  mediaTypes?: readonly string[],
  devUrl?: string,
): boolean {
  return (
    permission === 'media' &&
    isTrustedOrigin(url, devUrl) &&
    mediaTypes !== undefined &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === 'audio')
  );
}
