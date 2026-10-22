import { describe, expect, it } from 'vitest';
import {
  announcement,
  changesSince,
  codeMatches,
  lanAddresses,
  normalizeCode,
  pairingCode,
  pairingUrl,
  parseAnnouncement,
  parseBearer,
  parsePairRequest,
  parsePairingUrl,
  parseRequest,
  vpnInterfaces,
} from '../../src/shared/pairing';

const FINGERPRINT = '9c1e4d7a03bb5f2e' + 'ab'.repeat(24);
const DOC = 'd'.repeat(64);
const KEY = 'a'.repeat(40);
const DEVICE = 'c'.repeat(32);

describe('pairingCode', () => {
  it('is the first 60 bits of the fingerprint in Crockford base32, in groups of four', () => {
    // 0x9c1e4d7a03bb5f2 = 703190327584388594 in 12 five-bit digits.
    const code = pairingCode(FINGERPRINT);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
    const value = [...code.replaceAll('-', '')].reduce(
      (n, c) => n * 32n + BigInt('0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c)),
      0n,
    );
    expect(value.toString(16)).toBe('9c1e4d7a03bb5f2');
  });

  it('is the same with upper-case hex', () => {
    expect(pairingCode(FINGERPRINT.toUpperCase())).toBe(pairingCode(FINGERPRINT));
  });
});

describe('normalizeCode and codeMatches', () => {
  const code = pairingCode(FINGERPRINT);

  it('accepts the code as typed: any case, without dashes, with the letters Crockford reads as digits', () => {
    expect(normalizeCode(code.toLowerCase())).toBe(code.replaceAll('-', ''));
    expect(normalizeCode(` ${code.replaceAll('-', '')} `)).toBe(code.replaceAll('-', ''));
    expect(normalizeCode('oil0-1111-1111')).toBe('011011111111');
  });

  it('rejects a code that is too short, too long or has a letter Crockford leaves out', () => {
    expect(normalizeCode('ABCD-EFGH-JKM')).toBeNull();
    expect(normalizeCode('ABCD-EFGH-JKMNP')).toBeNull();
    expect(normalizeCode('ABCD-EFGH-JKMU')).toBeNull();
  });

  it('matches only the certificate the code was made from', () => {
    expect(codeMatches(FINGERPRINT, code)).toBe(true);
    expect(codeMatches('0' + FINGERPRINT.slice(1), code)).toBe(false);
    expect(codeMatches(FINGERPRINT, 'nonsense')).toBe(false);
  });
});

describe('parseRequest', () => {
  it('knows the requests of ADR 7 section 7', () => {
    expect(parseRequest('GET', '/v1/hello')).toEqual({ kind: 'hello' });
    expect(parseRequest('POST', '/v1/pair')).toEqual({ kind: 'pair' });
    expect(parseRequest('GET', '/v1/library')).toEqual({ kind: 'library' });
    expect(parseRequest('GET', `/v1/doc/${DOC}/document.pdf`)).toEqual({
      kind: 'file',
      docId: DOC,
      file: 'document.pdf',
    });
    expect(parseRequest('GET', `/v1/doc/${DOC}/manifest.json`)?.kind).toBe('file');
    expect(parseRequest('GET', `/v1/doc/${DOC}/pages/12.json`)).toEqual({
      kind: 'file',
      docId: DOC,
      file: 'pages/12.json',
    });
    expect(parseRequest('GET', `/v1/doc/${DOC}/audio/${KEY}.opus`)?.kind).toBe('file');
    expect(parseRequest('GET', `/v1/doc/${DOC}/state`)).toEqual({ kind: 'states', docId: DOC });
    expect(parseRequest('GET', `/v1/doc/${DOC}/notes`)).toEqual({ kind: 'getNotes', docId: DOC });
    expect(parseRequest('PUT', `/v1/doc/${DOC}/notes`)).toEqual({ kind: 'putNotes', docId: DOC });
    expect(parseRequest('PUT', `/v1/doc/${DOC}/state/${DEVICE}`)).toEqual({
      kind: 'putState',
      docId: DOC,
      device: DEVICE,
    });
  });

  it('knows nothing else, so no path is ever taken from a request', () => {
    const bad: [string, string][] = [
      ['POST', '/v1/hello'],
      ['GET', '/v1/pair'],
      ['GET', '/v1/hello?x=1'],
      ['GET', `/v1/doc/${DOC}/../manifest.json`],
      ['GET', `/v1/doc/${DOC}/%2e%2e/x`],
      ['GET', `/v1/doc/${DOC.toUpperCase()}/manifest.json`],
      ['GET', `/v1/doc/${DOC}/pages/0x1.json`],
      ['GET', `/v1/doc/${DOC}/pages/0.json`],
      ['GET', `/v1/doc/${DOC}/audio/${KEY}.wav`],
      ['GET', `/v1/doc/${DOC}/state/${DEVICE}`],
      ['PUT', `/v1/doc/${DOC}/state/${DEVICE}x`],
      ['GET', `/v1/doc/${DOC}/notes.json`],
      ['POST', `/v1/doc/${DOC}/notes`],
      ['DELETE', `/v1/doc/${DOC}/notes`],
      ['PUT', `/v1/doc/${'g'.repeat(64)}/notes`],
      ['DELETE', `/v1/doc/${DOC}/document.pdf`],
    ];
    for (const [method, url] of bad) expect(parseRequest(method, url), `${method} ${url}`).toBeNull();
  });
});

describe('parseBearer', () => {
  it('takes a 64-digit hex token from the Authorization header', () => {
    expect(parseBearer(`Bearer ${'f'.repeat(64)}`)).toBe('f'.repeat(64));
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(`Bearer ${'f'.repeat(63)}`)).toBeNull();
    expect(parseBearer(`Basic ${'f'.repeat(64)}`)).toBeNull();
  });
});

describe('parsePairRequest', () => {
  it('takes the phone’s id and a printable name of at most 64 characters', () => {
    expect(parsePairRequest({ device: DEVICE, name: 'Galaxy S20 FE' })).toEqual({
      device: DEVICE,
      name: 'Galaxy S20 FE',
    });
    expect(parsePairRequest({ device: DEVICE, name: '  Galaxy  ' })?.name).toBe('Galaxy');
    expect(parsePairRequest({ device: 'x', name: 'a' })).toBeNull();
    expect(parsePairRequest({ device: DEVICE, name: '' })).toBeNull();
    expect(parsePairRequest({ device: DEVICE, name: 'x'.repeat(65) })).toBeNull();
    expect(parsePairRequest({ device: DEVICE, name: 'a\u0000b' })).toBeNull();
    expect(parsePairRequest(null)).toBeNull();
  });
});

describe('announcement', () => {
  it('round-trips, and refuses anything that is not ours', () => {
    const bytes = announcement('Desk', 47613);
    expect(parseAnnouncement(bytes)).toEqual({ name: 'Desk', port: 47613 });
    expect(parseAnnouncement(new TextEncoder().encode('{"app":"other","protocol":1}'))).toBeNull();
    expect(parseAnnouncement(new TextEncoder().encode('not json'))).toBeNull();
    expect(
      parseAnnouncement(new TextEncoder().encode('{"app":"pdfreader","protocol":1,"name":"x","port":70000}')),
    ).toBeNull();
  });
});

describe('vpnInterfaces and lanAddresses', () => {
  const v4 = (address: string, internal = false) => ({ family: 'IPv4', address, internal });
  const v6 = (address: string) => ({ family: 'IPv6', address, internal: false });

  it('names a tunnel that carries IPv4, on the Mac and on Windows', () => {
    const mac = {
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('192.168.1.215')],
      // The Mac always has a few tunnels for its own services; with only IPv6 they are no VPN.
      utun0: [v6('fe80::1')],
      utun18: [v4('10.14.0.2')],
    };
    expect(vpnInterfaces(mac)).toEqual(['utun18']);
    const windows = {
      'Wi-Fi': [v4('192.168.1.20')],
      'Surfshark WireGuard': [v4('10.14.0.2')],
      'vEthernet (Default Switch)': [v4('172.20.0.1')],
    };
    expect(vpnInterfaces(windows)).toEqual(['Surfshark WireGuard']);
  });

  it('finds none on a plain network', () => {
    expect(
      vpnInterfaces({ en0: [v4('192.168.1.215')], utun1: [v6('fe80::2')], lo0: [v4('127.0.0.1', true)] }),
    ).toEqual([]);
  });

  it('lists the addresses a phone can type, without loopback and tunnels', () => {
    expect(
      lanAddresses({
        lo0: [v4('127.0.0.1', true)],
        en0: [v4('192.168.1.215'), v6('fe80::3')],
        utun18: [v4('10.14.0.2')],
        wg0: [v4('10.8.0.2')],
      }),
    ).toEqual(['192.168.1.215']);
  });
});

describe('pairing URL', () => {
  const SECRET = '0123456789abcdef'.repeat(2);
  const made = {
    name: 'Leos MacBook',
    addresses: ['192.168.1.20', '10.0.0.5'],
    port: 47613,
    code: 'ABCD-EFGH-JKMN',
    secret: SECRET,
  };
  // The phone's Dart port is tested with this very string.
  const GOLDEN =
    'pdfreader://pair?v=1&name=Leos%20MacBook&addr=192.168.1.20:47613,10.0.0.5:47613&code=ABCD-EFGH-JKMN&secret=' +
    SECRET;

  it('holds the addresses, the code and the one-time secret', () => {
    expect(pairingUrl(made)).toBe(GOLDEN);
  });

  it('is read back, whatever the name holds', () => {
    expect(parsePairingUrl(GOLDEN)).toEqual({
      name: 'Leos MacBook',
      addresses: [
        { host: '192.168.1.20', port: 47613 },
        { host: '10.0.0.5', port: 47613 },
      ],
      code: 'ABCD-EFGH-JKMN',
      secret: SECRET,
    });
    const odd = pairingUrl({ ...made, name: 'Léo & “Mac”, 15%' });
    expect(parsePairingUrl(odd)?.name).toBe('Léo & “Mac”, 15%');
  });

  it('refuses anything that is not ours', () => {
    for (const bad of [
      '',
      'https://pair?v=1',
      GOLDEN.replace('v=1', 'v=2'),
      GOLDEN.replace('pdfreader://pair', 'pdfreader://other'),
      GOLDEN.replace('192.168.1.20:47613,10.0.0.5:47613', 'evil.example.com:47613'),
      GOLDEN.replace('47613,10', '99999,10'),
      GOLDEN.replace('ABCD-EFGH-JKMN', 'ABCD'),
      GOLDEN.replace(SECRET, 'short'),
      GOLDEN.replace(/&addr=[^&]*/u, ''),
    ]) {
      expect(parsePairingUrl(bad), bad).toBeNull();
    }
  });

  it('is a pair request that may carry the secret', () => {
    expect(parsePairRequest({ device: DEVICE, name: 'Phone', secret: SECRET })).toEqual({
      device: DEVICE,
      name: 'Phone',
      secret: SECRET,
    });
    expect(parsePairRequest({ device: DEVICE, name: 'Phone' })).toEqual({ device: DEVICE, name: 'Phone' });
    expect(parsePairRequest({ device: DEVICE, name: 'Phone', secret: 'nope' })).toBeNull();
  });
});

describe('changes since', () => {
  it('is a request of version 2, with a time', () => {
    expect(parseRequest('GET', '/v1/changes?since=1792658000000')).toEqual({
      kind: 'changes',
      since: 1792658000000,
    });
    expect(parseRequest('GET', '/v1/changes?since=0')).toEqual({ kind: 'changes', since: 0 });
    for (const bad of [
      '/v1/changes',
      '/v1/changes?since=-1',
      '/v1/changes?since=1e9',
      '/v1/changes?since=1&x=2',
    ]) {
      expect(parseRequest('GET', bad), bad).toBeNull();
    }
    expect(parseRequest('POST', '/v1/changes?since=1')).toBeNull();
  });

  it('names only the documents with a part changed at or after the time, and the time to ask from next', () => {
    const docs = {
      [DOC]: { manifest: 10, notes: 50, state: 20 },
      ['e'.repeat(64)]: { manifest: 10, notes: 0, state: 30 },
    };
    expect(changesSince(docs, 40, 99)).toEqual({ now: 99, docs: { [DOC]: docs[DOC] } });
    expect(Object.keys(changesSince(docs, 0, 99).docs)).toHaveLength(2);
    expect(Object.keys(changesSince(docs, 50, 99).docs)).toEqual([DOC]);
    expect(changesSince(docs, 51, 99).docs).toEqual({});
  });

  it('asks for the inbox and says an offer is handled', () => {
    expect(parseRequest('GET', '/v1/inbox')).toEqual({ kind: 'inbox' });
    expect(parseRequest('DELETE', `/v1/inbox/${DOC}`)).toEqual({ kind: 'handled', docId: DOC });
    expect(parseRequest('DELETE', '/v1/inbox/x')).toBeNull();
    expect(parseRequest('GET', `/v1/inbox/${DOC}`)).toBeNull();
  });

  it('keeps announcing version 1, which older phones check for', () => {
    expect(parseAnnouncement(announcement('PC', 47613))).toEqual({ name: 'PC', port: 47613 });
    expect(JSON.parse(new TextDecoder().decode(announcement('PC', 1)))).toMatchObject({ protocol: 1 });
  });
});
