/**
 * What every sync backend shares (ADR 8): the store interface, the names of the files in it, the
 * audio pack, and the encryption that keeps the provider from reading anything.
 * Uses Web Crypto only, which Node and the browser both have, so this file needs no Node APIs.
 */
import { parseInbox, type Inbox } from './inbox.ts';

export interface RemoteEntry {
  name: string;
  folder: boolean;
  size: number;
  /** Changes whenever the file does, when the store says so (WebDAV's ETag). */
  etag?: string;
}

/**
 * A place that keeps files and knows nothing else: no logic runs on the other side. Paths are
 * relative to the app's own folder in the store and pass `assertPath`.
 */
export interface SyncStore {
  /** The direct children of a folder, or none when the folder does not exist. */
  list(dir: string): Promise<RemoteEntry[]>;
  /** The file's bytes, or null when there is no such file. */
  get(path: string): Promise<Uint8Array | null>;
  /** Writes the file, with its folders, replacing what was there. */
  put(path: string, bytes: Uint8Array): Promise<void>;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Paths are built from hashes and numbers; this stops anything else reaching a provider's API. */
export function assertPath(path: string): void {
  const segments = path.split('/');
  if (!segments.every((s) => SEGMENT.test(s) && !/^\.+$/u.test(s))) throw new Error(`Invalid path ${path}`);
}

/** Where a document's files lie in the store. They mirror the phone library of ADR 7 section 2. */
export const remotePath = {
  manifest: (docId: string): string => `${docId}/manifest.json`,
  pdf: (docId: string): string => `${docId}/document.pdf`,
  page: (docId: string, page: number): string => `${docId}/pages/${page}.json`,
  /** A page's audio, packed: a store should not be asked for a file per sentence. */
  pack: (docId: string, page: number): string => `${docId}/audio/${page}.pack`,
  states: (docId: string): string => `${docId}/state`,
  state: (docId: string, device: string): string => `${docId}/state/${device}.json`,
  /** The document's marks and comments, merged per mark (ADR 7 section 1). */
  notes: (docId: string): string => `${docId}/notes.json`,
  /** Where every device's change journal lies (ADR 10 section 2). */
  journals: 'devices',
  journal: (device: string): string => `devices/${device}.json`,
};

export const JOURNAL_PARTS = ['manifest', 'notes', 'state'] as const;
export type JournalPart = (typeof JOURNAL_PARTS)[number];

/** When each part of a document last changed on the device that wrote the journal. */
export type JournalDoc = Record<JournalPart, number>;

/**
 * One device's list of its latest changes, sealed in `devices/<device>.json`. Another device that
 * has read it before can tell from the difference which documents and parts to fetch. It is a
 * hint: a full walk of the store repairs whatever a lost journal missed.
 */
export interface Journal {
  device: string;
  name: string;
  updated: number;
  docs: Record<string, JournalDoc>;
  /** "Send to phone": what this device offers each phone, by the phone's id. Left out when empty. */
  offers?: Inbox;
}

const DEVICE_ID = /^[0-9a-f]{32}$/;
const DOC_ID = /^[0-9a-f]{64}$/;

const time = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Reads a journal; documents with a bad id or time are dropped, a bad device id makes it null. */
export function parseJournal(value: unknown): Journal | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  const updated = time(input.updated);
  if (typeof input.device !== 'string' || !DEVICE_ID.test(input.device) || updated === null) return null;
  const docs: Record<string, JournalDoc> = {};
  const entries = typeof input.docs === 'object' && input.docs !== null ? Object.entries(input.docs) : [];
  for (const [docId, raw] of entries) {
    const part = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const manifest = time(part.manifest);
    const notes = time(part.notes);
    const state = time(part.state);
    if (DOC_ID.test(docId) && manifest !== null && notes !== null && state !== null) {
      docs[docId] = { manifest, notes, state };
    }
  }
  const name = typeof input.name === 'string' && input.name.length <= 256 ? input.name : '';
  const offers = parseInbox(input.offers);
  return Object.keys(offers).length > 0
    ? { device: input.device, name, updated, docs, offers }
    : { device: input.device, name, updated, docs };
}

/**
 * The documents, and which of their parts, that differ between the journal as it was last read
 * and now. Times are compared for difference, not order, so a device with a wrong clock still
 * gets its changes noticed. Without an earlier journal everything in it is new.
 */
export function changedParts(seen: Journal | null, now: Journal): Map<string, JournalPart[]> {
  const changed = new Map<string, JournalPart[]>();
  for (const [docId, doc] of Object.entries(now.docs)) {
    const before = seen?.docs[docId];
    const parts = JOURNAL_PARTS.filter((part) => !before || before[part] !== doc[part]);
    if (parts.length > 0) changed.set(docId, parts);
  }
  return changed;
}

const KEY = /^[0-9a-f]{40}$/;

/**
 * A page's audio files in one: a 4-byte big-endian length, that many bytes of JSON
 * `[[key, byteLength], ...]`, then the files in that order. A page has a few hundred sentences.
 */
export function packAudio(files: readonly { key: string; bytes: Uint8Array }[]): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(files.map((f) => [f.key, f.bytes.length])));
  const out = new Uint8Array(4 + header.length + files.reduce((sum, f) => sum + f.bytes.length, 0));
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  let at = 4 + header.length;
  for (const { bytes } of files) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/** The files of a pack, or null when it is not one. */
export function unpackAudio(pack: Uint8Array): { key: string; bytes: Uint8Array }[] | null {
  if (pack.length < 4) return null;
  const headerLength = new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(0);
  if (4 + headerLength > pack.length) return null;
  let entries: unknown;
  try {
    entries = JSON.parse(new TextDecoder().decode(pack.subarray(4, 4 + headerLength)));
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  const files: { key: string; bytes: Uint8Array }[] = [];
  let at = 4 + headerLength;
  for (const entry of entries as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [key, length] = entry as unknown[];
    if (typeof key !== 'string' || !KEY.test(key)) return null;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || at + length > pack.length) {
      return null;
    }
    files.push({ key, bytes: pack.subarray(at, at + length) });
    at += length;
  }
  return at === pack.length ? files : null;
}

const MAGIC = new TextEncoder().encode('PRS1');
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Copies into a plain ArrayBuffer, which is what Web Crypto's types ask for. */
const plain = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const aesKey = (key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', plain(key), 'AES-GCM', false, [usage]);

export const newSyncKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(KEY_BYTES));

/**
 * Encrypts a file for the store: `PRS1`, a random IV, then AES-256-GCM. The path is signed into the
 * file, so the provider cannot hand one file back under another's name.
 */
export async function seal(key: Uint8Array, path: string, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(path) },
    await aesKey(key, 'encrypt'),
    plain(data),
  );
  const out = new Uint8Array(MAGIC.length + IV_BYTES + body.byteLength);
  out.set(MAGIC);
  out.set(iv, MAGIC.length);
  out.set(new Uint8Array(body), MAGIC.length + IV_BYTES);
  return out;
}

/** Decrypts a file from the store. Throws when the key is wrong, the path is another's or the file was changed. */
export async function unseal(key: Uint8Array, path: string, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < MAGIC.length + IV_BYTES || !MAGIC.every((b, i) => sealed[i] === b)) {
    throw new Error(`${path} is not a file of this app`);
  }
  const iv = sealed.slice(MAGIC.length, MAGIC.length + IV_BYTES);
  try {
    const body = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(path) },
      await aesKey(key, 'decrypt'),
      plain(sealed.subarray(MAGIC.length + IV_BYTES)),
    );
    return new Uint8Array(body);
  } catch {
    throw new Error(`${path} cannot be read: the sync key is wrong or the file was changed`);
  }
}

/** A key as the user sees it: 64 hex digits in groups of 8. */
export const formatSyncKey = (key: Uint8Array): string =>
  [...key]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{8})(?=.)/gu, '$1-');

/** Reads a key the user typed or pasted, or null when it is not one. */
export function parseSyncKey(text: string): Uint8Array | null {
  const hex = text.replace(/[\s-]/gu, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(hex)) return null;
  return Uint8Array.from(hex.match(/../gu)!, (pair) => parseInt(pair, 16));
}

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/u;

/**
 * Reads a server address the user typed. Passwords go over https; plain http is accepted only for
 * a machine on the user's own network, which is where a home server lives.
 */
export function parseServerUrl(text: string): URL | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === 'https:') return url;
  return url.protocol === 'http:' && PRIVATE_HOST.test(url.hostname) ? url : null;
}
