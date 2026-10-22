import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newMemo, parseMemo, syncLibrary, type SyncMemo } from '../../src/main/sync/engine';
import type { Annotation, NotesFile } from '../../src/shared/types';
import {
  buildPageIndex,
  LIBRARY_VERSION,
  parsePageIndex,
  syncKey,
  type DeviceState,
  type PreparedSentence,
} from '../../src/shared/phone-library';
import {
  newSyncKey,
  parseJournal,
  remotePath,
  seal,
  unpackAudio,
  unseal,
  type Journal,
  type RemoteEntry,
  type SyncStore,
} from '../../src/shared/sync-store';

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

class MemoryStore implements SyncStore {
  readonly files = new Map<string, Uint8Array>();
  /** Like a WebDAV server's ETag: new whenever the file is written. */
  readonly etags = new Map<string, string>();
  puts: string[] = [];
  gets: string[] = [];
  lists: string[] = [];

  async list(dir: string): Promise<RemoteEntry[]> {
    this.lists.push(dir);
    const names = new Map<string, RemoteEntry>();
    for (const [path, bytes] of this.files) {
      if (!path.startsWith(`${dir}/`)) continue;
      const [first, ...rest] = path.slice(dir.length + 1).split('/');
      names.set(first!, {
        name: first!,
        folder: rest.length > 0,
        size: bytes.length,
        ...(rest.length === 0 ? { etag: this.etags.get(path) ?? '' } : {}),
      });
    }
    return [...names.values()];
  }
  async get(path: string): Promise<Uint8Array | null> {
    this.gets.push(path);
    return this.files.get(path) ?? null;
  }
  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.puts.push(path);
    this.files.set(path, bytes);
    this.etags.set(path, `"${this.puts.length}"`);
  }
  forget(): void {
    this.puts = [];
    this.gets = [];
    this.lists = [];
  }
}

const SENTENCES: PreparedSentence[] = [
  {
    text: 'One two.',
    lang: 'en',
    words: ['One', 'two'],
    ms: 1000,
    timings: [
      [0, 400],
      [400, 900],
    ],
  },
  {
    text: 'Three four five.',
    lang: 'en',
    words: ['Three', 'four', 'five'],
    ms: 1500,
    timings: [
      [0, 300],
      [300, 700],
      [700, 1400],
    ],
  },
];
/** Opus files are opaque here; any bytes will do. */
const audioOf = (text: string): Buffer => Buffer.from(`OggS fake audio for ${text}`);

let root: string;
let store: MemoryStore;
const key = newSyncKey();
const PDF = Buffer.from('%PDF-1.7 pretend');
const DOC = sha256(PDF);

/** A finished library folder with two pages that share one sentence, as the app writes it. */
async function makeDocument(updated: number): Promise<string> {
  const folder = join(root, DOC);
  await mkdir(join(folder, 'pages'), { recursive: true });
  await mkdir(join(folder, 'audio'), { recursive: true });
  await writeFile(join(folder, 'document.pdf'), PDF);
  for (const [page, sentences] of [
    [1, SENTENCES],
    [2, [SENTENCES[0]!]],
  ] as const) {
    await writeFile(join(folder, 'pages', `${page}.json`), JSON.stringify(buildPageIndex(sentences, sha256)));
  }
  for (const s of SENTENCES)
    await writeFile(join(folder, 'audio', `${syncKey(s.text, sha256)}.opus`), audioOf(s.text));
  await writeFile(
    join(folder, 'manifest.json'),
    JSON.stringify({
      version: LIBRARY_VERSION,
      voices: 'ab',
      docId: DOC,
      name: 'paper.pdf',
      pages: 2,
      sentences: 3,
      voiced: [1, 2],
      bytes: 100,
      updated,
    }),
  );
  return folder;
}

const DESKTOP = 'd'.repeat(32);
const PHONE = 'e'.repeat(32);
const stateOf = (device: string, page: number): DeviceState => ({
  device,
  name: 'Galaxy',
  updated: 5,
  page,
  offset: 0.2,
  sentence: null,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdfreader-sync-'));
  store = new MemoryStore();
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('syncLibrary', () => {
  it('sends the PDF, each page’s index and packed audio, and the manifest last', async () => {
    await makeDocument(1);
    const report = await syncLibrary(store, key, root, DESKTOP);
    expect(report).toEqual({ documents: 1, uploaded: 1, unreadable: 0 });
    expect(store.puts).toEqual([
      remotePath.pdf(DOC),
      remotePath.pack(DOC, 1),
      remotePath.page(DOC, 1),
      remotePath.pack(DOC, 2),
      remotePath.page(DOC, 2),
      remotePath.manifest(DOC),
      remotePath.journal(DESKTOP),
    ]);
  });

  it('stores only scrambled files, which the key opens to the library’s own bytes', async () => {
    await makeDocument(1);
    await syncLibrary(store, key, root, DESKTOP);
    for (const bytes of store.files.values()) {
      const text = Buffer.from(bytes).toString('latin1');
      expect(text).not.toContain('paper.pdf');
      expect(text).not.toContain('pretend');
    }
    const open = async (path: string): Promise<Uint8Array> => unseal(key, path, store.files.get(path)!);
    expect(Buffer.from(await open(remotePath.pdf(DOC)))).toEqual(PDF);

    const index = parsePageIndex(JSON.parse(Buffer.from(await open(remotePath.page(DOC, 1))).toString()));
    expect(index?.sentences).toHaveLength(2);
    const pack = unpackAudio(await open(remotePath.pack(DOC, 1)));
    expect(pack?.map((f) => f.key)).toEqual(index?.sentences.map((s) => s.key));
    expect(Buffer.from(pack![1]!.bytes).toString()).toBe(audioOf('Three four five.').toString());
  });

  it('sends a sentence that two pages share once for each page, packed with its page', async () => {
    await makeDocument(1);
    await syncLibrary(store, key, root, DESKTOP);
    const pack = unpackAudio(
      await unseal(key, remotePath.pack(DOC, 2), store.files.get(remotePath.pack(DOC, 2))!),
    );
    expect(pack).toHaveLength(1);
  });

  it('sends nothing again when the store holds the same preparation', async () => {
    await makeDocument(1);
    await syncLibrary(store, key, root, DESKTOP);
    store.puts = [];
    expect(await syncLibrary(store, key, root, DESKTOP)).toEqual({
      documents: 1,
      uploaded: 0,
      unreadable: 0,
    });
    expect(store.puts).toEqual([]);
  });

  it('sends the document again when it was prepared again', async () => {
    await makeDocument(1);
    await syncLibrary(store, key, root, DESKTOP);
    await makeDocument(2);
    expect((await syncLibrary(store, key, root, DESKTOP)).uploaded).toBe(1);
  });

  it('sends it again with a new key, since the old files cannot be read', async () => {
    await makeDocument(1);
    await syncLibrary(store, key, root, DESKTOP);
    expect((await syncLibrary(store, newSyncKey(), root, DESKTOP)).uploaded).toBe(1);
  });

  it('leaves a document alone that is still being prepared', async () => {
    const folder = await makeDocument(1);
    await rm(join(folder, 'manifest.json'));
    expect(await syncLibrary(store, key, root, DESKTOP)).toEqual({
      documents: 0,
      uploaded: 0,
      unreadable: 0,
    });
    expect(store.puts).toEqual([]);
  });

  it('does nothing when there is no library yet', async () => {
    expect(await syncLibrary(store, key, join(root, 'missing'), DESKTOP)).toEqual({
      documents: 0,
      uploaded: 0,
      unreadable: 0,
    });
  });

  it('stops with the document’s name when a file of the library is missing', async () => {
    const folder = await makeDocument(1);
    await rm(join(folder, 'pages', '2.json'));
    await expect(syncLibrary(store, key, root, DESKTOP)).rejects.toThrow();
    expect(store.files.has(remotePath.manifest(DOC))).toBe(false);
  });
});

describe('audio page by page (ADR 11)', () => {
  const manifestOf = (voiced: number[], updated: number): string =>
    JSON.stringify({
      version: LIBRARY_VERSION,
      voices: voiced.length > 0 ? 'ab' : '',
      docId: DOC,
      name: 'paper.pdf',
      pages: 2,
      sentences: 0,
      bytes: 100,
      updated,
      voiced,
    });

  it('sends a PDF that has no audio yet: the PDF and the manifest', async () => {
    const folder = await makeDocument(1);
    await writeFile(join(folder, 'manifest.json'), manifestOf([], 1));
    await syncLibrary(store, key, root, DESKTOP);
    expect(store.puts).toEqual([remotePath.pdf(DOC), remotePath.manifest(DOC), remotePath.journal(DESKTOP)]);
  });

  it('sends a page as it is added, and only that page', async () => {
    const memo = newMemo();
    const folder = await makeDocument(1);
    await writeFile(join(folder, 'manifest.json'), manifestOf([1], 1));
    await syncLibrary(store, key, root, DESKTOP, { memo });
    expect(store.puts).toContain(remotePath.page(DOC, 1));
    expect(store.puts).not.toContain(remotePath.page(DOC, 2));
    store.forget();
    await writeFile(join(folder, 'manifest.json'), manifestOf([1, 2], 2));
    await syncLibrary(store, key, root, DESKTOP, { memo });
    expect(store.puts).toEqual([
      remotePath.pack(DOC, 2),
      remotePath.page(DOC, 2),
      remotePath.manifest(DOC),
      remotePath.journal(DESKTOP),
    ]);
  });
});

describe('places', () => {
  const sealState = async (state: DeviceState, path = remotePath.state(DOC, state.device)): Promise<void> => {
    store.files.set(path, await seal(key, path, new TextEncoder().encode(JSON.stringify(state))));
  };
  const local = async (device: string): Promise<DeviceState> =>
    JSON.parse(await readFile(join(root, DOC, 'state', `${device}.json`), 'utf8')) as DeviceState;

  it('brings another device’s place down', async () => {
    await makeDocument(1);
    await sealState(stateOf(PHONE, 7));
    await syncLibrary(store, key, root, DESKTOP);
    expect((await local(PHONE)).page).toBe(7);
  });

  it('sends this computer’s own place up, and never writes the other devices’ files', async () => {
    const folder = await makeDocument(1);
    await mkdir(join(folder, 'state'));
    await writeFile(join(folder, 'state', `${DESKTOP}.json`), JSON.stringify(stateOf(DESKTOP, 3)));
    await writeFile(join(folder, 'state', `${PHONE}.json`), JSON.stringify(stateOf(PHONE, 9)));
    await syncLibrary(store, key, root, DESKTOP);
    expect(store.puts).toContain(remotePath.state(DOC, DESKTOP));
    expect(store.puts).not.toContain(remotePath.state(DOC, PHONE));
  });

  it('picks up a newer place on the next sync', async () => {
    await makeDocument(1);
    await sealState(stateOf(PHONE, 7));
    await syncLibrary(store, key, root, DESKTOP);
    await sealState({ ...stateOf(PHONE, 12), updated: 9 });
    await syncLibrary(store, key, root, DESKTOP);
    expect((await local(PHONE)).page).toBe(12);
  });

  it('counts places it cannot read and does not write them', async () => {
    await makeDocument(1);
    const other = newSyncKey();
    const wrongKey = remotePath.state(DOC, PHONE);
    store.files.set(wrongKey, await seal(other, wrongKey, new TextEncoder().encode('{}')));
    // A valid state under another device’s name.
    const liar = remotePath.state(DOC, 'c'.repeat(32));
    await sealState(stateOf(PHONE, 1), liar);
    // And something that is not a state file at all.
    store.files.set(`${remotePath.states(DOC)}/notes.txt`, new Uint8Array([1]));
    const report = await syncLibrary(store, key, root, DESKTOP);
    expect(report.unreadable).toBe(2);
    await expect(readFile(join(root, DOC, 'state', `${PHONE}.json`))).rejects.toThrow();
  });
});

describe('notes', () => {
  const mark = (id: string, over: Partial<Annotation> = {}): Annotation => ({
    id,
    page: 1,
    start: 0,
    end: 3,
    text: 'One',
    quote: 'One',
    kind: 'highlight',
    color: 'yellow',
    comment: '',
    created: '2026-10-21T00:00:00.000Z',
    ...over,
  });
  const file = (annotations: Annotation[], extra: Partial<NotesFile> = {}): NotesFile => ({
    version: 1,
    notes: '',
    annotations,
    ...extra,
  });
  const writeLocal = (notes: NotesFile): Promise<void> =>
    writeFile(join(root, DOC, 'notes.json'), JSON.stringify(notes));
  const readLocal = async (): Promise<NotesFile> =>
    JSON.parse(await readFile(join(root, DOC, 'notes.json'), 'utf8')) as NotesFile;
  const sealRemote = async (notes: NotesFile): Promise<void> => {
    const path = remotePath.notes(DOC);
    store.files.set(path, await seal(key, path, new TextEncoder().encode(JSON.stringify(notes))));
  };
  const readRemote = async (): Promise<NotesFile> => {
    const path = remotePath.notes(DOC);
    return JSON.parse(new TextDecoder().decode(await unseal(key, path, store.files.get(path)!))) as NotesFile;
  };

  it('sends this computer’s marks up, scrambled', async () => {
    await makeDocument(1);
    await writeLocal(file([mark('a', { comment: 'secret comment', updated: 1 })]));
    await syncLibrary(store, key, root, DESKTOP);
    expect(Buffer.from(store.files.get(remotePath.notes(DOC))!).toString('latin1')).not.toContain('secret');
    expect((await readRemote()).annotations.map((a) => a.id)).toEqual(['a']);
  });

  it('brings a phone’s marks down, and sends the merge back', async () => {
    await makeDocument(1);
    await writeLocal(file([mark('a', { updated: 1 })]));
    await sealRemote(file([mark('b', { updated: 2 })], { removed: [{ id: 'a', updated: 3 }] }));
    const changed: string[] = [];
    await syncLibrary(store, key, root, DESKTOP, { onNotesChanged: (docId) => changed.push(docId) });
    // The phone deleted "a" after it was last changed here: it stays deleted on both.
    for (const merged of [await readLocal(), await readRemote()]) {
      expect(merged.annotations.map((a) => a.id)).toEqual(['b']);
      expect(merged.removed).toEqual([{ id: 'a', updated: 3 }]);
    }
    expect(changed).toEqual([DOC]);
  });

  it('keeps the later edit of a mark changed on both sides', async () => {
    await makeDocument(1);
    await writeLocal(file([mark('a', { comment: 'desktop', updated: 10 })]));
    await sealRemote(file([mark('a', { comment: 'phone', updated: 20 })]));
    await syncLibrary(store, key, root, DESKTOP);
    expect((await readLocal()).annotations[0]!.comment).toBe('phone');
  });

  it('sends nothing, and tells no one, when both sides already agree', async () => {
    await makeDocument(1);
    await writeLocal(file([mark('a', { updated: 1 })]));
    await syncLibrary(store, key, root, DESKTOP);
    store.puts = [];
    const changed: string[] = [];
    await syncLibrary(store, key, root, DESKTOP, { onNotesChanged: (docId) => changed.push(docId) });
    expect(store.puts).not.toContain(remotePath.notes(DOC));
    expect(changed).toEqual([]);
  });

  it('takes notes from the store for a document that has none here yet', async () => {
    await makeDocument(1);
    await sealRemote(file([mark('b', { updated: 2 })], { notes: 'from the phone', notesUpdated: 2 }));
    await syncLibrary(store, key, root, DESKTOP);
    expect((await readLocal()).notes).toBe('from the phone');
  });

  it('writes no notes file where there are no notes on either side', async () => {
    await makeDocument(1);
    await syncLibrary(store, key, root, DESKTOP);
    expect(store.files.has(remotePath.notes(DOC))).toBe(false);
    await expect(readFile(join(root, DOC, 'notes.json'))).rejects.toThrow();
  });

  it('counts notes it cannot read, and leaves them alone', async () => {
    await makeDocument(1);
    await writeLocal(file([mark('a', { updated: 1 })]));
    const path = remotePath.notes(DOC);
    store.files.set(path, await seal(newSyncKey(), path, new TextEncoder().encode('{}')));
    const before = store.files.get(path)!;
    const report = await syncLibrary(store, key, root, DESKTOP);
    expect(report.unreadable).toBe(1);
    expect(store.files.get(path)).toBe(before);
    expect((await readLocal()).annotations.map((a) => a.id)).toEqual(['a']);
  });
});

describe('change journals', () => {
  let memo: SyncMemo;
  const sync = (options: { full?: boolean } = {}): ReturnType<typeof syncLibrary> =>
    syncLibrary(store, key, root, DESKTOP, { memo, name: 'Mac', ...options });
  const text = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const readJournal = async (device: string): Promise<Journal | null> => {
    const path = remotePath.journal(device);
    const sealed = store.files.get(path);
    return sealed
      ? parseJournal(JSON.parse(new TextDecoder().decode(await unseal(key, path, sealed))))
      : null;
  };
  /** The phone sends a mark the way the phone's code does: the notes file, then its journal. */
  const phoneSends = async (annotation: Annotation, at: number): Promise<void> => {
    const notes = remotePath.notes(DOC);
    await store.put(
      notes,
      await seal(key, notes, text({ version: 1, notes: '', annotations: [annotation] } satisfies NotesFile)),
    );
    const journal = remotePath.journal(PHONE);
    await store.put(
      journal,
      await seal(
        key,
        journal,
        text({
          device: PHONE,
          name: 'Galaxy',
          updated: at,
          docs: { [DOC]: { manifest: 0, notes: at, state: 0 } },
        } satisfies Journal),
      ),
    );
  };
  const phoneMark: Annotation = {
    id: 'p1',
    page: 1,
    start: 0,
    end: 3,
    text: 'One',
    quote: 'One',
    kind: 'highlight',
    color: 'yellow',
    comment: 'from the phone',
    created: '2026-10-21T00:00:00.000Z',
    updated: 5,
  };

  beforeEach(async () => {
    memo = newMemo();
    await makeDocument(1);
    await sync();
    store.forget();
  });

  it('leaves out a document the user stopped syncing, and takes it out of the journal', async () => {
    const report = await syncLibrary(store, key, root, DESKTOP, { memo, stopped: new Set([DOC]) });
    expect(report.documents).toBe(0);
    expect((await readJournal(DESKTOP))?.docs).toEqual({});
    store.forget();
    await sync();
    expect(store.puts).toEqual([remotePath.journal(DESKTOP)]);
    expect((await readJournal(DESKTOP))?.docs[DOC]).toBeDefined();
  });

  it('carries "Send to phone" offers in the journal, and rewrites it only when they change', async () => {
    const offers = { [PHONE]: [{ docId: DOC, name: 'paper.pdf', bytes: 100, sent: 7 }] };
    await syncLibrary(store, key, root, DESKTOP, { memo, offers });
    expect((await readJournal(DESKTOP))?.offers).toEqual(offers);
    store.forget();
    await syncLibrary(store, key, root, DESKTOP, { memo, offers });
    expect(store.puts).toEqual([]);
    await syncLibrary(store, key, root, DESKTOP, { memo, offers: {} });
    expect(store.puts).toEqual([remotePath.journal(DESKTOP)]);
    expect((await readJournal(DESKTOP))?.offers).toBeUndefined();
  });

  it('writes this computer’s journal after the first sync, with the manifest’s time', async () => {
    const journal = await readJournal(DESKTOP);
    expect(journal?.name).toBe('Mac');
    expect(journal?.docs[DOC]).toEqual({ manifest: 1, notes: 0, state: 0 });
  });

  it('costs one listing, and nothing else, when no one changed anything', async () => {
    expect(await sync()).toEqual({ documents: 1, uploaded: 0, unreadable: 0 });
    expect(store.lists).toEqual(['devices']);
    expect(store.gets).toEqual([]);
    expect(store.puts).toEqual([]);
  });

  it('fetches only the notes of the one document another device changed', async () => {
    await phoneSends(phoneMark, 100);
    store.forget();
    const changed: string[] = [];
    await syncLibrary(store, key, root, DESKTOP, {
      memo,
      onNotesChanged: (docId) => changed.push(docId),
    });
    expect(store.gets).toEqual([remotePath.journal(PHONE), remotePath.notes(DOC)]);
    expect(changed).toEqual([DOC]);
    const local = JSON.parse(await readFile(join(root, DOC, 'notes.json'), 'utf8')) as NotesFile;
    expect(local.annotations.map((a) => a.comment)).toEqual(['from the phone']);
    // Merged to the same file, so nothing is sent back and nobody is told.
    expect(store.puts).toEqual([]);
    store.forget();
    await sync();
    expect(store.gets).toEqual([]);
  });

  it('does not open a journal whose ETag it has seen', async () => {
    await phoneSends(phoneMark, 100);
    await sync();
    store.forget();
    await sync();
    expect(store.gets).toEqual([]);
  });

  it('sends a local change and says so in the journal, without reading the store', async () => {
    await writeFile(
      join(root, DOC, 'notes.json'),
      JSON.stringify({ version: 1, notes: 'mine', notesUpdated: 7, annotations: [] }),
    );
    await sync();
    expect(store.gets).toEqual([remotePath.notes(DOC)]);
    expect(store.puts).toEqual([remotePath.notes(DOC), remotePath.journal(DESKTOP)]);
    expect((await readJournal(DESKTOP))?.docs[DOC]?.notes).toBeGreaterThan(0);
    store.forget();
    await sync();
    expect(store.puts).toEqual([]);
  });

  it('sends a new place once, and not again until it changes', async () => {
    await mkdir(join(root, DOC, 'state'), { recursive: true });
    await writeFile(join(root, DOC, 'state', `${DESKTOP}.json`), JSON.stringify(stateOf(DESKTOP, 3)));
    await sync();
    expect(store.puts).toEqual([remotePath.state(DOC, DESKTOP), remotePath.journal(DESKTOP)]);
    store.forget();
    await sync();
    expect(store.puts).toEqual([]);
  });

  it('sends a document prepared again, and says so', async () => {
    await makeDocument(2);
    expect((await sync()).uploaded).toBe(1);
    expect((await readJournal(DESKTOP))?.docs[DOC]?.manifest).toBe(2);
  });

  it('does not see a change whose journal was lost until everything is walked', async () => {
    await phoneSends(phoneMark, 100);
    store.files.delete(remotePath.journal(PHONE));
    await sync();
    await expect(readFile(join(root, DOC, 'notes.json'))).rejects.toThrow();
    await sync({ full: true });
    const local = JSON.parse(await readFile(join(root, DOC, 'notes.json'), 'utf8')) as NotesFile;
    expect(local.annotations).toHaveLength(1);
  });

  it('writes its own journal again after a full walk finds it lost', async () => {
    store.files.delete(remotePath.journal(DESKTOP));
    await sync();
    expect(store.puts).toEqual([]);
    await sync({ full: true });
    expect((await readJournal(DESKTOP))?.docs[DOC]?.manifest).toBe(1);
  });

  it('walks everything when the memo is lost, but sends nothing it already sent', async () => {
    memo = newMemo();
    const report = await sync();
    expect(report).toEqual({ documents: 1, uploaded: 0, unreadable: 0 });
    expect(store.puts).toEqual([]);
    expect(store.gets).toContain(remotePath.manifest(DOC));
  });

  it('reads the memo back from its file, and forgets a damaged one', () => {
    expect(parseMemo(JSON.parse(JSON.stringify(memo)))).toEqual(memo);
    expect(parseMemo({ seen: 5, own: [], synced: 'x' })).toEqual(newMemo());
    expect(parseMemo(null)).toEqual(newMemo());
  });

  it('counts a journal it cannot open and tries it again next time', async () => {
    const path = remotePath.journal(PHONE);
    await store.put(path, await seal(newSyncKey(), path, text({})));
    expect((await sync()).unreadable).toBe(1);
    expect((await sync()).unreadable).toBe(1);
  });

  it('keeps the memo as it was when a sync fails, so the change is found next time', async () => {
    await phoneSends(phoneMark, 100);
    const before = structuredClone(memo);
    const failing = {
      ...store,
      list: store.list.bind(store),
      get: store.get.bind(store),
      put: () => Promise.reject(new Error('offline')),
    };
    await writeFile(
      join(root, DOC, 'notes.json'),
      JSON.stringify({ version: 1, notes: 'x', notesUpdated: 9, annotations: [] }),
    );
    await expect(syncLibrary(failing as SyncStore, key, root, DESKTOP, { memo })).rejects.toThrow('offline');
    expect(memo).toEqual(before);
    await sync();
    expect(store.puts).toContain(remotePath.journal(DESKTOP));
  });
});
