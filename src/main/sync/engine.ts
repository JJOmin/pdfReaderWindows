import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDeviceState, parseManifest, parsePageIndex, type Manifest } from '../../shared/phone-library';
import { packAudio, remotePath, seal, unseal, type SyncStore } from '../../shared/sync-store';
import type { SyncReport } from '../../shared/types';

const DOC_ID = /^[0-9a-f]{64}$/;
const STATE_FILE = /^([0-9a-f]{32})\.json$/;

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
 * Puts one finished document in the store: the PDF, then every page's index and packed audio, and
 * the manifest last, so a manifest in the store means the document is whole.
 * Returns false when the store already holds this very preparation.
 */
// shortcut: an upload that stops halfway starts again from the PDF. Upgrade when documents are
// large enough that this is seen, by listing what is there and sending only the rest.
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
  if (there) {
    const remote = parseManifest(JSON.parse(new TextDecoder().decode(there)));
    if (remote?.updated === manifest.updated) return false;
  }

  await put(remotePath.pdf(docId), await readFile(join(folder, 'document.pdf')));
  for (let page = 1; page <= manifest.pages; page++) {
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
 * Exchanges the places. This computer's own state goes up, and the other devices' come down into
 * `state/`, where the app reads them. Each device writes only its own file, so nothing is merged.
 * Returns how many files from another device could not be read.
 */
async function exchangeStates(
  store: SyncStore,
  key: Uint8Array,
  folder: string,
  docId: string,
  device: string,
): Promise<number> {
  const local = join(folder, 'state');
  const own = join(local, `${device}.json`);
  try {
    const bytes = await readFile(own);
    const path = remotePath.state(docId, device);
    await store.put(path, await seal(key, path, bytes));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

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

/** Brings the store and the phone library in `root` up to date with each other. */
export async function syncLibrary(
  store: SyncStore,
  key: Uint8Array,
  root: string,
  device: string,
): Promise<SyncReport> {
  const report: SyncReport = { documents: 0, uploaded: 0, unreadable: 0 };
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return report;
  }
  for (const docId of names.filter((n) => DOC_ID.test(n))) {
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
    if (await uploadDocument(store, key, folder, manifest)) report.uploaded++;
    report.unreadable += await exchangeStates(store, key, folder, docId, device);
  }
  return report;
}
