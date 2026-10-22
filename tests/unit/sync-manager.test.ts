import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncManager } from '../../src/main/sync/manager';
import {
  buildPageIndex,
  LIBRARY_VERSION,
  syncKey,
  type PreparedSentence,
} from '../../src/shared/phone-library';
import { formatSyncKey, newSyncKey } from '../../src/shared/sync-store';
import { fakeNextcloud, type FakeNextcloud } from './fake-servers';

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const PDF = Buffer.from('%PDF-1.7 secret contents');
const DOC = sha256(PDF);
const SENTENCE: PreparedSentence = {
  text: 'Hello there.',
  lang: 'en',
  words: ['Hello', 'there'],
  ms: 900,
  timings: [
    [0, 400],
    [400, 800],
  ],
};

let dir: string;
let nextcloud: FakeNextcloud;
let opened: string[];

/** The system's secret store, played by a reversible scramble that is not plain JSON. */
const box = {
  encrypt: (text: string): string => Buffer.from(text).reverse().toString('base64'),
  decrypt: (text: string): string => Buffer.from(text, 'base64').reverse().toString(),
};

const manager = (browser?: (url: string) => void): SyncManager =>
  new SyncManager({
    configPath: join(dir, 'sync.json'),
    memoPath: join(dir, 'sync-memo.json'),
    deviceName: 'Test-Mac',
    libraryRoot: join(dir, 'phone-library'),
    box,
    openUrl: (url) => {
      opened.push(url);
      browser?.(url);
    },
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdfreader-manager-'));
  opened = [];
  nextcloud = await fakeNextcloud();
  const folder = join(dir, 'phone-library', DOC);
  await mkdir(join(folder, 'pages'), { recursive: true });
  await mkdir(join(folder, 'audio'));
  await writeFile(join(folder, 'document.pdf'), PDF);
  await writeFile(join(folder, 'pages', '1.json'), JSON.stringify(buildPageIndex([SENTENCE], sha256)));
  await writeFile(join(folder, 'audio', `${syncKey(SENTENCE.text, sha256)}.opus`), 'OggS audio');
  await writeFile(
    join(folder, 'manifest.json'),
    JSON.stringify({
      version: LIBRARY_VERSION,
      docId: DOC,
      name: 'secret.pdf',
      pages: 1,
      sentences: 1,
      bytes: 10,
      updated: 1,
    }),
  );
});
afterEach(async () => {
  await Promise.all([nextcloud.close(), rm(dir, { recursive: true, force: true })]);
});

describe('SyncManager', () => {
  it('starts with nothing connected', async () => {
    expect(await manager().getStatus()).toEqual({ backend: 'none', account: '' });
    await expect(manager().run()).rejects.toThrow('Sign in');
  });

  it('signs in to Nextcloud, keeps the secrets scrambled, and sends the library', async () => {
    const sync = manager(() => nextcloud.approve());
    const status = await sync.connect('nextcloud', nextcloud.url);
    expect(status).toMatchObject({
      backend: 'nextcloud',
      account: expect.stringContaining('alice at 127.0.0.1'),
    });

    const saved = await readFile(join(dir, 'sync.json'), 'utf8');
    expect(saved).not.toContain('app-pass');
    expect(saved).not.toContain(await sync.key());

    expect(await sync.run()).toEqual({ documents: 1, uploaded: 1, unreadable: 0 });
    expect([...nextcloud.files.keys()]).toContain(`PDF Reader/${DOC}/manifest.json`);
    for (const bytes of nextcloud.files.values()) expect(bytes.toString('latin1')).not.toContain('secret');
    expect(await manager().getStatus()).toMatchObject({ backend: 'nextcloud' });
  });

  it('asks for nothing but the journals on the second run, and walks everything on request', async () => {
    const sync = manager(() => nextcloud.approve());
    await sync.connect('nextcloud', nextcloud.url);
    await sync.run();
    const before = new Map([...nextcloud.files].map(([path, bytes]) => [path, bytes]));
    expect(await sync.run()).toEqual({ documents: 1, uploaded: 0, unreadable: 0 });
    // Nothing was written again.
    for (const [path, bytes] of nextcloud.files) expect(bytes).toBe(before.get(path));
    expect([...nextcloud.files.keys()].some((p) => p.startsWith('PDF Reader/devices/'))).toBe(true);
    expect(await sync.run(true)).toEqual({ documents: 1, uploaded: 0, unreadable: 0 });
  });

  it('starts again with a full walk when the key changes, since the memo described the old files', async () => {
    const sync = manager(() => nextcloud.approve());
    await sync.connect('nextcloud', nextcloud.url);
    await sync.run();
    await sync.setKey(formatSyncKey(newSyncKey()));
    expect((await sync.run()).uploaded).toBe(1);
  });

  it('knows no service but Nextcloud', async () => {
    await expect(manager().connect('dropbox', undefined)).rejects.toThrow('Unknown sync service');
  });

  it('keeps the key when signing out, so signing in again finds the files', async () => {
    const sync = manager(() => nextcloud.approve());
    await sync.connect('nextcloud', nextcloud.url);
    const key = await sync.key();
    await sync.run();
    expect(await sync.disconnect()).toMatchObject({ backend: 'none' });
    await expect(sync.run()).rejects.toThrow('Sign in');
    await sync.connect('nextcloud', nextcloud.url);
    expect(await sync.key()).toBe(key);
    expect(await sync.run()).toMatchObject({ uploaded: 0 });
  });

  it('takes a key from another device', async () => {
    const sync = manager();
    const first = await sync.key();
    const other = '0123456789abcdef'.repeat(4);
    expect(await sync.setKey(other)).toBe(
      '01234567-89abcdef-01234567-89abcdef-01234567-89abcdef-01234567-89abcdef',
    );
    expect(await sync.key()).not.toBe(first);
    await expect(sync.setKey('not a key')).rejects.toThrow('64 hexadecimal');
    await expect(sync.setKey(5)).rejects.toThrow('64 hexadecimal');
  });

  it('refuses what the renderer should not be able to ask for', async () => {
    const sync = manager();
    await expect(sync.connect('onedrive', undefined)).rejects.toThrow('Unknown sync service');
    await expect(sync.connect('nextcloud', 'http://evil.example.com')).rejects.toThrow(
      'address of your Nextcloud',
    );
    await expect(sync.connect('nextcloud', 42)).rejects.toThrow('address of your Nextcloud');
    expect(opened).toEqual([]);
  });

  it('can be cancelled while it waits for the browser', async () => {
    const sync = manager();
    const waiting = sync.connect('nextcloud', nextcloud.url);
    setTimeout(() => sync.cancel(), 50);
    await expect(waiting).rejects.toThrow();
    expect(await sync.getStatus()).toMatchObject({ backend: 'none' });
  });

  it('refuses a second run while one is going', async () => {
    const sync = manager(() => nextcloud.approve());
    await sync.connect('nextcloud', nextcloud.url);
    const first = sync.run();
    await expect(sync.run()).rejects.toThrow('already running');
    await first;
  });

  it('treats secrets it cannot open as signed out', async () => {
    const sync = manager(() => nextcloud.approve());
    await sync.connect('nextcloud', nextcloud.url);
    const other = new SyncManager({
      configPath: join(dir, 'sync.json'),
      memoPath: join(dir, 'sync-memo.json'),
      deviceName: 'Test-Mac',
      libraryRoot: join(dir, 'phone-library'),
      box: {
        encrypt: box.encrypt,
        decrypt: () => {
          throw new Error('other user');
        },
      },
      openUrl: () => undefined,
    });
    await expect(other.run()).rejects.toThrow('Sign in');
  });
});
