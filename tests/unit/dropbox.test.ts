import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DropboxStore, dropboxAuthorize } from '../../src/main/sync/dropbox';
import { fakeDropbox, type FakeDropbox } from './fake-servers';

let dropbox: FakeDropbox;
beforeEach(async () => (dropbox = await fakeDropbox()));
afterEach(() => dropbox.close());

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const store = (): DropboxStore =>
  new DropboxStore('app-key', 'refresh-1', dropbox.hosts, async () => undefined);

describe('DropboxStore', () => {
  it('stores a file and reads it back, signing in once', async () => {
    const files = store();
    await files.put('doc/pages/1.json', text('hello'));
    expect(await files.get('doc/pages/1.json')).toEqual(text('hello'));
    expect(dropbox.files.get('/doc/pages/1.json')?.toString()).toBe('hello');
    expect(dropbox.tokensIssued).toBe(1);
  });

  it('answers null for a file that is not there', async () => {
    expect(await store().get('doc/none.json')).toBeNull();
  });

  it('lists a folder across several pages, and an absent one as empty', async () => {
    const files = store();
    for (const name of ['a.json', 'b.json', 'c.json', 'd/e.json']) await files.put(`doc/${name}`, text('xy'));
    const listed = await files.list('doc');
    expect(listed.map((e) => e.name).sort()).toEqual(['a.json', 'b.json', 'c.json', 'd']);
    expect(listed.find((e) => e.name === 'd')?.folder).toBe(true);
    expect(listed.find((e) => e.name === 'a.json')).toMatchObject({ folder: false, size: 2 });
    expect(await files.list('nothing')).toEqual([]);
  });

  it('gets a new token when the old one is refused', async () => {
    const files = store();
    await files.put('a.json', text('1'));
    dropbox.expireTokens();
    await files.put('b.json', text('2'));
    expect(dropbox.files.has('/b.json')).toBe(true);
    expect(dropbox.tokensIssued).toBe(2);
  });

  it('tries again after a 429', async () => {
    dropbox.throttle.remaining = 2;
    const files = store();
    await files.put('a.json', text('1'));
    expect(dropbox.throttle.refused).toBe(2);
    expect(dropbox.files.has('/a.json')).toBe(true);
  });

  it('gives up when it is throttled for good', async () => {
    dropbox.throttle.remaining = 99;
    await expect(store().put('a.json', text('1'))).rejects.toThrow('429');
  });

  it('refuses a revoked refresh token', async () => {
    const revoked = new DropboxStore('app-key', 'revoked', dropbox.hosts);
    await expect(revoked.get('a.json')).rejects.toThrow('Dropbox refused the sign-in');
  });

  it('refuses paths that are not the library’s own', async () => {
    await expect(store().put('../x', text('x'))).rejects.toThrow('Invalid path');
  });
});

describe('dropboxAuthorize', () => {
  /** The browser: opens the address, and follows where Dropbox sends the user. */
  const browser = (answer: 'approve' | 'deny') => (url: string) => {
    const back = dropbox.approve(url);
    if (answer === 'deny') {
      const denied = new URL(back);
      denied.searchParams.delete('code');
      denied.searchParams.set('error', 'access_denied');
      void fetch(denied);
      return;
    }
    void fetch(back);
  };

  it('returns a refresh token after the user approves', async () => {
    const token = await dropboxAuthorize(
      'app-key',
      browser('approve'),
      new AbortController().signal,
      dropbox.hosts,
      0,
    );
    expect(token).toBe('refresh-1');
    // And that token opens the store.
    await new DropboxStore('app-key', token, dropbox.hosts).put('a.json', text('ok'));
  });

  it('asks for the app’s own folder access with PKCE, offline', async () => {
    let asked = new URL('http://x');
    await dropboxAuthorize(
      'app-key',
      (url) => {
        asked = new URL(url);
        void fetch(dropbox.approve(url));
      },
      new AbortController().signal,
      dropbox.hosts,
      0,
    );
    expect(asked.searchParams.get('client_id')).toBe('app-key');
    expect(asked.searchParams.get('code_challenge_method')).toBe('S256');
    expect(asked.searchParams.get('token_access_type')).toBe('offline');
    expect(asked.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('fails when the user says no', async () => {
    await expect(
      dropboxAuthorize('app-key', browser('deny'), new AbortController().signal, dropbox.hosts, 0),
    ).rejects.toThrow('access_denied');
  });

  it('ignores a request that does not carry the state, then still finishes', async () => {
    const token = await dropboxAuthorize(
      'app-key',
      (url) => {
        const back = new URL(dropbox.approve(url));
        void fetch(`${back.origin}/?code=stolen&state=wrong`).then(() => fetch(back));
      },
      new AbortController().signal,
      dropbox.hosts,
      0,
    );
    expect(token).toBe('refresh-1');
  });

  it('stops when cancelled', async () => {
    const cancel = new AbortController();
    const result = dropboxAuthorize(
      'app-key',
      () => setTimeout(() => cancel.abort(), 20),
      cancel.signal,
      dropbox.hosts,
      0,
    );
    await expect(result).rejects.toThrow('cancelled');
  });

  it('needs an app key', async () => {
    await expect(
      dropboxAuthorize('', () => undefined, new AbortController().signal, dropbox.hosts, 0),
    ).rejects.toThrow('no Dropbox app key');
  });
});
