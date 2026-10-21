import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { assertPath, type RemoteEntry, type SyncStore } from '../../shared/sync-store';

/**
 * The key of the app registered at dropbox.com/developers, with the "App folder" access type, the
 * scopes files.content.read and files.content.write, and `http://127.0.0.1:53682/` as a redirect
 * address. It is public by design (PKCE needs no secret). PDFREADER_DROPBOX_KEY overrides it.
 */
export const DROPBOX_APP_KEY = process.env.PDFREADER_DROPBOX_KEY ?? '';
/** Dropbox only sends the user back to an address registered in advance, so the port is fixed. */
export const DROPBOX_REDIRECT_PORT = 53682;

export interface DropboxHosts {
  api: string;
  content: string;
  www: string;
}
const HOSTS: DropboxHosts = {
  api: 'https://api.dropboxapi.com',
  content: 'https://content.dropboxapi.com',
  www: 'https://www.dropbox.com',
};

const TIMEOUT_MS = 5 * 60_000;
/** The upload call takes at most 150 MB. A PDF larger than that is not synced. */
const MAX_UPLOAD = 150 * 1024 * 1024;
const MAX_RETRIES = 4;
const EXPIRY_MARGIN_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface TokenAnswer {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
}

async function tokenRequest(hosts: DropboxHosts, form: Record<string, string>): Promise<TokenAnswer> {
  const response = await fetch(`${hosts.api}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Dropbox refused the sign-in: ${response.status} ${await response.text()}`);
  return (await response.json()) as TokenAnswer;
}

/** Dropbox, in the app's own folder. The user's other files are out of its reach. */
export class DropboxStore implements SyncStore {
  private access = '';
  private expires = 0;

  constructor(
    private readonly appKey: string,
    private readonly refreshToken: string,
    private readonly hosts: DropboxHosts = HOSTS,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private async token(force: boolean): Promise<string> {
    if (force || Date.now() > this.expires - EXPIRY_MARGIN_MS) {
      const answer = await tokenRequest(this.hosts, {
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.appKey,
      });
      if (typeof answer.access_token !== 'string' || typeof answer.expires_in !== 'number') {
        throw new Error('Dropbox returned no access token');
      }
      this.access = answer.access_token;
      this.expires = Date.now() + answer.expires_in * 1000;
    }
    return this.access;
  }

  /** One call, with a fresh token after a 401 and a pause after a 429, as Dropbox asks. */
  private async call(
    url: string,
    init: RequestInit & { headers: Record<string, string> },
  ): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${await this.token(refreshed)}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      if (response.status === 429 && attempt < MAX_RETRIES) {
        await this.wait(Number(response.headers.get('Retry-After') ?? 1) * 1000);
        continue;
      }
      return response;
    }
  }

  private async fail(response: Response, what: string): Promise<never> {
    throw new Error(`Dropbox refused ${what}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    if (dir) assertPath(dir);
    const entries: RemoteEntry[] = [];
    let route = '/2/files/list_folder';
    let body: Record<string, unknown> = { path: dir ? `/${dir}` : '', recursive: false };
    for (;;) {
      const response = await this.call(this.hosts.api + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 409) {
        const text = await response.text();
        if (text.includes('not_found')) return [];
        throw new Error(`Dropbox refused listing ${dir}: ${text.slice(0, 300)}`);
      }
      if (!response.ok) return this.fail(response, `listing ${dir || 'the folder'}`);
      const page = (await response.json()) as {
        entries: { '.tag': string; name: string; size?: number }[];
        cursor: string;
        has_more: boolean;
      };
      for (const e of page.entries) {
        entries.push({ name: e.name, folder: e['.tag'] === 'folder', size: e.size ?? 0 });
      }
      if (!page.has_more) return entries;
      route = '/2/files/list_folder/continue';
      body = { cursor: page.cursor };
    }
  }

  async get(path: string): Promise<Uint8Array | null> {
    assertPath(path);
    const response = await this.call(`${this.hosts.content}/2/files/download`, {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path: `/${path}` }) },
    });
    if (response.status === 409) {
      const text = await response.text();
      if (text.includes('not_found')) return null;
      throw new Error(`Dropbox refused sending ${path}: ${text.slice(0, 300)}`);
    }
    if (!response.ok) return this.fail(response, `sending ${path}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    assertPath(path);
    if (bytes.length > MAX_UPLOAD) throw new Error(`${path} is too large for Dropbox (150 MB at most)`);
    const response = await this.call(`${this.hosts.content}/2/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: `/${path}`, mode: 'overwrite', mute: true }),
      },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) await this.fail(response, `saving ${path}`);
  }
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:3rem auto;max-width:30rem"><h1>${title}</h1><p>${text}</p>`;

/**
 * Signs in to Dropbox with the authorization-code flow and PKCE, as a desktop app should: the
 * browser comes back to a listener on this computer only, and no secret is built into the app.
 * Resolves to a refresh token. `port` 0 picks a free one, which only tests use.
 */
export async function dropboxAuthorize(
  appKey: string,
  openUrl: (url: string) => void,
  signal: AbortSignal,
  hosts: DropboxHosts = HOSTS,
  port = DROPBOX_REDIRECT_PORT,
): Promise<string> {
  if (!appKey) throw new Error('This build has no Dropbox app key');
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  const received: {
    promise: Promise<string>;
    resolve(code: string): void;
    reject(error: Error): void;
  } = { promise: undefined as never, resolve: () => undefined, reject: () => undefined };
  received.promise = new Promise<string>((resolve, reject) => {
    received.resolve = resolve;
    received.reject = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400).end(PAGE('Not expected', 'This address is not part of a sign-in.'));
      return;
    }
    const code = url.searchParams.get('code');
    if (code) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(PAGE('Signed in', 'You can close this tab and go back to PDF Reader.'));
      received.resolve(code);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(PAGE('Not signed in', 'Dropbox did not give access.'));
      received.reject(
        new Error(`Dropbox sign-in failed: ${url.searchParams.get('error') ?? 'no access given'}`),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is in use, so the Dropbox sign-in cannot come back to this app`)
          : error,
      ),
    );
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const redirect = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}/`;

  try {
    const query = new URLSearchParams({
      client_id: appKey,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      redirect_uri: redirect,
      state,
    });
    openUrl(`${hosts.www}/oauth2/authorize?${query.toString()}`);
    const stop = (): void => received.reject(new Error('Sign-in cancelled'));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(() => received.reject(new Error('Sign-in timed out')), 5 * 60_000);
    try {
      const code = await received.promise;
      const answer = await tokenRequest(hosts, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: appKey,
        redirect_uri: redirect,
      });
      if (typeof answer.refresh_token !== 'string') throw new Error('Dropbox returned no refresh token');
      return answer.refresh_token;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
