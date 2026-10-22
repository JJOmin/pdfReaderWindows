import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { selfSignedCertificate } from '../shared/certificate';
import {
  announcement,
  lanAddresses,
  pairingCode,
  parseBearer,
  parsePairRequest,
  parseRequest,
  PROTOCOL_VERSION,
  vpnInterfaces,
} from '../shared/pairing';
import { parseDeviceState, parseManifest, type Manifest } from '../shared/phone-library';
import { mergeNotes } from '../shared/notes-merge';
import { parseNotes } from '../shared/notes';
import type { NotesFile, PhoneServerStatus } from '../shared/types';

export const PHONE_PORT = 47613;
/** Administratively scoped, so routers keep it on the local network. */
export const ANNOUNCE_GROUP = '239.255.47.13';
const ANNOUNCE_MS = 2000;
/** The user has this long to answer "Pair with …?". */
const PAIR_TIMEOUT_MS = 60_000;
const MAX_STATE_BYTES = 4096;
const MAX_PAIR_BYTES = 1024;
/** A document's marks and comments: far more than anyone writes by hand. */
const MAX_NOTES_BYTES = 2 * 1024 * 1024;

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

interface PairedPhone {
  device: string;
  name: string;
  /** Only the token's hash is kept: the file alone does not let anyone in. */
  tokenHash: string;
  paired: number;
}

interface PhonesFile {
  enabled: boolean;
  phones: PairedPhone[];
}

export interface PhoneServerOptions {
  /** The user data folder: the identity and the paired phones are kept there. */
  dir: string;
  libraryRoot: string;
  /** The computer's name, shown in the phone's list of desktops. */
  name: string;
  box: { encrypt(text: string): string; decrypt(text: string): string };
  /** Asks the user whether to pair; resolves false when they decline or close the dialog. */
  askPair(phoneName: string): Promise<boolean>;
  /** The paired phones changed: a phone was paired. */
  onChange?(): void;
  /** A phone sent notes for a document; they were merged into the library's copy. */
  onNotes?(docId: string, merged: NotesFile): void;
  port?: number;
}

function parsePhones(value: unknown): PhonesFile {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const phones = Array.isArray(input.phones) ? input.phones : [];
  return {
    enabled: input.enabled === true,
    phones: phones.filter(
      (p): p is PairedPhone =>
        typeof p === 'object' &&
        p !== null &&
        /^[0-9a-f]{32}$/u.test((p as PairedPhone).device) &&
        typeof (p as PairedPhone).name === 'string' &&
        /^[0-9a-f]{64}$/u.test((p as PairedPhone).tokenHash) &&
        typeof (p as PairedPhone).paired === 'number',
    ),
  };
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const empty = (response: ServerResponse, status: number): void => {
  response.writeHead(status);
  response.end();
};

/** Reads a request body up to `max` bytes, or null when it is longer. */
function readBody(request: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        resolve(null);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  json: 'application/json',
  opus: 'audio/ogg',
};

/**
 * Serves the phone library to paired phones over TLS (ADR 7). Off by default. Pairing is answered
 * only while the Phone dialog is open, one phone at a time, and only after the user accepts.
 */
export class PhoneServer {
  private server: Server | undefined;
  private readonly sockets = new Map<string, Socket>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private identity: { cert: Buffer; key: string; fingerprint: string } | undefined;
  private phones: PhonesFile | undefined;
  private pairingOpen = false;
  private pairing = false;
  private error = '';

  constructor(private readonly options: PhoneServerOptions) {}

  private get port(): number {
    return this.options.port ?? PHONE_PORT;
  }

  private get phonesPath(): string {
    return join(this.options.dir, 'phones.json');
  }

  private async loadPhones(): Promise<PhonesFile> {
    if (!this.phones) {
      try {
        this.phones = parsePhones(JSON.parse(await readFile(this.phonesPath, 'utf8')));
      } catch {
        this.phones = parsePhones(null);
      }
    }
    return this.phones;
  }

  private async savePhones(): Promise<void> {
    await writeFile(this.phonesPath, JSON.stringify(this.phones, null, 2));
  }

  /** The certificate and key, made once and kept; the key encrypted by the operating system. */
  private async loadIdentity(): Promise<{ cert: Buffer; key: string; fingerprint: string }> {
    if (this.identity) return this.identity;
    const path = join(this.options.dir, 'phone-identity.json');
    let made: { cert: Buffer; key: string };
    try {
      const file = JSON.parse(await readFile(path, 'utf8')) as { cert: string; key: string };
      made = { cert: Buffer.from(file.cert, 'base64'), key: this.options.box.decrypt(file.key) };
    } catch {
      // No identity yet, or one that cannot be read: a new one means pairing phones again.
      made = this.makeIdentity();
      await writeFile(
        path,
        JSON.stringify({ cert: made.cert.toString('base64'), key: this.options.box.encrypt(made.key) }),
      );
    }
    this.identity = { ...made, fingerprint: createHash('sha256').update(made.cert).digest('hex') };
    return this.identity;
  }

  private makeIdentity(): { cert: Buffer; key: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const now = new Date();
    const cert = selfSignedCertificate({
      spki: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
      serial: randomBytes(16),
      name: `PDF Reader on ${this.options.name}`,
      notBefore: now,
      notAfter: new Date(Date.UTC(now.getUTCFullYear() + 100, 0, 1)),
      sign: (tbs) => new Uint8Array(sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })),
    });
    return { cert: Buffer.from(cert), key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  }

  async status(): Promise<PhoneServerStatus> {
    const { enabled, phones } = await this.loadPhones();
    const identity = enabled ? await this.loadIdentity() : undefined;
    return {
      enabled,
      running: this.server?.listening ?? false,
      error: this.error,
      code: identity ? pairingCode(identity.fingerprint) : '',
      port: this.port,
      addresses: lanAddresses(networkInterfaces()),
      vpn: vpnInterfaces(networkInterfaces()),
      phones: phones.map(({ device, name, paired }) => ({ device, name, paired })),
    };
  }

  /** Starts the server if it was switched on before. Called once when the app starts. */
  async start(): Promise<void> {
    if ((await this.loadPhones()).enabled) await this.listen();
  }

  async setEnabled(on: unknown): Promise<PhoneServerStatus> {
    if (typeof on !== 'boolean') throw new Error('Invalid switch');
    const phones = await this.loadPhones();
    phones.enabled = on;
    await this.savePhones();
    if (on) await this.listen();
    else this.close();
    return this.status();
  }

  /** The Phone dialog is open: only then are pairing requests answered. */
  setPairing(open: unknown): void {
    this.pairingOpen = open === true;
  }

  async remove(device: unknown): Promise<PhoneServerStatus> {
    const phones = await this.loadPhones();
    phones.phones = phones.phones.filter((p) => p.device !== device);
    await this.savePhones();
    return this.status();
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }

  private async listen(): Promise<void> {
    if (this.server) return;
    const { cert, key } = await this.loadIdentity();
    const pem = new X509Certificate(cert).toString();
    const server = createServer({ cert: pem, key }, (request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) empty(response, 500);
        else response.destroy();
      });
    });
    this.error = '';
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '0.0.0.0', resolve);
      });
    } catch (error) {
      this.error =
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `Port ${this.port} is used by another program`
          : String(error);
      return;
    }
    this.server = server;
    this.announce();
  }

  /**
   * Multicasts on every network the computer is on, so the phone finds it whichever one it shares.
   * One socket per address: on Windows, choosing the interface on a shared socket still sent every
   * packet out of one adapter (measured 2026-10-21, a Hyper-V adapter beside the Wi-Fi).
   */
  private announce(): void {
    const message = announcement(this.options.name, this.port);
    const send = (): void => {
      const addresses = new Set(
        Object.values(networkInterfaces())
          .flat()
          .filter((a) => a && a.family === 'IPv4')
          .map((a) => a!.address),
      );
      // Networks come and go, as when the Wi-Fi reconnects.
      for (const [address, socket] of this.sockets) {
        if (!addresses.has(address)) {
          socket.close();
          this.sockets.delete(address);
        }
      }
      for (const address of addresses) {
        const known = this.sockets.get(address);
        if (known) {
          known.send(message, this.port, ANNOUNCE_GROUP, () => undefined);
          continue;
        }
        const socket = createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', () => undefined);
        socket.bind(0, address, () => {
          socket.setMulticastTTL(1);
          socket.setMulticastLoopback(true);
          socket.setMulticastInterface(address);
          socket.send(message, this.port, ANNOUNCE_GROUP, () => undefined);
        });
        this.sockets.set(address, socket);
      }
    };
    send();
    this.timer = setInterval(send, ANNOUNCE_MS);
  }

  private async phoneFor(request: IncomingMessage): Promise<PairedPhone | undefined> {
    const token = parseBearer(request.headers.authorization);
    if (!token) return undefined;
    const tokenHash = hash(token);
    return (await this.loadPhones()).phones.find((p) => p.tokenHash === tokenHash);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = parseRequest(request.method ?? '', request.url ?? '');
    if (!parsed) return empty(response, 404);
    if (parsed.kind === 'hello') {
      return json(response, 200, { app: 'pdfreader', protocol: PROTOCOL_VERSION, name: this.options.name });
    }
    if (parsed.kind === 'pair') return this.pair(request, response);

    const phone = await this.phoneFor(request);
    if (!phone) return empty(response, 401);
    const root = this.options.libraryRoot;

    if (parsed.kind === 'library') {
      const documents: Manifest[] = [];
      for (const docId of existsSync(root) ? await readdir(root) : []) {
        const manifest = await this.manifest(docId);
        if (manifest) documents.push(manifest);
      }
      return json(response, 200, documents);
    }
    // Only a whole document is served: the manifest is written last.
    if (!(await this.manifest(parsed.docId))) return empty(response, 404);
    const folder = join(root, parsed.docId);

    if (parsed.kind === 'file') {
      const path = join(folder, ...parsed.file.split('/'));
      const size = await stat(path).then(
        (s) => (s.isFile() ? s.size : -1),
        () => -1,
      );
      if (size < 0) return empty(response, 404);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[parsed.file.split('.').pop()!]!,
        'content-length': size,
      });
      createReadStream(path).pipe(response);
      return;
    }
    if (parsed.kind === 'getNotes') {
      const notes = await this.readNotes(parsed.docId);
      return notes ? json(response, 200, notes) : empty(response, 404);
    }
    if (parsed.kind === 'putNotes') {
      const body = await readBody(request, MAX_NOTES_BYTES);
      if (!body) return empty(response, 413);
      let incoming: NotesFile | null;
      try {
        incoming = parseNotes(JSON.parse(body.toString('utf8')));
      } catch {
        incoming = null;
      }
      if (!incoming) return empty(response, 400);
      const held = await this.readNotes(parsed.docId);
      const merged = held ? mergeNotes(held, incoming) : incoming;
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'notes.json'), JSON.stringify(merged, null, 2));
      this.options.onNotes?.(parsed.docId, merged);
      return json(response, 200, merged);
    }
    if (parsed.kind === 'states') {
      const states = [];
      const dir = join(folder, 'state');
      for (const file of existsSync(dir) ? await readdir(dir) : []) {
        try {
          const state = parseDeviceState(JSON.parse(await readFile(join(dir, file), 'utf8')));
          if (state && file === `${state.device}.json`) states.push(state);
        } catch {
          // A state file that is not ours is left out.
        }
      }
      return json(response, 200, states);
    }
    // A phone writes its own place only, never another device's.
    if (parsed.device !== phone.device) return empty(response, 403);
    const body = await readBody(request, MAX_STATE_BYTES);
    if (!body) return empty(response, 413);
    let state;
    try {
      state = parseDeviceState(JSON.parse(body.toString('utf8')));
    } catch {
      state = null;
    }
    if (!state || state.device !== phone.device) return empty(response, 400);
    await mkdir(join(folder, 'state'), { recursive: true });
    await writeFile(join(folder, 'state', `${phone.device}.json`), JSON.stringify(state));
    return empty(response, 204);
  }

  private async readNotes(docId: string): Promise<NotesFile | null> {
    try {
      return parseNotes(
        JSON.parse(await readFile(join(this.options.libraryRoot, docId, 'notes.json'), 'utf8')),
      );
    } catch {
      return null;
    }
  }

  private async manifest(docId: string): Promise<Manifest | null> {
    if (!/^[0-9a-f]{64}$/u.test(docId)) return null;
    try {
      const manifest = parseManifest(
        JSON.parse(await readFile(join(this.options.libraryRoot, docId, 'manifest.json'), 'utf8')),
      );
      return manifest?.docId === docId ? manifest : null;
    } catch {
      return null;
    }
  }

  private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Answered only while the user is at the dialog to see the question, and one at a time.
    if (!this.pairingOpen) return empty(response, 404);
    if (this.pairing) return empty(response, 409);
    const body = await readBody(request, MAX_PAIR_BYTES);
    let asked;
    try {
      asked = body && parsePairRequest(JSON.parse(body.toString('utf8')));
    } catch {
      asked = null;
    }
    if (!asked) return empty(response, 400);
    this.pairing = true;
    try {
      const accepted = await Promise.race([
        this.options.askPair(asked.name),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PAIR_TIMEOUT_MS)),
      ]);
      if (!accepted) return empty(response, 403);
      const token = randomBytes(32).toString('hex');
      const phones = await this.loadPhones();
      phones.phones = [
        ...phones.phones.filter((p) => p.device !== asked.device),
        { device: asked.device, name: asked.name, tokenHash: hash(token), paired: Date.now() },
      ];
      await this.savePhones();
      this.options.onChange?.();
      json(response, 200, { token, name: this.options.name });
    } finally {
      this.pairing = false;
    }
  }
}
