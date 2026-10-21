import { assertPath, type RemoteEntry, type SyncStore } from '../../shared/sync-store';

/** The folder in the user's files that holds everything this app syncs. */
export const NEXTCLOUD_FOLDER = 'PDF Reader';
const TIMEOUT_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const USER_AGENT = 'PDF Reader';

const withSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

/** Where a Nextcloud user's files can be reached by WebDAV. */
export const nextcloudDavBase = (server: string, user: string): string =>
  `${withSlash(server)}remote.php/dav/files/${encodeURIComponent(user)}/`;

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * The children in a PROPFIND answer. Servers differ in the namespace prefix they use, so the tags
 * are matched without one. `dir` is the folder that was asked about, which the answer lists first.
 */
export function parsePropfind(xml: string, dir: URL): RemoteEntry[] {
  const own = withSlash(decode(dir.pathname));
  const entries: RemoteEntry[] = [];
  for (const block of xml.split(/<(?:\w+:)?response[\s>]/u).slice(1)) {
    const href = /<(?:\w+:)?href>([^<]*)</u.exec(block)?.[1];
    if (!href) continue;
    let path = decode(href);
    if (/^https?:\/\//u.test(path)) path = new URL(path).pathname;
    const folder = /<(?:\w+:)?collection\s*\/?>/u.test(block);
    if (withSlash(path) === own) continue;
    const name = path.replace(/\/$/u, '').split('/').pop() ?? '';
    const size = Number(/<(?:\w+:)?getcontentlength>(\d+)</u.exec(block)?.[1] ?? 0);
    if (name) entries.push({ name, folder, size });
  }
  return entries;
}

function fail(response: Response, what: string): never {
  throw new Error(`The server refused ${what}: ${response.status} ${response.statusText}`.trim());
}

/** Nextcloud, ownCloud and any other WebDAV server. Files live in one folder under the user's own. */
export class WebDavStore implements SyncStore {
  private readonly made = new Set<string>();

  constructor(
    /** The WebDAV address of the user's files, ending in a slash. */
    private readonly base: string,
    private readonly user: string,
    private readonly password: string,
    private readonly folder = NEXTCLOUD_FOLDER,
  ) {}

  private url(path: string): URL {
    const parts = [this.folder, ...path.split('/').filter(Boolean)];
    return new URL(parts.map(encodeURIComponent).join('/'), this.base);
  }

  private request(url: URL, init: RequestInit): Promise<Response> {
    const auth = Buffer.from(`${this.user}:${this.password}`).toString('base64');
    return fetch(url, {
      ...init,
      headers: { Authorization: `Basic ${auth}`, 'User-Agent': USER_AGENT, ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** Creates the folders on the way to a file. MKCOL answers 405 for one that already exists. */
  private async ensureFolders(path: string): Promise<void> {
    const parts = [this.folder, ...path.split('/').slice(0, -1)];
    for (let i = 1; i <= parts.length; i++) {
      const relative = parts.slice(1, i).join('/');
      if (this.made.has(relative)) continue;
      const response = await this.request(this.url(relative), { method: 'MKCOL' });
      if (!response.ok && response.status !== 405)
        fail(response, `creating the folder ${relative || this.folder}`);
      this.made.add(relative);
    }
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    if (dir) assertPath(dir);
    const url = this.url(dir);
    const response = await this.request(url, { method: 'PROPFIND', headers: { Depth: '1' } });
    if (response.status === 404) return [];
    if (response.status !== 207) fail(response, `listing ${dir || 'the folder'}`);
    return parsePropfind(await response.text(), url);
  }

  async get(path: string): Promise<Uint8Array | null> {
    assertPath(path);
    const response = await this.request(this.url(path), { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) fail(response, `sending ${path}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    assertPath(path);
    await this.ensureFolders(path);
    const response = await this.request(this.url(path), { method: 'PUT', body: new Uint8Array(bytes) });
    if (!response.ok) fail(response, `saving ${path}`);
  }
}

export interface NextcloudLogin {
  user: string;
  password: string;
}

const sameOrigin = (a: URL, b: string): boolean => {
  try {
    return new URL(b).origin === a.origin;
  } catch {
    return false;
  }
};

/**
 * Nextcloud's Login Flow v2: the user signs in in the browser and approves this app, and the
 * server hands back an app password that can be revoked on its own. Nothing the user types
 * reaches this program.
 */
export async function nextcloudLogin(
  server: URL,
  openUrl: (url: string) => void,
  signal: AbortSignal,
  pollMs = 2000,
): Promise<NextcloudLogin> {
  const start = await fetch(new URL('index.php/login/v2', withSlash(server.href)), {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!start.ok) throw new Error(`This does not look like a Nextcloud server (${start.status})`);
  const flow = (await start.json()) as { poll?: { token?: unknown; endpoint?: unknown }; login?: unknown };
  const { token, endpoint } = flow.poll ?? {};
  // The server names the addresses to visit and poll; they must stay on the server the user typed.
  if (typeof token !== 'string' || typeof endpoint !== 'string' || typeof flow.login !== 'string') {
    throw new Error('The server answered the sign-in request in a way this app does not know');
  }
  if (!sameOrigin(server, endpoint) || !sameOrigin(server, flow.login)) {
    throw new Error('The server sent the sign-in to another address');
  }
  openUrl(flow.login);

  const deadline = AbortSignal.any([signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)]);
  while (!deadline.aborted) {
    const poll = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ token }),
      signal: deadline,
    });
    if (poll.ok) {
      const done = (await poll.json()) as { loginName?: unknown; appPassword?: unknown };
      if (typeof done.loginName !== 'string' || typeof done.appPassword !== 'string') {
        throw new Error('The server did not return an app password');
      }
      return { user: done.loginName, password: done.appPassword };
    }
    // 404 means the user has not approved yet.
    if (poll.status !== 404) throw new Error(`Sign-in failed: ${poll.status} ${poll.statusText}`.trim());
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(signal.aborted ? 'Sign-in cancelled' : 'Sign-in timed out');
}
