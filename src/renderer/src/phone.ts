import { oggOpus, type OpusPacket } from '../../shared/ogg';
import { libraryTimings, syncText, type PreparedSentence } from '../../shared/phone-library';
import { prerender, type PrerenderProgress, type PrerenderResult } from '../../shared/prerender';
import { resolveVoice } from '../../shared/settings';
import type { Api, Settings, SynthRequest, Utterance, VoiceOption } from '../../shared/types';

const OPUS_RATE = 48000;
/** About 11 MB per hour of speech (ADR 7 section 4). */
const BITRATE = 24000;
/** libopus's usual encoder delay, used when the encoder does not report its OpusHead. */
const DEFAULT_PRE_SKIP = 312;

/** Mono samples to an Ogg Opus file: resampled to 48 kHz by the platform, encoded by WebCodecs. */
export async function encodeOpus(samples: Float32Array, sampleRate: number): Promise<Uint8Array> {
  const length = Math.ceil((samples.length * OPUS_RATE) / sampleRate);
  const source = new AudioBuffer({ length: samples.length, sampleRate, numberOfChannels: 1 });
  source.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const context = new OfflineAudioContext(1, length, OPUS_RATE);
  const node = context.createBufferSource();
  node.buffer = source;
  node.connect(context.destination);
  node.start();
  const pcm = (await context.startRendering()).getChannelData(0);

  const packets: OpusPacket[] = [];
  let preSkip = DEFAULT_PRE_SKIP;
  let failure: unknown;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, samples: Math.round(((chunk.duration ?? 0) * OPUS_RATE) / 1e6) });
      const description = meta?.decoderConfig?.description;
      if (description) {
        const head = ArrayBuffer.isView(description)
          ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
          : new Uint8Array(description);
        if (new TextDecoder().decode(head.subarray(0, 8)) === 'OpusHead') {
          preSkip = new DataView(head.buffer, head.byteOffset).getUint16(10, true);
        }
      }
    },
    error: (error) => (failure = error),
  });
  encoder.configure({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: BITRATE });
  encoder.encode(
    new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_RATE,
      numberOfFrames: pcm.length,
      numberOfChannels: 1,
      timestamp: 0,
      data: pcm,
    }),
  );
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  return oggOpus(packets, { channels: 1, preSkip, inputRate: sampleRate, serial: 1, length });
}

export interface PrepareHost {
  api: Api;
  /** The opening of the document, which the main process checks every write against. */
  id: number;
  settings: Settings;
  voices: VoiceOption[];
  pageCount: number;
  utterances(page: number): Promise<Utterance[]>;
  progress(state: PrerenderProgress): void;
}

/**
 * Prepares the open document for the phone (ADR 7, step S4): every distinct sentence rendered at
 * speed 1.0 with the chosen voices, as Opus, then one index per page. The phone changes the speed
 * itself, so the speed slider plays no part.
 */
export async function prepareForPhone(host: PrepareHost, signal: AbortSignal): Promise<PrerenderResult> {
  const { api, id, settings, voices } = host;
  /** Each request's sentence text, by request, since `render` is only given the request. */
  const texts = new Map<SynthRequest, string>();
  /** The audio's length and word timings, by sync text: one file per distinct sentence. */
  const done = new Map<string, { ms: number; timings: [number, number][] }>();
  const claimed = new Set<string>();

  const result = await prerender<Utterance>(
    {
      pageCount: () => host.pageCount,
      utterances: host.utterances,
      request: (utterance) => {
        const text = syncText(utterance.text);
        const voice = resolveVoice(settings, voices, utterance.lang, utterance.role);
        // The same text read again, by any voice, shares the first one's file.
        if (!voice || claimed.has(text)) return undefined;
        claimed.add(text);
        const request = {
          text: utterance.spoken,
          words: utterance.words.map((w) => w.text),
          lang: utterance.lang,
          voice,
          speed: 1,
        };
        texts.set(request, text);
        return request;
      },
      render: async (request) => {
        const text = texts.get(request)!;
        const audio = await api.synthesize(request);
        await api.addPhoneAudio(id, text, await encodeOpus(audio.samples, audio.sampleRate));
        done.set(text, libraryTimings(audio.timings, audio.samples.length / audio.sampleRate));
      },
      progress: host.progress,
    },
    1,
    signal,
  );
  if (result.cancelled) return result;
  if (result.failed > 0) throw new Error(`${result.failed} sentences could not be spoken`);

  for (let page = 1; page <= host.pageCount; page++) {
    const sentences: PreparedSentence[] = [];
    for (const utterance of await host.utterances(page)) {
      const audio = done.get(syncText(utterance.text));
      if (!audio) throw new Error(`No voice is chosen for ${utterance.lang} ${utterance.role} text`);
      sentences.push({
        text: utterance.text,
        lang: utterance.lang,
        words: utterance.words.map((w) => w.text),
        ...audio,
      });
    }
    await api.addPhonePage(id, page, host.pageCount, sentences);
  }
  return result;
}
