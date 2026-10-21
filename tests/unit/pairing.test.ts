import { describe, expect, it } from 'vitest';
import {
  announcement,
  codeMatches,
  normalizeCode,
  pairingCode,
  parseAnnouncement,
  parseBearer,
  parsePairRequest,
  parseRequest,
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
