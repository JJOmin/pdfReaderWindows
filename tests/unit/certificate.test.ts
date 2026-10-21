import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { derLength, derTime, selfSignedCertificate } from '../../src/shared/certificate';

describe('derLength', () => {
  it('uses one byte below 128 and long form above', () => {
    expect([...derLength(5)]).toEqual([5]);
    expect([...derLength(127)]).toEqual([127]);
    expect([...derLength(128)]).toEqual([0x81, 128]);
    expect([...derLength(300)]).toEqual([0x82, 1, 44]);
  });
});

describe('derTime', () => {
  it('writes UTCTime up to 2049 and GeneralizedTime after', () => {
    const utc = derTime(new Date(Date.UTC(2026, 9, 21, 12, 5, 9)));
    expect(utc[0]).toBe(0x17);
    expect(new TextDecoder().decode(utc.subarray(2))).toBe('261021120509Z');
    const generalized = derTime(new Date(Date.UTC(2126, 0, 1)));
    expect(generalized[0]).toBe(0x18);
    expect(new TextDecoder().decode(generalized.subarray(2))).toBe('21260101000000Z');
  });
});

describe('selfSignedCertificate', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const make = (serial: Uint8Array) =>
    selfSignedCertificate({
      spki: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
      serial,
      name: 'PDF Reader on Desk',
      notBefore: new Date(Date.UTC(2026, 9, 21)),
      notAfter: new Date(Date.UTC(2126, 9, 21)),
      sign: (tbs) => new Uint8Array(sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })),
    });

  it('is a certificate Node reads, for this key, signed by it', () => {
    const cert = new X509Certificate(make(randomBytes(16)));
    expect(cert.checkPrivateKey(privateKey)).toBe(true);
    expect(cert.verify(publicKey)).toBe(true);
    expect(cert.subject).toBe('CN=PDF Reader on Desk');
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.validFrom).toBe('Oct 21 00:00:00 2026 GMT');
    expect(cert.validTo).toBe('Oct 21 00:00:00 2126 GMT');
  });

  it('keeps a serial with its high bit set positive', () => {
    const serial = new Uint8Array(16).fill(0xff);
    expect(new X509Certificate(make(serial)).serialNumber).toBe('FF'.repeat(16));
  });
});
