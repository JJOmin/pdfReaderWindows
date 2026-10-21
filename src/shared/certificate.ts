/**
 * A self-signed X.509 certificate for the phone server (ADR 7 section 6). Node can read
 * certificates but not make them, and the owner chose a small DER writer over a dependency.
 * The key and the signing are passed in, so this file stays free of Node APIs.
 */

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';

export function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const tlv = (tag: number, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(content);
  return concat([Uint8Array.of(tag), derLength(body.length), body]);
};

const sequence = (...items: Uint8Array[]): Uint8Array => tlv(0x30, ...items);

/** A positive INTEGER: a leading zero keeps a high first bit from reading as negative. */
const integer = (bytes: Uint8Array): Uint8Array =>
  tlv(0x02, bytes[0]! & 0x80 ? Uint8Array.of(0, ...bytes) : bytes);

function oid(dotted: string): Uint8Array {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const out = [first! * 40 + second!];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) groups.unshift((n & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Uint8Array.from(out));
}

const utf8 = (text: string): Uint8Array => tlv(0x0c, new TextEncoder().encode(text));

/** UTCTime until 2049, GeneralizedTime from 2050, as RFC 5280 section 4.1.2.5 requires. */
export function derTime(date: Date): Uint8Array {
  const two = (n: number): string => String(n).padStart(2, '0');
  const year = date.getUTCFullYear();
  const rest =
    two(date.getUTCMonth() + 1) +
    two(date.getUTCDate()) +
    two(date.getUTCHours()) +
    two(date.getUTCMinutes()) +
    two(date.getUTCSeconds()) +
    'Z';
  return year < 2050
    ? tlv(0x17, new TextEncoder().encode(two(year % 100) + rest))
    : tlv(0x18, new TextEncoder().encode(String(year) + rest));
}

export interface CertificateInput {
  /** The public key as SubjectPublicKeyInfo DER, as Node exports it. */
  spki: Uint8Array;
  serial: Uint8Array;
  /** Issuer and subject common name. */
  name: string;
  notBefore: Date;
  notAfter: Date;
  /** ECDSA with SHA-256 over the bytes, as a DER signature. */
  sign(tbs: Uint8Array): Uint8Array;
}

/** A v3 certificate with no extensions: the phone pins its fingerprint and checks nothing else. */
export function selfSignedCertificate(input: CertificateInput): Uint8Array {
  const algorithm = sequence(oid(ECDSA_WITH_SHA256));
  const name = sequence(tlv(0x31, sequence(oid(COMMON_NAME), utf8(input.name))));
  const tbs = sequence(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(input.serial),
    algorithm,
    name,
    sequence(derTime(input.notBefore), derTime(input.notAfter)),
    name,
    input.spki,
  );
  return sequence(tbs, algorithm, tlv(0x03, Uint8Array.of(0), input.sign(tbs)));
}
