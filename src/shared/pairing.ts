/**
 * The phone server's protocol (ADR 7 sections 5 to 7): the pairing code, what a request may ask
 * for, and the UDP announcement. Pure logic: the server in `src/main/phone-server.ts` and the
 * phone's Dart port both follow it.
 */

export const PROTOCOL_VERSION = 1;
const APP = 'pdfreader';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 60 bits: an attacker needs about 10^18 key generations to match them (ADR 7 section 6). */
const CODE_HEX_DIGITS = 15;
const CODE_LENGTH = 12;

const DOC_ID = '[0-9a-f]{64}';
const DEVICE_ID = /^[0-9a-f]{32}$/u;
const TOKEN = /^Bearer ([0-9a-f]{64})$/u;

/** The code the dialog shows: the fingerprint's first 60 bits in Crockford base32, as XXXX-XXXX-XXXX. */
export function pairingCode(fingerprintHex: string): string {
  let value = BigInt(`0x${fingerprintHex.slice(0, CODE_HEX_DIGITS)}`);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code = CROCKFORD[Number(value & 31n)]! + code;
    value >>= 5n;
  }
  return code.match(/.{4}/gu)!.join('-');
}

/** A typed code without dashes, or null. Crockford reads O as 0 and I and L as 1, so typos pass. */
export function normalizeCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/gu, '').replaceAll('O', '0').replace(/[IL]/gu, '1');
  if (code.length !== CODE_LENGTH || [...code].some((c) => !CROCKFORD.includes(c))) return null;
  return code;
}

/** Whether a certificate with this fingerprint is the one the typed code was made from. */
export function codeMatches(fingerprintHex: string, typed: string): boolean {
  const code = normalizeCode(typed);
  return code !== null && pairingCode(fingerprintHex.toLowerCase()).replaceAll('-', '') === code;
}

/** A library file a phone may fetch. The path on disk is built from these parts only. */
export type LibraryFile = 'document.pdf' | 'manifest.json' | `pages/${number}.json` | `audio/${string}.opus`;

export type PhoneRequest =
  | { kind: 'hello' }
  | { kind: 'pair' }
  | { kind: 'library' }
  | { kind: 'file'; docId: string; file: LibraryFile }
  | { kind: 'states'; docId: string }
  | { kind: 'putState'; docId: string; device: string }
  | { kind: 'getNotes'; docId: string }
  | { kind: 'putNotes'; docId: string };

const FILE = new RegExp(
  `^/v1/doc/(${DOC_ID})/(document\\.pdf|manifest\\.json|pages/[1-9][0-9]{0,4}\\.json|audio/[0-9a-f]{40}\\.opus)$`,
  'u',
);
const STATES = new RegExp(`^/v1/doc/(${DOC_ID})/state$`, 'u');
const NOTES = new RegExp(`^/v1/doc/(${DOC_ID})/notes$`, 'u');
const PUT_STATE = new RegExp(`^/v1/doc/(${DOC_ID})/state/([0-9a-f]{32})$`, 'u');

/** What a request asks for, or null for anything else, which is answered with 404. */
export function parseRequest(method: string, url: string): PhoneRequest | null {
  if (method === 'GET' && url === '/v1/hello') return { kind: 'hello' };
  if (method === 'POST' && url === '/v1/pair') return { kind: 'pair' };
  if (method === 'GET' && url === '/v1/library') return { kind: 'library' };
  if (method === 'GET') {
    const file = FILE.exec(url);
    if (file) return { kind: 'file', docId: file[1]!, file: file[2] as LibraryFile };
    const states = STATES.exec(url);
    if (states) return { kind: 'states', docId: states[1]! };
    const notes = NOTES.exec(url);
    if (notes) return { kind: 'getNotes', docId: notes[1]! };
  }
  if (method === 'PUT') {
    const put = PUT_STATE.exec(url);
    if (put) return { kind: 'putState', docId: put[1]!, device: put[2]! };
    const notes = NOTES.exec(url);
    if (notes) return { kind: 'putNotes', docId: notes[1]! };
  }
  return null;
}

/** The token from `Authorization: Bearer <64 hex>`, or null. */
export function parseBearer(header: string | undefined): string | null {
  return TOKEN.exec(header ?? '')?.[1] ?? null;
}

export interface PairRequest {
  /** The phone's random id, which names its state file. */
  device: string;
  /** Shown in "Pair with …?" and in the list of paired phones. */
  name: string;
  /** From the QR code on the desktop's screen: proof that the phone saw it just now (ADR 10 section 5). */
  secret?: string;
}

const SECRET = /^[0-9a-f]{32}$/u;

export function parsePairRequest(value: unknown): PairRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const { device, name, secret } = value as Record<string, unknown>;
  if (typeof device !== 'string' || !DEVICE_ID.test(device) || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > 64 || /\p{Cc}/u.test(trimmed)) return null;
  if (secret === undefined) return { device, name: trimmed };
  return typeof secret === 'string' && SECRET.test(secret) ? { device, name: trimmed, secret } : null;
}

/**
 * What the QR code holds (ADR 10 section 5): the addresses, so that the phone needs no multicast; the
 * code, which pins the certificate exactly as when it is typed; and the one-time secret.
 */
export function pairingUrl(parts: {
  name: string;
  addresses: string[];
  port: number;
  code: string;
  secret: string;
}): string {
  const addr = parts.addresses.map((a) => `${a}:${parts.port}`).join(',');
  return `pdfreader://pair?v=1&name=${encodeURIComponent(parts.name)}&addr=${addr}&code=${parts.code}&secret=${parts.secret}`;
}

export interface PairingUrl {
  name: string;
  addresses: { host: string; port: number }[];
  code: string;
  secret: string;
}

const ADDRESS = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/u;

/** Reads what a scanned QR code holds, or null when it is not a pairing code of this app. */
export function parsePairingUrl(text: string): PairingUrl | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'pdfreader:' || url.hostname !== 'pair') return null;
  const get = (key: string): string | null => url.searchParams.get(key);
  const name = get('name');
  const code = get('code');
  const secret = get('secret');
  if (get('v') !== '1' || !name || name.length > 64 || !code || normalizeCode(code) === null) return null;
  if (!secret || !SECRET.test(secret)) return null;
  const addresses: { host: string; port: number }[] = [];
  for (const entry of (get('addr') ?? '').split(',')) {
    const match = ADDRESS.exec(entry);
    const port = Number(match?.[2]);
    if (!match || port < 1 || port > 65535) return null;
    addresses.push({ host: match[1]!, port });
  }
  return addresses.length > 0 ? { name, addresses, code, secret } : null;
}

/** What the desktop multicasts every two seconds while phone sync is on (ADR 7 section 5). */
export const announcement = (name: string, port: number): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ app: APP, protocol: PROTOCOL_VERSION, name, port }));

export function parseAnnouncement(bytes: Uint8Array): { name: string; port: number } | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const { app, protocol, name, port } = value;
    if (app !== APP || protocol !== PROTOCOL_VERSION || typeof name !== 'string') return null;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
    return { name, port: port as number };
  } catch {
    return null;
  }
}

/** What `os.networkInterfaces()` returns, reduced to what is used here. */
export type Interfaces = Record<string, { family: string; address: string; internal: boolean }[] | undefined>;

/**
 * Tunnels by name: utun, tun, tap, wg, ppp and ipsec on the Mac and Linux; on Windows the adapter's
 * name, which the VPN chooses. The Mac keeps utun interfaces with IPv6 only for its own services.
 */
const TUNNEL =
  /^(utun|tun|tap|wg|ppp|ipsec)\d+$|vpn|wireguard|surfshark|nordlynx|proton|openvpn|tailscale|zerotier|wintun|tap-windows/iu;

const hasIPv4 = (list: Interfaces[string]): boolean =>
  (list ?? []).some((a) => a.family === 'IPv4' && !a.internal);

/**
 * Interfaces that look like a VPN carrying IPv4. While one is on, replies to the phone often go
 * into the tunnel instead of the Wi-Fi: the phone hears the announcement but cannot connect.
 */
export const vpnInterfaces = (interfaces: Interfaces): string[] =>
  Object.entries(interfaces)
    .filter(([name, list]) => TUNNEL.test(name) && hasIPv4(list))
    .map(([name]) => name);

/** This computer's IPv4 addresses a phone on the same network can type: no loopback, no tunnels. */
export const lanAddresses = (interfaces: Interfaces): string[] =>
  Object.entries(interfaces)
    .filter(([name]) => !TUNNEL.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
