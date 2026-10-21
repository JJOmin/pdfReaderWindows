import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildPageIndex,
  LIBRARY_VERSION,
  parsePageIndex,
  parsePreparedPage,
  syncKey,
  type Manifest,
} from '../shared/phone-library';
import { MAX_REQUEST_TEXT } from '../shared/requests';

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** One sentence of Opus at 24 kbit/s is a few KB; this only stops a runaway message. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 10_000;

/** The document the window has open, as the main process knows it. Never anything the renderer says. */
export interface LibraryDocument {
  docId: string;
  name: string;
  path: string;
}

/**
 * The phone library on disk (ADR 7 section 2). The renderer renders and encodes; this side
 * checks what it sends, names every file itself and never takes a path from it.
 */
export class PhoneLibrary {
  constructor(private readonly root: string) {}

  private folder(doc: LibraryDocument): string {
    return join(this.root, doc.docId);
  }

  async addAudio(doc: LibraryDocument, text: unknown, audio: unknown): Promise<void> {
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_REQUEST_TEXT) {
      throw new Error('Invalid sentence text');
    }
    const ogg = new TextEncoder().encode('OggS');
    if (
      !(audio instanceof Uint8Array) ||
      audio.length > MAX_AUDIO_BYTES ||
      !ogg.every((b, i) => audio[i] === b)
    ) {
      throw new Error('Invalid sentence audio');
    }
    const dir = join(this.folder(doc), 'audio');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${syncKey(text, sha256)}.opus`), audio);
  }

  /**
   * Writes a page's index once its audio is there. The last page completes the document: the
   * PDF is copied, audio no index refers to is removed, and the manifest is written.
   */
  async addPage(doc: LibraryDocument, page: unknown, pages: unknown, sentences: unknown): Promise<void> {
    if (!Number.isInteger(pages) || (pages as number) < 1 || (pages as number) > MAX_PAGES) {
      throw new Error('Invalid page count');
    }
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > (pages as number)) {
      throw new Error('Invalid page');
    }
    const prepared = parsePreparedPage(sentences);
    const index = prepared && buildPageIndex(prepared, sha256);
    if (!index) throw new Error(`Page ${page as number} cannot be indexed`);
    const folder = this.folder(doc);
    for (const { key } of index.sentences) {
      if (!existsSync(join(folder, 'audio', `${key}.opus`))) throw new Error(`No audio for sentence ${key}`);
    }
    await mkdir(join(folder, 'pages'), { recursive: true });
    await writeFile(join(folder, 'pages', `${page as number}.json`), JSON.stringify(index));
    if (page === pages) await this.complete(doc, pages as number);
  }

  private async complete(doc: LibraryDocument, pages: number): Promise<void> {
    const folder = this.folder(doc);
    const pdf = await readFile(doc.path);
    // The library is keyed by these bytes, so a file changed since it was opened must not go in.
    if (sha256(pdf) !== doc.docId) throw new Error(`${doc.name} changed on disk. Open it again.`);
    await writeFile(join(folder, 'document.pdf'), pdf);

    const used = new Set<string>();
    let sentences = 0;
    for (let page = 1; page <= pages; page++) {
      const index = parsePageIndex(JSON.parse(await readFile(join(folder, 'pages', `${page}.json`), 'utf8')));
      if (!index) throw new Error(`The index of page ${page} is not valid`);
      sentences += index.sentences.length;
      for (const { key } of index.sentences) used.add(key);
    }
    // Left over from an earlier preparation with other voices or another version of the text.
    for (const file of await readdir(join(folder, 'audio'))) {
      if (!used.has(file.replace(/\.opus$/u, ''))) await rm(join(folder, 'audio', file));
    }

    let bytes = pdf.length;
    for (const dir of ['audio', 'pages']) {
      for (const file of await readdir(join(folder, dir)))
        bytes += (await stat(join(folder, dir, file))).size;
    }
    const manifest: Manifest = {
      version: LIBRARY_VERSION,
      docId: doc.docId,
      name: doc.name,
      pages,
      sentences,
      bytes,
      updated: Date.now(),
    };
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
}
