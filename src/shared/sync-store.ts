/**
 * What every sync backend shares (ADR 8): the store interface, the names of the files in it, the
 * audio pack, and the encryption that keeps the provider from reading anything.
 * Uses Web Crypto only, which Node and the browser both have, so this file needs no Node APIs.
 */

export interface RemoteEntry {
  name: string;
  folder: boolean;
  size: number;
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
};

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
