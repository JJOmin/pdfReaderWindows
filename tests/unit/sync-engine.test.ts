import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncLibrary } from '../../src/main/sync/engine';
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
  remotePath,
  seal,
  unpackAudio,
  unseal,
  type RemoteEntry,
  type SyncStore,
} from '../../src/shared/sync-store';

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

class MemoryStore implements SyncStore {
  readonly files = new Map<string, Uint8Array>();
  puts: string[] = [];

  async list(dir: string): Promise<RemoteEntry[]> {
    const names = new Map<string, RemoteEntry>();
    for (const [path, bytes] of this.files) {
      if (!path.startsWith(`${dir}/`)) continue;
      const [first, ...rest] = path.slice(dir.length + 1).split('/');
      names.set(first!, { name: first!, folder: rest.length > 0, size: bytes.length });
    }
    return [...names.values()];
  }
  async get(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }
  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.puts.push(path);
    this.files.set(path, bytes);
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
      docId: DOC,
      name: 'paper.pdf',
      pages: 2,
      sentences: 3,
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
