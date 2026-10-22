import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A small in-memory stand-in for Nextcloud, enough to run the real adapter against. */

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  where: { host?: string; port?: number } = {},
): Promise<Server> {
  const server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  return new Promise((resolve) =>
    server.listen(where.port ?? 0, where.host ?? '127.0.0.1', () => resolve(server)),
  );
}

const origin = (server: Server): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

export interface FakeNextcloud {
  url: string;
  /** Path under the user's files, without the folder prefix, to bytes. */
  files: Map<string, Buffer>;
  folders: Set<string>;
  /** The user opens the sign-in page and approves. */
  approve(): void;
  /** Addresses the app opened in a browser. */
  opened: string[];
  close(): Promise<void>;
}

/**
 * `host`, `port` and `publicUrl` let a device on the network reach it, as the phone's tests do:
 * the addresses it hands out must be the ones the phone typed. `approveAfterMs` plays the user.
 */
export interface FakeNextcloudOptions {
  host?: string;
  port?: number;
  publicUrl?: string;
  approveAfterMs?: number;
}

export async function fakeNextcloud(options: FakeNextcloudOptions = {}): Promise<FakeNextcloud> {
  const files = new Map<string, Buffer>();
  const folders = new Set<string>(['']);
  let approved = false;
  /** How often each file was written: its ETag, as a real server keeps one. */
  const versions = new Map<string, number>();
  const prefix = '/remote.php/dav/files/alice/';
  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const base = options.publicUrl ?? origin(server);
    if (url.pathname === '/index.php/login/v2' && req.method === 'POST') {
      if (options.approveAfterMs !== undefined) setTimeout(() => (approved = true), options.approveAfterMs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          poll: { token: 'poll-token', endpoint: `${base}/login/v2/poll` },
          login: `${base}/login/v2/flow/poll-token`,
        }),
      );
      return;
    }
    if (url.pathname === '/login/v2/poll' && req.method === 'POST') {
      const form = new URLSearchParams((await body(req)).toString());
      if (form.get('token') !== 'poll-token' || !approved) return void res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ server: base, loginName: 'alice', appPassword: 'app-pass' }));
      return;
    }
    if (!url.pathname.startsWith(prefix)) return void res.writeHead(404).end();
    if (req.headers.authorization !== `Basic ${Buffer.from('alice:app-pass').toString('base64')}`) {
      return void res.writeHead(401).end();
    }
    const path = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/$/u, '');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    switch (req.method) {
      case 'MKCOL':
        if (folders.has(path) || files.has(path)) return void res.writeHead(405).end();
        if (!folders.has(parent)) return void res.writeHead(409).end();
        folders.add(path);
        return void res.writeHead(201).end();
      case 'PUT':
        if (!folders.has(parent)) return void res.writeHead(409).end();
        files.set(path, await body(req));
        versions.set(path, (versions.get(path) ?? 0) + 1);
        return void res.writeHead(201).end();
      case 'GET': {
        const file = files.get(path);
        return void (file ? res.writeHead(200).end(file) : res.writeHead(404).end());
      }
      case 'PROPFIND': {
        if (!folders.has(path)) return void res.writeHead(404).end();
        const entry = (p: string, folder: boolean, size = 0): string =>
          `<d:response><d:href>${prefix}${p.split('/').map(encodeURIComponent).join('/')}${folder ? '/' : ''}</d:href>` +
          `<d:propstat><d:prop>${
            folder
              ? '<d:resourcetype><d:collection/></d:resourcetype>'
              : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getetag>"${p}-${versions.get(p) ?? 0}"</d:getetag>`
          }</d:prop></d:propstat></d:response>`;
        const inside = (p: string): boolean =>
          p !== path && p.slice(0, p.lastIndexOf('/')) === path && p !== '';
        const children = [
          ...[...folders].filter((f) => inside(f) || (path === '' && f !== '' && !f.includes('/'))),
          ...[...files.keys()].filter((f) => inside(f) || (path === '' && !f.includes('/'))),
        ];
        const xml =
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entry(path, true)}` +
          children.map((c) => entry(c, folders.has(c), files.get(c)?.length)).join('') +
          '</d:multistatus>';
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return void res.end(xml);
      }
      default:
        return void res.writeHead(405).end();
    }
  }, options);
  return {
    url: options.publicUrl ?? origin(server),
    files,
    folders,
    approve: () => void (approved = true),
    opened: [],
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
