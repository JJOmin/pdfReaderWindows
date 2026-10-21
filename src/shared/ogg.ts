/**
 * Opus packets into an Ogg Opus stream (RFC 3533 for Ogg, RFC 7845 for Opus in it). WebCodecs'
 * AudioEncoder gives bare packets, and the phone's player needs a file, so the desktop writes the
 * container itself rather than adding a dependency (ADR 7 section 4).
 */

export interface OpusPacket {
  data: Uint8Array;
  /** The packet's length in 48 kHz samples, whatever the input rate: Opus always counts at 48 kHz. */
  samples: number;
}

export interface OggOpusOptions {
  channels: number;
  /** Samples at 48 kHz the decoder drops from the start: the encoder's delay. */
  preSkip: number;
  /** The rate the audio had before encoding. Informational: players may resample to it. */
  inputRate: number;
  serial: number;
  /**
   * The true length of the sound in 48 kHz samples, after the pre-skip, so that the padding the
   * encoder adds at the end is cut off. Without it every decoded sample after the pre-skip plays.
   */
  length?: number;
}

const BOS = 0x02;
const EOS = 0x04;
const MAX_SEGMENTS = 255;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

/** Ogg's page checksum: CRC-32 with polynomial 0x04c11db7, not reflected, starting at zero. */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

/** One packet as lacing values: 255 for every full segment, then the rest, which may be zero. */
const lacing = (size: number): number[] => [...Array<number>(Math.floor(size / 255)).fill(255), size % 255];

function page(
  packets: Uint8Array[],
  flags: number,
  granule: bigint,
  serial: number,
  sequence: number,
): Uint8Array {
  const segments = packets.flatMap((p) => lacing(p.length));
  const bodySize = packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(27 + segments.length + bodySize);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  out[5] = flags;
  view.setBigInt64(6, granule, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  out[26] = segments.length;
  out.set(segments, 27);
  let at = 27 + segments.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }
  view.setUint32(22, oggCrc(out), true);
  return out;
}

function opusHead({ channels, preSkip, inputRate }: OggOpusOptions): Uint8Array {
  const out = new Uint8Array(19);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('OpusHead'));
  out[8] = 1;
  out[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  // Output gain 0 and channel mapping family 0 (mono or stereo) are the zeros left in place.
  return out;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('pdfreader');
  const out = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('OpusTags'));
  view.setUint32(8, vendor.length, true);
  out.set(vendor, 12);
  // No user comments: the count of zero is left in place.
  return out;
}

/** The Ogg Opus file for one sentence's packets. No packet is split across pages. */
export function oggOpus(packets: readonly OpusPacket[], options: OggOpusOptions): Uint8Array {
  if (packets.length === 0) throw new Error('No Opus packets to write');
  if (packets.some((p) => !Number.isInteger(p.samples) || p.samples <= 0)) {
    throw new Error('Every Opus packet needs a positive length in samples');
  }
  const { serial, preSkip } = options;
  const total = packets.reduce((n, p) => n + p.samples, 0);
  // A granule counts every decoded sample, the pre-skip included (RFC 7845 section 4).
  const end = options.length === undefined ? total : preSkip + options.length;
  if (!Number.isInteger(end) || end <= preSkip || end > total) {
    throw new Error(
      `${options.length} samples after a pre-skip of ${preSkip} do not fit packets of ${total}`,
    );
  }

  // Group the packets into pages, closing a page when the next packet's segments would not fit.
  const groups: OpusPacket[][] = [[]];
  let used = 0;
  for (const p of packets) {
    const needed = lacing(p.data.length).length;
    if (used + needed > MAX_SEGMENTS) {
      groups.push([]);
      used = 0;
    }
    groups.at(-1)!.push(p);
    used += needed;
  }

  const out = [page([opusHead(options)], BOS, 0n, serial, 0), page([opusTags()], 0, 0n, serial, 1)];
  let samples = 0;
  groups.forEach((group, i) => {
    const before = samples;
    samples += group.reduce((n, p) => n + p.samples, 0);
    const last = i === groups.length - 1;
    // RFC 7845: end trimming may only cut into the last page.
    if (last && end <= before) throw new Error(`The end at ${end} would cut into an earlier page`);
    const granule = BigInt(last ? end : samples);
    out.push(
      page(
        group.map((p) => p.data),
        last ? EOS : 0,
        granule,
        serial,
        i + 2,
      ),
    );
  });

  const stream = new Uint8Array(out.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of out) {
    stream.set(p, at);
    at += p.length;
  }
  return stream;
}
