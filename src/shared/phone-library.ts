import { MAX_REQUEST_TEXT } from './requests.ts';
import { LANGS, type Lang, type Utterance, type WordTiming } from './types.ts';

/**
 * The phone library of ADR 7: what the desktop prepares and a paired phone downloads. The phone
 * reads a page with the desktop's sentences when both engines find the same words on it, so the
 * words, not the sentences or raw offsets, are what the two sides compare.
 * Hashing is left to the caller, as this file has no Node APIs.
 */

export const LIBRARY_VERSION = 1;

const KEY = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;

/** The page's words in reading order, each NFKC. Hashed, joined by single spaces, into `wordsHash`. */
export const pageWords = (utterances: readonly Utterance[]): string[] =>
  utterances.flatMap((u) => u.words.map((w) => w.text.normalize('NFKC')));

/** Each sentence's first word, as an index into `pageWords`. */
export function sentenceStarts(utterances: readonly Utterance[]): number[] {
  let next = 0;
  return utterances.map((u) => {
    const from = next;
    next += u.words.length;
    return from;
  });
}

/** A sentence's text as the sync key hashes it: used on pages where the two engines' words differ. */
export const syncText = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

export interface LibrarySentence {
  /** The first 40 hex digits of the SHA-256 of `syncText`. Also names the audio file. */
  key: string;
  lang: Lang;
  /** Length of the audio. */
  ms: number;
  /** The sentence's first word in the page's words. */
  from: number;
  /** Start and end of each of its words, in milliseconds. */
  words: [number, number][];
}

export interface PageIndex {
  wordCount: number;
  wordsHash: string;
  sentences: LibrarySentence[];
}

export interface Manifest {
  version: typeof LIBRARY_VERSION;
  /** SHA-256 of the PDF's bytes. */
  docId: string;
  name: string;
  pages: number;
  sentences: number;
  bytes: number;
  updated: number;
}

/** Where one device stopped reading. Each device writes only its own. */
export interface DeviceState {
  device: string;
  name: string;
  updated: number;
  page: number;
  offset: number;
  sentence: { page: number; index: number; key: string } | null;
}

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null;
const integer = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const name = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

function parseTimings(value: unknown, ms: number): [number, number][] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  let previous = 0;
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [start, end] = pair as unknown[];
    if (!finite(start) || !finite(end) || start < previous || end < start || end > ms) return null;
    previous = end;
  }
  return value as [number, number][];
}

function parseSentence(value: unknown): LibrarySentence | null {
  const input = record(value);
  if (!input) return null;
  const { key, lang, ms, from } = input;
  if (typeof key !== 'string' || !KEY.test(key)) return null;
  if (!LANGS.includes(lang as Lang) || !finite(ms) || ms < 0 || !integer(from, 0)) return null;
  const words = parseTimings(input.words, ms);
  return words && { key, lang: lang as Lang, ms, from, words };
}

/**
 * Reads a page index, or null when it is not valid. The sentences must cover the page's words
 * exactly, in order, because the phone maps them onto its own words by index.
 */
export function parsePageIndex(value: unknown): PageIndex | null {
  const input = record(value);
  if (!input || !integer(input.wordCount, 0) || typeof input.wordsHash !== 'string') return null;
  if (!SHA256.test(input.wordsHash) || !Array.isArray(input.sentences)) return null;
  const sentences: LibrarySentence[] = [];
  let next = 0;
  for (const entry of input.sentences) {
    const sentence = parseSentence(entry);
    if (!sentence || sentence.from !== next) return null;
    next += sentence.words.length;
    sentences.push(sentence);
  }
  if (next !== input.wordCount) return null;
  return { wordCount: input.wordCount, wordsHash: input.wordsHash, sentences };
}

export function parseManifest(value: unknown): Manifest | null {
  const input = record(value);
  if (!input || input.version !== LIBRARY_VERSION) return null;
  const { docId, pages, sentences, bytes, updated } = input;
  if (typeof docId !== 'string' || !SHA256.test(docId) || !name(input.name, 255)) return null;
  if (!integer(pages, 1) || !integer(sentences, 0) || !integer(bytes, 0) || !finite(updated)) return null;
  return { version: LIBRARY_VERSION, docId, name: input.name, pages, sentences, bytes, updated };
}

/** A sentence the renderer prepared: its text and words, and its audio's length and word timings. */
export interface PreparedSentence {
  text: string;
  lang: Lang;
  /** The sentence's words, as `Utterance.words` holds them. */
  words: string[];
  ms: number;
  timings: [number, number][];
}

/** A page holds a few hundred sentences; this only stops a runaway message. */
const MAX_PAGE_SENTENCES = 5000;

/** Word timings in seconds to whole milliseconds, in order and inside the audio, as the index needs. */
export function libraryTimings(
  timings: readonly WordTiming[],
  seconds: number,
): { ms: number; timings: [number, number][] } {
  const ms = Math.round(seconds * 1000);
  const clamp = (value: number, min: number): number => Math.min(ms, Math.max(min, Math.round(value * 1000)));
  let previous = 0;
  return {
    ms,
    timings: timings.map(({ start, end }) => {
      const from = clamp(start, previous);
      previous = clamp(end, from);
      return [from, previous];
    }),
  };
}

/** Checks the sentences of a page that came from the renderer. Timings are checked by the index. */
export function parsePreparedPage(value: unknown): PreparedSentence[] | null {
  if (!Array.isArray(value) || value.length > MAX_PAGE_SENTENCES) return null;
  const out: PreparedSentence[] = [];
  for (const entry of value) {
    const input = record(entry);
    if (!input || !name(input.text, MAX_REQUEST_TEXT) || !LANGS.includes(input.lang as Lang)) return null;
    const { words, timings, ms } = input;
    if (!Array.isArray(words) || words.length === 0 || !words.every((w) => name(w, MAX_REQUEST_TEXT))) {
      return null;
    }
    if (!Array.isArray(timings) || timings.length !== words.length || !finite(ms)) return null;
    out.push({
      text: input.text,
      lang: input.lang as Lang,
      words: words as string[],
      ms,
      timings: timings as [number, number][],
    });
  }
  return out;
}

/** A sentence's sync key: names its audio file and finds it on a page whose words differ. */
export const syncKey = (text: string, sha256: (text: string) => string): string =>
  sha256(syncText(text)).slice(0, 40);

/** The index of a page from its prepared sentences, in order, or null if it would not be valid. */
export function buildPageIndex(
  sentences: readonly PreparedSentence[],
  sha256: (text: string) => string,
): PageIndex | null {
  const words = sentences.flatMap((s) => s.words.map((w) => w.normalize('NFKC')));
  let from = 0;
  const index = {
    wordCount: words.length,
    wordsHash: sha256(words.join(' ')),
    sentences: sentences.map(({ text, lang, words, ms, timings }) => {
      const sentence = { key: syncKey(text, sha256), lang, ms, from, words: timings };
      from += words.length;
      return sentence;
    }),
  };
  // The same checks the phone makes, so a library the desktop writes is one the phone accepts.
  return parsePageIndex(index);
}

/** Reads a device's state, as sent by a phone or read from disk, or null when it is not valid. */
export function parseDeviceState(value: unknown): DeviceState | null {
  const input = record(value);
  if (!input) return null;
  const { device, updated, page, offset } = input;
  if (typeof device !== 'string' || !DEVICE_ID.test(device) || !name(input.name, 64)) return null;
  if (!finite(updated) || !integer(page, 1)) return null;
  const sentence = record(input.sentence);
  const valid =
    sentence &&
    integer(sentence.page, 1) &&
    integer(sentence.index, 0) &&
    typeof sentence.key === 'string' &&
    KEY.test(sentence.key);
  return {
    device,
    name: input.name,
    updated,
    page,
    offset: finite(offset) ? Math.min(0.999, Math.max(0, offset)) : 0,
    sentence: valid
      ? { page: sentence.page as number, index: sentence.index as number, key: sentence.key as string }
      : null,
  };
}

/** The state to offer when a document opens: the newest, whichever device wrote it. */
// shortcut: compares the devices' clocks, upgrade if a wrong pick is ever seen.
export const newestState = (states: readonly DeviceState[]): DeviceState | undefined =>
  states.reduce<DeviceState | undefined>(
    (best, s) => (!best || s.updated > best.updated ? s : best),
    undefined,
  );
