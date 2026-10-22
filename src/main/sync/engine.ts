import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseNotes } from '../../shared/notes';
import { mergeNotes } from '../../shared/notes-merge';
import {
  pagesToFetch,
  parseDeviceState,
  parseManifest,
  parsePageIndex,
  type Manifest,
} from '../../shared/phone-library';
import {
  changedParts,
  packAudio,
  parseJournal,
  remotePath,
  seal,
  unseal,
  type Journal,
  type JournalDoc,
  type JournalPart,
  type SyncStore,
} from '../../shared/sync-store';
import type { Inbox } from '../../shared/inbox';
import type { NotesFile, SyncReport } from '../../shared/types';

const DOC_ID = /^[0-9a-f]{64}$/;
const STATE_FILE = /^([0-9a-f]{32})\.json$/;
const JOURNAL_FILE = STATE_FILE;

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/**
 * What this computer remembers between syncs (kept by the manager in a file of its own): the
 * journals of the other devices as last processed, this computer's own journal so that a lost one
 * can be written again, and the hash of what it last exchanged for each document, so that a local
 * change is known without asking the store.
 */
export interface SyncMemo {
  seen: Record<string, { etag: string; journal: Journal }>;
  own: Record<string, JournalDoc>;
  synced: Record<string, { notes?: string; state?: string }>;
  /** The offers this computer's journal carries, as JSON: a change rewrites the journal. */
  offers: string;
}

export const newMemo = (): SyncMemo => ({ seen: {}, own: {}, synced: {}, offers: '{}' });

/** Reads the memo; anything damaged is forgotten, which only means the next sync walks everything. */
export function parseMemo(value: unknown): SyncMemo {
  const memo = newMemo();
  if (typeof value !== 'object' || value === null) return memo;
  const input = value as { seen?: unknown; own?: unknown; synced?: unknown };
  const record = (v: unknown): [string, unknown][] =>
    typeof v === 'object' && v !== null ? Object.entries(v) : [];
  for (const [device, raw] of record(input.seen)) {
    const entry = raw as { etag?: unknown; journal?: unknown } | null;
    const journal = parseJournal(entry?.journal);
    if (journal && journal.device === device) {
      memo.seen[device] = { etag: typeof entry?.etag === 'string' ? entry.etag : '', journal };
    }
  }
  memo.own = parseJournal({ device: 'f'.repeat(32), updated: 0, docs: input.own })?.docs ?? {};
  if (typeof (input as { offers?: unknown }).offers === 'string')
    memo.offers = (input as { offers: string }).offers;
  for (const [docId, raw] of record(input.synced)) {
    const entry = raw as { notes?: unknown; state?: unknown } | null;
    memo.synced[docId] = {
      ...(typeof entry?.notes === 'string' ? { notes: entry.notes } : {}),
      ...(typeof entry?.state === 'string' ? { state: entry.state } : {}),
    };
  }
  return memo;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** A file from the store, or null when there is none or this key cannot open it. */
async function fetchSealed(store: SyncStore, key: Uint8Array, path: string): Promise<Uint8Array | null> {
  const sealed = await store.get(path);
  if (!sealed) return null;
  try {
    return await unseal(key, path, sealed);
  } catch {
    return null;
  }
}

/**
 * Puts a document in the store: the PDF, the pages that have audio and the store lacks, each with its
 * index and packed audio, and the manifest last, so that a manifest in the store names only what is
 * there (ADR 11: pages are sent as they are rendered). Returns false when the store already holds this
 * very version.
 */
// shortcut: an upload that stops halfway sends its pages again. Upgrade when documents are large
// enough that this is seen, by listing what is there and sending only the rest.
async function uploadDocument(
  store: SyncStore,
  key: Uint8Array,
  folder: string,
  manifest: Manifest,
): Promise<boolean> {
  const put = async (path: string, bytes: Uint8Array): Promise<void> =>
    store.put(path, await seal(key, path, bytes));
  const { docId } = manifest;

  const there = await fetchSealed(store, key, remotePath.manifest(docId));
  let remote: Manifest | null;
  try {
    remote = there && parseManifest(JSON.parse(new TextDecoder().decode(there)));
  } catch {
    remote = null;
  }
  if (remote?.updated === manifest.updated) return false;

  // Its id is its hash: a PDF in the store is this PDF.
  if (!remote) await put(remotePath.pdf(docId), await readFile(join(folder, 'document.pdf')));
  for (const page of pagesToFetch(remote, manifest)) {
    const file = await readFile(join(folder, 'pages', `${page}.json`));
    const index = parsePageIndex(JSON.parse(file.toString('utf8')));
    if (!index) throw new Error(`The index of page ${page} is not valid`);
    const keys = [...new Set(index.sentences.map((s) => s.key))];
    const audio = await Promise.all(
      keys.map(async (k) => ({ key: k, bytes: await readFile(join(folder, 'audio', `${k}.opus`)) })),
    );
    await put(remotePath.pack(docId, page), packAudio(audio));
    await put(remotePath.page(docId, page), file);
  }
  await put(remotePath.manifest(docId), await readFile(join(folder, 'manifest.json')));
  return true;
}

/**
 * The hash of this computer's own place, or null when it has none. A change here is known from it
 * without asking the store.
 */
async function ownStateHash(folder: string, device: string): Promise<string | null> {
  try {
    return sha256(await readFile(join(folder, 'state', `${device}.json`)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Exchanges the places. This computer's own state goes up when `push` says so, and the other
 * devices' come down into `state/`, where the app reads them when `pull` says so. Each device
 * writes only its own file, so nothing is merged.
 * Returns how many files from another device could not be read.
 */
async function exchangeStates(
  store: SyncStore,
  key: Uint8Array,
  folder: string,
  docId: string,
  device: string,
  { push, pull }: { push: boolean; pull: boolean },
): Promise<number> {
  const local = join(folder, 'state');
  if (push) {
    try {
      const bytes = await readFile(join(local, `${device}.json`));
      const path = remotePath.state(docId, device);
      await store.put(path, await seal(key, path, bytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!pull) return 0;

  let unreadable = 0;
  for (const entry of await store.list(remotePath.states(docId))) {
    const match = STATE_FILE.exec(entry.name);
    if (!match || entry.folder || match[1] === device) continue;
    const path = remotePath.state(docId, match[1]!);
    const bytes = await fetchSealed(store, key, path);
    let state;
    try {
      state = bytes && parseDeviceState(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      state = null;
    }
    // A state belongs to the device whose name the file carries.
    if (!state || state.device !== match[1]) {
      unreadable++;
      continue;
    }
    await mkdir(local, { recursive: true });
    await writeFile(join(local, entry.name), JSON.stringify(state));
  }
  return unreadable;
}

/**
 * Exchanges a document's marks and comments: this side's and the store's are merged per mark (ADR 7
 * section 1), and whichever side lacks the result gets it. No logic runs in the store, so two
 * devices that write at the same moment can lose one update; the next sync merges again, since the
 * merge loses nothing that either side still holds.
 * `// shortcut: no revision check on the notes file. Upgrade if a lost update is ever seen.`
 * Returns how many files could not be read, and whether this side's notes changed.
 */
async function exchangeNotes(
  store: SyncStore,
  key: Uint8Array,
  folder: string,
  docId: string,
): Promise<{ unreadable: number; changed: boolean; sent: boolean; hash: string | null }> {
  const file = join(folder, 'notes.json');
  let local: NotesFile | null = null;
  try {
    local = parseNotes(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    // No notes here yet, or a file that is not ours.
  }
  const path = remotePath.notes(docId);
  const sealed = await store.get(path);
  let remote: NotesFile | null = null;
  if (sealed) {
    try {
      remote = parseNotes(JSON.parse(new TextDecoder().decode(await unseal(key, path, sealed))));
    } catch {
      // Another key, or a changed file: left as it is, and counted.
    }
    if (!remote) return { unreadable: 1, changed: false, sent: false, hash: null };
  }
  const merged = local && remote ? mergeNotes(local, remote) : (local ?? remote);
  if (!merged) return { unreadable: 0, changed: false, sent: false, hash: null };
  const text = JSON.stringify(merged, null, 2);
  let changed = false;
  if (!local || JSON.stringify(local, null, 2) !== text) {
    await writeFile(file, text);
    changed = true;
  }
  const sent = !remote || JSON.stringify(remote, null, 2) !== text;
  if (sent) await store.put(path, await seal(key, path, new TextEncoder().encode(text)));
  return { unreadable: 0, changed, sent, hash: sha256(text) };
}

/** The hash `exchangeNotes` would record for the notes file here, or null when there is none. */
async function localNotesHash(folder: string): Promise<string | null> {
  try {
    const notes = parseNotes(JSON.parse(await readFile(join(folder, 'notes.json'), 'utf8')));
    return notes && sha256(JSON.stringify(notes, null, 2));
  } catch {
    return null;
  }
}

/**
 * Reads the other devices' journals and says which documents changed since this computer last
 * looked. One listing of `devices/` costs one request; only a journal whose ETag moved is opened.
 * `full` opens every journal and reports every document as changed.
 */
async function pollJournals(
  store: SyncStore,
  key: Uint8Array,
  device: string,
  memo: SyncMemo,
  full: boolean,
): Promise<{
  changed: Map<string, JournalPart[]>;
  opened: SyncMemo['seen'];
  own: Journal | null;
  unreadable: number;
}> {
  const changed = new Map<string, JournalPart[]>();
  const opened: SyncMemo['seen'] = {};
  let own: Journal | null = null;
  let unreadable = 0;
  for (const entry of await store.list(remotePath.journals)) {
    const match = JOURNAL_FILE.exec(entry.name);
    if (!match || entry.folder) continue;
    const id = match[1]!;
    // This computer's own journal is only read to repair it, in a full walk.
    if (id === device && !full) continue;
    const before = memo.seen[id];
    if (id !== device && !full && entry.etag && before?.etag === entry.etag) continue;
    const path = remotePath.journal(id);
    const bytes = await fetchSealed(store, key, path);
    let journal: Journal | null;
    try {
      journal = bytes && parseJournal(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      journal = null;
    }
    // A journal belongs to the device whose name the file carries.
    if (!journal || journal.device !== id) {
      unreadable++;
      continue;
    }
    if (id === device) {
      own = journal;
      continue;
    }
    opened[id] = { etag: entry.etag ?? '', journal };
    for (const [docId, parts] of changedParts(full ? null : (before?.journal ?? null), journal)) {
      changed.set(docId, [...new Set([...(changed.get(docId) ?? []), ...parts])]);
    }
  }
  return { changed, opened, own, unreadable };
}

export interface SyncOptions {
  /** What the last sync left; without it everything is walked. Changed in place. */
  memo?: SyncMemo;
  /** This computer's name as the journal shows it to the other devices. */
  name?: string;
  /** Walk the whole store instead of what the journals say changed ("Refresh everything"). */
  full?: boolean;
  /** "Send to phone": the offers to carry in this computer's journal, by phone. */
  offers?: Inbox;
  /** Documents the user stopped syncing: left out, and out of the journal. */
  stopped?: ReadonlySet<string>;
  /** Told which documents' notes changed here, so that one that is open can show them. */
  onNotesChanged?: (docId: string) => void;
}

/**
 * Brings the store and the phone library in `root` up to date with each other. A sync that has a
 * memo asks the store one question, which journals changed, and touches only the documents and
 * parts they name, plus whatever changed here. The first sync, one after the memo was lost and a
 * `full` one walk everything, which also repairs a journal that was lost.
 */
export async function syncLibrary(
  store: SyncStore,
  key: Uint8Array,
  root: string,
  device: string,
  {
    memo = newMemo(),
    name = '',
    full = false,
    stopped = new Set<string>(),
    offers = {},
    onNotesChanged = () => undefined,
  }: SyncOptions = {},
): Promise<SyncReport> {
  const report: SyncReport = { documents: 0, uploaded: 0, unreadable: 0 };
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return report;
  }
  // Nothing sent yet means nothing is known: walk everything once.
  const walk = full || Object.keys(memo.own).length === 0;
  const poll = await pollJournals(store, key, device, memo, walk);
  report.unreadable += poll.unreadable;
  // A memo lost while the store kept this computer's journal starts from that journal.
  if (Object.keys(memo.own).length === 0 && poll.own) memo.own = poll.own.docs;

  const own: Record<string, JournalDoc> = {};
  const nextSynced: SyncMemo['synced'] = {};
  let dirty = false;
  const stamp = (docId: string, part: JournalPart, at: number): void => {
    // Strictly later, since the readers compare for a difference.
    const was = memo.own[docId]?.[part] ?? -1;
    own[docId]![part] = Math.max(at, was + 1);
    dirty = true;
  };

  for (const docId of names.filter((n) => DOC_ID.test(n) && !stopped.has(n))) {
    const folder = join(root, docId);
    // No manifest means the document is still being prepared.
    let manifest: Manifest | null;
    try {
      manifest = parseManifest(await readJson(join(folder, 'manifest.json')));
    } catch {
      continue;
    }
    if (!manifest || manifest.docId !== docId) continue;
    report.documents++;
    own[docId] = { manifest: 0, notes: 0, state: 0, ...memo.own[docId] };
    const parts = poll.changed.get(docId) ?? [];
    const synced = (nextSynced[docId] = { ...memo.synced[docId] });

    if (
      (walk || own[docId].manifest !== manifest.updated) &&
      (await uploadDocument(store, key, folder, manifest))
    ) {
      report.uploaded++;
    }
    if (own[docId].manifest !== manifest.updated) {
      own[docId].manifest = manifest.updated;
      dirty = true;
    }

    const stateHash = await ownStateHash(folder, device);
    const stateChanged = stateHash !== null && stateHash !== synced.state;
    report.unreadable += await exchangeStates(store, key, folder, docId, device, {
      push: walk || stateChanged,
      pull: walk || parts.includes('state'),
    });
    if (stateChanged) {
      stamp(docId, 'state', Date.now());
      synced.state = stateHash;
    }

    const notesHash = await localNotesHash(folder);
    if (walk || parts.includes('notes') || (notesHash !== null && notesHash !== synced.notes)) {
      const notes = await exchangeNotes(store, key, folder, docId);
      report.unreadable += notes.unreadable;
      if (notes.changed) onNotesChanged(docId);
      if (notes.sent) stamp(docId, 'notes', Date.now());
      if (notes.hash) synced.notes = notes.hash;
    }
  }

  // Documents no longer in the library leave the journal too.
  if (Object.keys(own).length !== Object.keys(memo.own).length) dirty = true;
  // A journal the store lost, or that differs from ours, is written again by any full walk.
  if (
    walk &&
    (poll.own ? JSON.stringify(poll.own.docs) !== JSON.stringify(own) : Object.keys(own).length > 0)
  ) {
    dirty = true;
  }
  const offersJson = JSON.stringify(offers);
  if (offersJson !== memo.offers) dirty = true;
  if (walk && poll.own && JSON.stringify(poll.own.offers ?? {}) !== offersJson) dirty = true;
  // Last, so that nobody is told of a part that is not in the store yet, nor offered a document
  // that is not there.
  if (dirty) {
    const journal: Journal = {
      device,
      name,
      updated: Date.now(),
      docs: own,
      ...(Object.keys(offers).length > 0 ? { offers } : {}),
    };
    const path = remotePath.journal(device);
    await store.put(path, await seal(key, path, new TextEncoder().encode(JSON.stringify(journal))));
  }
  // Only now are the journals of the others read: a sync that failed above reads them again.
  memo.own = own;
  memo.synced = nextSynced;
  memo.offers = offersJson;
  Object.assign(memo.seen, poll.opened);
  return report;
}
