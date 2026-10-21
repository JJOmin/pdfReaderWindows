import { describe, expect, it } from 'vitest';
import { oggCrc, oggOpus, type OpusPacket } from '../../src/shared/ogg';

interface Page {
  flags: number;
  granule: bigint;
  serial: number;
  sequence: number;
  crc: number;
  lacing: number[];
  body: Uint8Array;
  bytes: Uint8Array;
}

/** Splits an Ogg stream into its pages, independently of the writer. */
function pages(stream: Uint8Array): Page[] {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const out: Page[] = [];
  let at = 0;
  while (at < stream.length) {
    expect(String.fromCharCode(...stream.subarray(at, at + 4))).toBe('OggS');
    expect(stream[at + 4]).toBe(0);
    const count = stream[at + 26]!;
    const lacing = [...stream.subarray(at + 27, at + 27 + count)];
    const size = lacing.reduce((a, b) => a + b, 0);
    const end = at + 27 + count + size;
    out.push({
      flags: stream[at + 5]!,
      granule: view.getBigInt64(at + 6, true),
      serial: view.getUint32(at + 14, true),
      sequence: view.getUint32(at + 18, true),
      crc: view.getUint32(at + 22, true),
      lacing,
      body: stream.subarray(at + 27 + count, end),
      bytes: stream.subarray(at, end),
    });
    at = end;
  }
  return out;
}

const packet = (size: number, fill = 1, samples = 960): OpusPacket => ({
  data: new Uint8Array(size).fill(fill),
  samples,
});
const options = { channels: 1, preSkip: 312, inputRate: 24000, serial: 0x1234abcd };

describe('oggCrc', () => {
  it('is the CRC Ogg uses: polynomial 0x04c11db7, no reflection, zero start', () => {
    expect(oggCrc(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
    expect(oggCrc(new Uint8Array())).toBe(0);
  });
});

describe('oggOpus', () => {
  it('writes the two header pages first, as RFC 7845 requires', () => {
    const [head, tags] = pages(oggOpus([packet(60)], options));
    expect(head!.flags).toBe(0x02);
    expect(head!.granule).toBe(0n);
    expect(head!.sequence).toBe(0);
    expect([...head!.body]).toEqual([
      ...new TextEncoder().encode('OpusHead'),
      1, // version
      1, // channels
      0x38,
      0x01, // pre-skip 312
      0xc0,
      0x5d,
      0x00,
      0x00, // input rate 24000
      0,
      0, // gain
      0, // mapping family
    ]);
    expect(tags!.flags).toBe(0);
    expect(tags!.granule).toBe(0n);
    expect(String.fromCharCode(...tags!.body.subarray(0, 8))).toBe('OpusTags');
  });

  it('numbers the pages, keeps one serial, and gives every page a valid CRC', () => {
    const stream = pages(
      oggOpus(
        Array.from({ length: 600 }, () => packet(60)),
        options,
      ),
    );
    expect(stream.length).toBeGreaterThan(3);
    stream.forEach((page, i) => {
      expect(page.sequence).toBe(i);
      expect(page.serial).toBe(options.serial);
      const zeroed = page.bytes.slice();
      zeroed.fill(0, 22, 26);
      expect(page.crc).toBe(oggCrc(zeroed));
    });
  });

  it('laces packets in 255-byte segments, a full one ending in a zero', () => {
    const audio = pages(oggOpus([packet(254), packet(255), packet(600)], options))[2]!;
    expect(audio.lacing).toEqual([254, 255, 0, 255, 255, 90]);
    expect(audio.body.length).toBe(254 + 255 + 600);
  });

  it('never puts more than 255 segments on a page, nor splits a packet', () => {
    const stream = pages(
      oggOpus(
        Array.from({ length: 300 }, () => packet(300)),
        options,
      ),
    ).slice(2);
    for (const page of stream) {
      expect(page.lacing.length).toBeLessThanOrEqual(255);
      expect(page.flags & 0x01).toBe(0); // no page continues a packet
      expect(page.lacing.at(-1)).toBeLessThan(255); // and none ends inside one
    }
    expect(stream.reduce((n, p) => n + p.body.length, 0)).toBe(300 * 300);
  });

  it('counts granules as every 48 kHz sample decoded so far, the pre-skip among them', () => {
    // RFC 7845 section 4: the pre-skip is not added on top, it is part of the decoded samples.
    const stream = pages(
      oggOpus(
        Array.from({ length: 600 }, () => packet(60)),
        options,
      ),
    ).slice(2);
    let samples = 0;
    for (const page of stream) {
      samples += page.lacing.filter((n) => n < 255).length * 960;
      expect(page.granule).toBe(BigInt(samples));
    }
  });

  it('marks the end, and trims it to the true length when one is given', () => {
    const packets = [packet(60), packet(60), packet(60)];
    const last = pages(oggOpus(packets, options)).at(-1)!;
    expect(last.flags).toBe(0x04);
    expect(last.granule).toBe(3n * 960n);
    // 2,500 samples of sound after the 312 of pre-skip, in 2,880 decoded: the rest is padding.
    expect(pages(oggOpus(packets, { ...options, length: 2500 })).at(-1)!.granule).toBe(312n + 2500n);
  });

  it('refuses what it cannot write', () => {
    expect(() => oggOpus([], options)).toThrow();
    // The sound and the pre-skip together must fit in what the packets decode to.
    expect(() => oggOpus([packet(60)], { ...options, length: 960 - 312 + 1 })).toThrow();
    expect(() => oggOpus([packet(60)], { ...options, length: 0 })).toThrow();
    expect(() => oggOpus([packet(60, 1, 0)], options)).toThrow();
  });
});
