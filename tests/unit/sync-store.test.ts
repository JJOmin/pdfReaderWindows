import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSyncConfig, parseSyncSecrets } from '../../src/shared/sync-config';
import {
  assertPath,
  changedParts,
  type Journal,
  formatSyncKey,
  newSyncKey,
  packAudio,
  parseJournal,
  parseServerUrl,
  parseSyncKey,
  remotePath,
  seal,
  unpackAudio,
  unseal,
} from '../../src/shared/sync-store';

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('assertPath', () => {
  it('accepts the names the library uses', () => {
    for (const path of [remotePath.manifest('c'.repeat(64)), remotePath.pack('c'.repeat(64), 12)]) {
      expect(() => assertPath(path)).not.toThrow();
    }
  });

  it.each(['../x', 'a/../b', '/abs', 'a//b', 'a b', 'a\\b', '', '.', 'a/..', 'ä'])('refuses %j', (path) => {
    expect(() => assertPath(path)).toThrow();
  });
});

describe('packAudio', () => {
  it('returns the files it was given, in order', () => {
    const files = [
      { key: KEY_A, bytes: bytes(1, 2, 3) },
      { key: KEY_B, bytes: bytes() },
      { key: KEY_A, bytes: bytes(9) },
    ];
    expect(unpackAudio(packAudio(files))).toEqual(files);
  });

  it('packs no files', () => {
    expect(unpackAudio(packAudio([]))).toEqual([]);
  });

  it('reads a pack that is a view into a larger buffer', () => {
    const pack = packAudio([{ key: KEY_A, bytes: bytes(5, 6) }]);
    const padded = new Uint8Array(pack.length + 3);
    padded.set(pack, 2);
    expect(unpackAudio(padded.subarray(2, 2 + pack.length))?.[0]?.bytes).toEqual(bytes(5, 6));
  });

  it('refuses a pack that is cut short, has extra bytes or a bad header', () => {
    const pack = packAudio([{ key: KEY_A, bytes: bytes(1, 2, 3) }]);
    expect(unpackAudio(pack.subarray(0, pack.length - 1))).toBeNull();
    expect(unpackAudio(new Uint8Array([...pack, 0]))).toBeNull();
    expect(unpackAudio(bytes(0, 0, 0, 9, 1))).toBeNull();
    expect(unpackAudio(bytes(1))).toBeNull();
    expect(unpackAudio(packAudio([{ key: 'not-a-key', bytes: bytes(1) }]))).toBeNull();
  });
});

describe('seal and unseal', () => {
  const key = newSyncKey();
  const data = new TextEncoder().encode('Sentence one. Sentence two.');

  it('returns what was sealed, and hides it', async () => {
    const sealed = await seal(key, 'a/b.json', data);
    expect(new TextDecoder().decode(sealed)).not.toContain('Sentence');
    expect(await unseal(key, 'a/b.json', sealed)).toEqual(data);
  });

  it('seals the same data differently each time', async () => {
    expect(await seal(key, 'a', data)).not.toEqual(await seal(key, 'a', data));
  });

  it('seals nothing', async () => {
    expect(await unseal(key, 'a', await seal(key, 'a', new Uint8Array()))).toEqual(new Uint8Array());
  });

  it('refuses a wrong key, another path, a changed file and a file that is not sealed', async () => {
    const sealed = await seal(key, 'a/b.json', data);
    await expect(unseal(newSyncKey(), 'a/b.json', sealed)).rejects.toThrow('sync key is wrong');
    await expect(unseal(key, 'a/c.json', sealed)).rejects.toThrow('sync key is wrong');
    const changed = sealed.slice();
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    await expect(unseal(key, 'a/b.json', changed)).rejects.toThrow('sync key is wrong');
    await expect(unseal(key, 'a/b.json', data)).rejects.toThrow('not a file of this app');
  });
});

describe('sync key text', () => {
  it('goes round trip, in groups of eight digits', () => {
    const key = newSyncKey();
    const text = formatSyncKey(key);
    expect(text).toMatch(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    expect(parseSyncKey(text)).toEqual(key);
  });

  it('reads a key pasted with spaces, capitals or no dashes', () => {
    const key = newSyncKey();
    const pasted = ` ${formatSyncKey(key).replace(/-/gu, '').toUpperCase()}\n`;
    expect(parseSyncKey(pasted)).toEqual(key);
  });

  it('refuses text that is not a key', () => {
    expect(parseSyncKey('')).toBeNull();
    expect(parseSyncKey('abc')).toBeNull();
    expect(parseSyncKey('g'.repeat(64))).toBeNull();
    expect(parseSyncKey('a'.repeat(65))).toBeNull();
  });
});

describe('parseServerUrl', () => {
  it('assumes https when no scheme is typed', () => {
    expect(parseServerUrl('cloud.example.com')?.href).toBe('https://cloud.example.com/');
    expect(parseServerUrl(' https://cloud.example.com/nextcloud ')?.href).toBe(
      'https://cloud.example.com/nextcloud',
    );
  });

  it('accepts plain http only on the local network', () => {
    for (const ok of [
      'http://192.168.1.5',
      'http://10.0.0.2:8080',
      'http://truenas.local',
      'http://localhost:8080',
    ]) {
      expect(parseServerUrl(ok), ok).not.toBeNull();
    }
    for (const bad of ['http://cloud.example.com', 'http://8.8.8.8', 'http://192.168.1.5.evil.com']) {
      expect(parseServerUrl(bad), bad).toBeNull();
    }
  });

  it('refuses addresses with a password, a query or another scheme', () => {
    for (const bad of [
      '',
      '  ',
      'https://user:pw@cloud.example.com',
      'https://x.com/?a=1',
      'ftp://x.com',
      'file:///c',
    ]) {
      expect(parseServerUrl(bad), bad).toBeNull();
    }
  });
});

describe('sync config', () => {
  const id = (): string => 'f'.repeat(32);

  it('starts disconnected with a device id', () => {
    expect(parseSyncConfig(null, id)).toEqual({
      deviceId: id(),
      backend: 'none',
      server: '',
      user: '',
      secrets: '',
      auto: true,
      stopped: [],
    });
  });

  it('syncs on its own unless switched off, and keeps the documents the user stopped', () => {
    expect(parseSyncConfig({ auto: false }, id).auto).toBe(false);
    expect(parseSyncConfig({ auto: 'no' }, id).auto).toBe(true);
    const stopped = parseSyncConfig({ stopped: ['a'.repeat(64), 'short', 5] }, id).stopped;
    expect(stopped).toEqual(['a'.repeat(64)]);
  });

  it('keeps what is valid and drops what is not', () => {
    const config = parseSyncConfig(
      { deviceId: 'a'.repeat(32), backend: 'nextcloud', server: 5, user: 'alice', secrets: 'xyz' },
      id,
    );
    expect(config).toEqual({
      deviceId: 'a'.repeat(32),
      backend: 'nextcloud',
      server: '',
      user: 'alice',
      secrets: 'xyz',
      auto: true,
      stopped: [],
    });
    // Dropbox was removed (ADR 10): a file written while it was chosen reads as signed out.
    expect(parseSyncConfig({ deviceId: 'a'.repeat(32), backend: 'dropbox' }, id)).toMatchObject({
      backend: 'none',
    });
    expect(parseSyncConfig({ backend: 'onedrive', deviceId: 'short' }, id)).toMatchObject({
      backend: 'none',
      deviceId: id(),
    });
  });

  it('reads only the secrets it knows', () => {
    expect(parseSyncSecrets({ key: 'k', password: 3, refresh: 'r', other: 'x' })).toEqual({ key: 'k' });
    expect(parseSyncSecrets('nope')).toEqual({});
  });
});

describe('change journal', () => {
  const golden = JSON.parse(readFileSync('tests/golden/journal.json', 'utf8')) as {
    key: string;
    path: string;
    plain: string;
    sealedBase64: string;
  };
  const DOC_A = '3'.repeat(64);
  const DOC_B = '4'.repeat(64);
  const journal = (docs: Record<string, [number, number, number]>): Journal => ({
    device: 'd'.repeat(32),
    name: 'Mac',
    updated: 1,
    docs: Object.fromEntries(
      Object.entries(docs).map(([id, [manifest, notes, state]]) => [id, { manifest, notes, state }]),
    ),
  });

  it('opens the golden file, which the phone must also write byte for byte', async () => {
    const key = parseSyncKey(golden.key)!;
    const sealed = Uint8Array.from(Buffer.from(golden.sealedBase64, 'base64'));
    const plain = new TextDecoder().decode(await unseal(key, golden.path, sealed));
    expect(plain).toBe(golden.plain);
    expect(golden.path).toBe(remotePath.journal('d'.repeat(32)));
    const read = parseJournal(JSON.parse(plain));
    expect(read?.name).toBe('Leos-MacBook');
    expect(Object.keys(read?.docs ?? {})).toEqual([DOC_A, DOC_B]);
    expect(JSON.stringify(read)).toBe(golden.plain);
  });

  it('refuses a journal without a device or a time, and drops a document it cannot read', () => {
    expect(parseJournal(null)).toBeNull();
    expect(parseJournal({ device: 'x', updated: 1, docs: {} })).toBeNull();
    expect(parseJournal({ device: 'd'.repeat(32), docs: {} })).toBeNull();
    const read = parseJournal({
      device: 'd'.repeat(32),
      updated: 1,
      docs: {
        [DOC_A]: { manifest: 1, notes: 2, state: 3 },
        [DOC_B]: { manifest: 1 },
        short: { manifest: 1, notes: 1, state: 1 },
      },
    });
    expect(Object.keys(read?.docs ?? {})).toEqual([DOC_A]);
    expect(read?.name).toBe('');
  });

  it('carries the offers of "Send to phone", and leaves them out when there are none', () => {
    const offer = { docId: DOC_A, name: 'paper.pdf', bytes: 12, sent: 5 };
    const withOffers = { ...journal({ [DOC_A]: [1, 2, 3] }), offers: { ['e'.repeat(32)]: [offer] } };
    expect(parseJournal(JSON.parse(JSON.stringify(withOffers)))).toEqual(withOffers);
    expect(JSON.stringify(parseJournal({ ...withOffers, offers: {} }))).not.toContain('offers');
  });

  it('finds nothing when nothing changed', () => {
    const j = journal({ [DOC_A]: [1, 2, 3] });
    expect(changedParts(j, structuredClone(j)).size).toBe(0);
  });

  it('names the part that changed, whichever way the clock moved', () => {
    const before = journal({ [DOC_A]: [1, 2, 3] });
    expect(changedParts(before, journal({ [DOC_A]: [1, 9, 3] }))).toEqual(new Map([[DOC_A, ['notes']]]));
    expect(changedParts(before, journal({ [DOC_A]: [1, 2, 0] }))).toEqual(new Map([[DOC_A, ['state']]]));
  });

  it('reports a new document with all its parts, and everything for a journal never read', () => {
    const now = journal({ [DOC_A]: [1, 2, 3], [DOC_B]: [4, 0, 0] });
    expect(changedParts(journal({ [DOC_A]: [1, 2, 3] }), now)).toEqual(
      new Map([[DOC_B, ['manifest', 'notes', 'state']]]),
    );
    expect([...changedParts(null, now).keys()]).toEqual([DOC_A, DOC_B]);
  });
});
