import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oggOpus } from '../../src/shared/ogg.ts';

// ADR 7 section 4, step S3: real speech through the window's own WebCodecs Opus encoder, into
// Ogg by src/shared/ogg.ts, and back through Chromium's decoder. Needs no models or PDF.
const samples = join(import.meta.dirname, '../../docs/samples');
const VOICES = ['en-kokoro.wav', 'de-piper-thorsten.wav'];

let app: ElectronApplication | undefined;
let page: Page;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pdfreader-opus-'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PDFREADER_USER_DATA: join(dir, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code's extension host; would start Electron as plain Node
  app = await electron.launch({ args: ['.', '--mute-audio'], env: env as Record<string, string> });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

interface Encoded {
  rate: number;
  length: number;
  rms: number;
  packets: { data: string; duration: number }[];
  head: string | null;
  encodeMs: number;
}

/** In the window: decode the WAV at its own rate, resample to 48 kHz, encode as Opus. */
function encode(wav: string): Promise<Encoded> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const rate = new DataView(bytes.buffer).getUint32(24, true);
    const source = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes.buffer);
    // The same resampling the prepare job will use: the platform's, no code of our own.
    const length = Math.ceil((source.length * 48000) / rate);
    const context = new OfflineAudioContext(1, length, 48000);
    const node = context.createBufferSource();
    node.buffer = source;
    node.connect(context.destination);
    node.start();
    const pcm = (await context.startRendering()).getChannelData(0);

    const packets: { data: string; duration: number }[] = [];
    let head: string | null = null;
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        packets.push({ data: btoa(String.fromCharCode(...data)), duration: chunk.duration ?? 0 });
        const description = meta?.decoderConfig?.description;
        if (description && !head) {
          const view = ArrayBuffer.isView(description)
            ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
            : new Uint8Array(description);
          head = btoa(String.fromCharCode(...view));
        }
      },
      error: (e) => {
        throw e;
      },
    });
    encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 });
    const started = performance.now();
    const step = 4800;
    for (let i = 0; i < pcm.length; i += step) {
      const part = pcm.slice(i, i + step);
      encoder.encode(
        new AudioData({
          format: 'f32-planar',
          sampleRate: 48000,
          numberOfFrames: part.length,
          numberOfChannels: 1,
          timestamp: Math.round((i * 1e6) / 48000),
          data: part,
        }),
      );
    }
    await encoder.flush();
    const encodeMs = performance.now() - started;
    encoder.close();
    const rms = Math.sqrt(pcm.reduce((s, x) => s + x * x, 0) / pcm.length);
    return { rate, length: pcm.length, rms, packets, head, encodeMs };
  }, wav);
}

/** In the window: decode an Ogg Opus file with Chromium's own decoder. */
function decode(ogg: Uint8Array): Promise<{ length: number; rate: number; rms: number }> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer);
    const pcm = audio.getChannelData(0);
    const rms = Math.sqrt(pcm.reduce((s, x) => s + x * x, 0) / pcm.length);
    return { length: audio.length, rate: audio.sampleRate, rms };
  }, Buffer.from(ogg).toString('base64'));
}

for (const voice of VOICES) {
  test(`${voice} survives Opus in Ogg`, async () => {
    const encoded = await encode(readFileSync(join(samples, voice)).toString('base64'));
    const seconds = encoded.length / 48000;

    // The encoder's delay, from the OpusHead it reports, else libopus's usual 6.5 ms.
    const head = encoded.head && Buffer.from(encoded.head, 'base64');
    const preSkip = head && head.toString('ascii', 0, 8) === 'OpusHead' ? head.readUInt16LE(10) : 312;
    const packets = encoded.packets.map((p) => ({
      data: new Uint8Array(Buffer.from(p.data, 'base64')),
      samples: Math.round((p.duration * 48000) / 1e6),
    }));
    const ogg = oggOpus(packets, {
      channels: 1,
      preSkip,
      inputRate: encoded.rate,
      serial: 1,
      length: encoded.length,
    });
    writeFileSync(join(dir, voice.replace('.wav', '.opus')), ogg);

    const decoded = await decode(ogg);
    const lengthError = Math.abs(decoded.length - encoded.length) / 48;
    console.log(
      `${voice}: ${encoded.rate} Hz, ${seconds.toFixed(2)} s, pre-skip ${preSkip}` +
        `${encoded.head ? ' (reported)' : ' (assumed)'}, ${packets.length} packets, ` +
        `${(ogg.length / 1024).toFixed(1)} KB (${((ogg.length * 8) / seconds / 1000).toFixed(1)} kbit/s), ` +
        `encoded in ${(encoded.encodeMs / 1000 / seconds).toFixed(3)} s per s of audio, ` +
        `length off by ${lengthError.toFixed(1)} ms, rms ${encoded.rms.toFixed(4)} -> ${decoded.rms.toFixed(4)}, ` +
        `file ${join(dir, voice.replace('.wav', '.opus'))}`,
    );

    expect(lengthError).toBeLessThan(20);
    // Speech, not silence or noise: the loudness comes back within a factor of 1.5.
    expect(decoded.rms / encoded.rms).toBeGreaterThan(1 / 1.5);
    expect(decoded.rms / encoded.rms).toBeLessThan(1.5);
    // About the bitrate asked for: 11 MB per hour of speech is what ADR 7 counts on.
    expect((ogg.length * 8) / seconds).toBeLessThan(40_000);
    expect(encoded.encodeMs / 1000).toBeLessThan(seconds);
  });
}
