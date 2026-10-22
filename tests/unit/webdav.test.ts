import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebDavStore, nextcloudDavBase, nextcloudLogin, parsePropfind } from '../../src/main/sync/webdav';
import { fakeNextcloud, type FakeNextcloud } from './fake-servers';

let server: FakeNextcloud;
beforeEach(async () => (server = await fakeNextcloud()));
afterEach(() => server.close());

const store = (password = 'app-pass'): WebDavStore =>
  new WebDavStore(nextcloudDavBase(server.url, 'alice'), 'alice', password);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('parsePropfind', () => {
  const dir = new URL('https://cloud.example.com/remote.php/dav/files/alice/PDF%20Reader/');
  const xml = (prefix: string) =>
    `<${prefix}multistatus xmlns:${prefix.replace(':', '')}="DAV:">` +
    `<${prefix}response><${prefix}href>/remote.php/dav/files/alice/PDF%20Reader/</${prefix}href></${prefix}response>` +
    `<${prefix}response><${prefix}href>/remote.php/dav/files/alice/PDF%20Reader/abc/</${prefix}href>` +
    `<${prefix}propstat><${prefix}prop><${prefix}resourcetype><${prefix}collection/></${prefix}resourcetype></${prefix}prop></${prefix}propstat></${prefix}response>` +
    `<${prefix}response><${prefix}href>/remote.php/dav/files/alice/PDF%20Reader/1.json</${prefix}href>` +
    `<${prefix}propstat><${prefix}prop><${prefix}getcontentlength>42</${prefix}getcontentlength><${prefix}resourcetype/></${prefix}prop></${prefix}propstat></${prefix}response>` +
    `</${prefix}multistatus>`;

  it.each(['d:', 'D:', ''])('lists the children and not the folder itself, with prefix %j', (prefix) => {
    expect(parsePropfind(xml(prefix), dir)).toEqual([
      { name: 'abc', folder: true, size: 0 },
      { name: '1.json', folder: false, size: 42 },
    ]);
  });

  it('reads the ETag a server gives, which a journal poll compares', () => {
    const etag = `<d:multistatus><d:response><d:href>/remote.php/dav/files/alice/PDF%20Reader/devices/x.json</d:href><d:propstat><d:prop><d:getetag>&quot;5f3a&quot;</d:getetag></d:prop></d:propstat></d:response></d:multistatus>`;
    expect(parsePropfind(etag, dir)).toEqual([
      { name: 'x.json', folder: false, size: 0, etag: '&quot;5f3a&quot;' },
    ]);
  });

  it('reads a full address in the href', () => {
    const full = `<d:multistatus><d:response><d:href>https://cloud.example.com/remote.php/dav/files/alice/PDF%20Reader/x.pack</d:href><d:getcontentlength>7</d:getcontentlength></d:response></d:multistatus>`;
    expect(parsePropfind(full, dir)).toEqual([{ name: 'x.pack', folder: false, size: 7 }]);
  });
});

describe('WebDavStore', () => {
  it('stores a file, creating its folders, and reads it back', async () => {
    const webdav = store();
    await webdav.put('doc/pages/1.json', text('hello'));
    expect(await webdav.get('doc/pages/1.json')).toEqual(text('hello'));
    expect([...server.folders].sort()).toEqual(['', 'PDF Reader', 'PDF Reader/doc', 'PDF Reader/doc/pages']);
    expect(server.files.get('PDF Reader/doc/pages/1.json')?.toString()).toBe('hello');
  });

  it('lists a file with an ETag that changes when the file is written again', async () => {
    const webdav = store();
    await webdav.put('devices/a.json', text('one'));
    const [first] = await webdav.list('devices');
    expect(first?.etag).toBeTruthy();
    expect((await webdav.list('devices'))[0]?.etag).toBe(first?.etag);
    await webdav.put('devices/a.json', text('two'));
    expect((await webdav.list('devices'))[0]?.etag).not.toBe(first?.etag);
  });

  it('replaces a file and works with folders that already exist', async () => {
    await store().put('doc/a.json', text('one'));
    const second = store();
    await second.put('doc/a.json', text('two'));
    await second.put('doc/b.json', text('three'));
    expect(await second.get('doc/a.json')).toEqual(text('two'));
  });

  it('answers null for a file that is not there', async () => {
    expect(await store().get('doc/none.json')).toBeNull();
  });

  it('lists folders and files, and nothing for a folder that does not exist', async () => {
    const webdav = store();
    await webdav.put('doc/manifest.json', text('12345'));
    await webdav.put('doc/state/ab.json', text('x'));
    expect(await webdav.list('doc')).toEqual(
      expect.arrayContaining([
        { name: 'manifest.json', folder: false, size: 5, etag: expect.any(String) },
        { name: 'state', folder: true, size: 0 },
      ]),
    );
    expect(await webdav.list('doc/state')).toEqual([
      { name: 'ab.json', folder: false, size: 1, etag: expect.any(String) },
    ]);
    expect(await webdav.list('nothing')).toEqual([]);
  });

  it('reports a refused password', async () => {
    await expect(store('wrong').put('a.json', text('x'))).rejects.toThrow('401');
  });

  it('refuses paths that are not the library’s own', async () => {
    const webdav = store();
    await expect(webdav.put('../x', text('x'))).rejects.toThrow('Invalid path');
    await expect(webdav.get('a/../../x')).rejects.toThrow('Invalid path');
    await expect(webdav.list('..')).rejects.toThrow('Invalid path');
  });
});

describe('nextcloudLogin', () => {
  const origin = (): URL => new URL(server.url);

  it('opens the sign-in page and returns the app password once it is approved', async () => {
    const opened: string[] = [];
    const login = nextcloudLogin(
      origin(),
      (url) => {
        opened.push(url);
        server.approve();
      },
      new AbortController().signal,
      10,
    );
    await expect(login).resolves.toEqual({ user: 'alice', password: 'app-pass' });
    expect(opened).toEqual([`${server.url}/login/v2/flow/poll-token`]);
  });

  it('keeps asking while the user has not approved, and stops when cancelled', async () => {
    const cancel = new AbortController();
    const login = nextcloudLogin(origin(), () => setTimeout(() => cancel.abort(), 60), cancel.signal, 10);
    await expect(login).rejects.toThrow();
  });

  it('refuses a server that is not Nextcloud', async () => {
    await server.close();
    server = await fakeNextcloud();
    await expect(
      nextcloudLogin(new URL(`${server.url}/elsewhere`), () => undefined, new AbortController().signal, 10),
    ).rejects.toThrow('does not look like a Nextcloud');
  });
});
