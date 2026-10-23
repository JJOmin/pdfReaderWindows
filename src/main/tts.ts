import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import catalog from '../../models.json';
import { alignWords, estimateTimings } from '../shared/align';
import { DICTATION_RATE, padSilence } from '../shared/dictation';
import { isRenderedVoice, XTTS_MODEL } from '../shared/render-cache';
import type { Lang, SynthRequest, SynthResult, VoiceOption } from '../shared/types';
import { Xtts } from './xtts';

// sherpa-onnx-node is a CommonJS native addon without type declarations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sherpa: any = createRequire(import.meta.url)('sherpa-onnx-node');

type Model = (typeof catalog)[number];
interface Wave {
  samples: Float32Array;
  sampleRate: number;
}

const THREADS = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));

/** Speakers by `sid`. The model has dozens; this one was chosen by listening, ADR 5. */
const XTTS_SPEAKERS: Record<number, string> = { 0: 'Claribel Dervla' };

export interface GpuVoiceOptions {
  /** Where rendered sentences are kept between sessions. */
  cacheDir: string;
  /** The helper program, helper/xtts_helper.py. */
  helperScript: string;
}

/** The sherpa-onnx model section for one catalog entry. */
function engineConfig(model: Model, dir: string): Record<string, unknown> {
  const at = (file: string): string => join(dir, file);
  switch (model.engine) {
    case 'kokoro':
      return {
        kokoro: {
          model: at('model.onnx'),
          voices: at('voices.bin'),
          tokens: at('tokens.txt'),
          dataDir: at('espeak-ng-data'),
          lexicon: at('lexicon-us-en.txt'),
          lang: 'en-us',
        },
      };
    case 'vits': {
      const name = model.dir.replace(/^vits-piper-/u, '');
      return { vits: { model: at(`${name}.onnx`), tokens: at('tokens.txt'), dataDir: at('espeak-ng-data') } };
    }
    case 'supertonic':
      return {
        supertonic: {
          durationPredictor: at('duration_predictor.int8.onnx'),
          textEncoder: at('text_encoder.int8.onnx'),
          vectorEstimator: at('vector_estimator.int8.onnx'),
          vocoder: at('vocoder.int8.onnx'),
          ttsJson: at('tts.json'),
          unicodeIndexer: at('unicode_indexer.bin'),
          voiceStyle: at('voice.bin'),
        },
      };
    case 'pocket':
      return {
        pocket: {
          lmFlow: at('lm_flow.onnx'),
          lmMain: at('lm_main.onnx'),
          encoder: at('encoder.onnx'),
          decoder: at('decoder.onnx'),
          textConditioner: at('text_conditioner.onnx'),
          vocabJson: at('vocab.json'),
          tokenScoresJson: at('token_scores.json'),
          voiceEmbeddingCacheCapacity: 16,
        },
      };
    default:
      throw new Error(`No speech engine for model "${model.id}"`);
  }
}

/** Runs the local speech models: text to audio, then audio to word timings. */
export class Tts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private engines = new Map<string, Promise<any>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private aligner: Promise<any> | undefined;
  private references = new Map<string, Wave>();
  /** Requests run one at a time: each engine already uses every core it is given. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Alignment calls run one at a time too: the CPU voices and the GPU voice both end here. */
  private alignment: Promise<unknown> = Promise.resolve();
  private gpuVoice: Xtts | undefined;

  constructor(
    private readonly modelsDir: string,
    private readonly gpu?: GpuVoiceOptions,
  ) {}

  private dir(model: Model): string {
    return join(this.modelsDir, model.dir);
  }

  private installed(id: string): Model | undefined {
    const model = catalog.find((m) => m.id === id);
    return model && existsSync(this.dir(model)) ? model : undefined;
  }

  private xttsPaths(): { python: string; model: string } {
    const env = join(this.modelsDir, 'xtts-env');
    return {
      python: join(env, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      model: join(this.modelsDir, 'xtts-v2'),
    };
  }

  private xttsInstalled(): boolean {
    if (!this.gpu) return false;
    const { python, model } = this.xttsPaths();
    return existsSync(python) && existsSync(join(model, 'model.pth'));
  }

  private xtts(): Xtts {
    if (!this.gpu || !this.xttsInstalled()) {
      throw new Error('The XTTS-v2 voice is not installed. Run: npm run gpu-voice');
    }
    const { python, model } = this.xttsPaths();
    this.gpuVoice ??= new Xtts({
      command: python,
      // -I: ignore PYTHON* variables and the working directory, so only the environment's own
      // packages are imported.
      args: ['-I', '-X', 'utf8', this.gpu.helperScript, model],
      cacheDir: this.gpu.cacheDir,
      speakers: XTTS_SPEAKERS,
    });
    return this.gpuVoice;
  }

  voices(): VoiceOption[] {
    const cpu = catalog
      .filter((m) => m.engine !== 'aligner' && this.installed(m.id))
      .flatMap((m) =>
        Object.entries(m.speakers).map(([sid, name]) => ({
          model: m.id,
          sid: Number(sid),
          label: `${m.label} · ${name}`,
          langs: m.langs as Lang[],
        })),
      );
    const gpu: VoiceOption[] = this.xttsInstalled()
      ? Object.entries(XTTS_SPEAKERS).map(([sid, name]) => ({
          model: XTTS_MODEL,
          sid: Number(sid),
          label: `XTTS-v2 · ${name} (GPU)`,
          langs: ['en', 'de'],
        }))
      : [];
    return [...cpu, ...gpu];
  }

  synthesize(request: SynthRequest): Promise<SynthResult> {
    // The GPU voice has a queue of its own, so that it never waits for a CPU voice, or the reverse.
    if (isRenderedVoice(request.voice)) return this.speakXtts(request);
    const result = this.queue.then(() => this.run(request));
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Renders a sentence with the GPU voice into the cache without returning it. Yields to live requests. */
  async prerender(request: SynthRequest): Promise<void> {
    if (!isRenderedVoice(request.voice)) throw new Error(`"${request.voice.model}" is not a rendered voice`);
    await this.xtts().render(request, 'background');
  }

  /** Stops the GPU voice's helper process, which frees its memory. */
  close(): void {
    this.gpuVoice?.close();
  }

  private async speakXtts(request: SynthRequest): Promise<SynthResult> {
    const path = await this.xtts().render(request, 'live');
    // false: Electron forbids ArrayBuffers that point at memory outside the V8 heap.
    return this.align(sherpa.readWave(path, false) as Wave, request.words);
  }

  private async run({ text, words, lang, voice, speed }: SynthRequest): Promise<SynthResult> {
    const model = this.installed(voice.model);
    if (!model) throw new Error(`Speech model "${voice.model}" is not installed. Run: npm run models`);

    let engine = this.engines.get(model.id);
    if (!engine) {
      const created: Promise<unknown> = sherpa.OfflineTts.createAsync({
        model: { ...engineConfig(model, this.dir(model)), numThreads: THREADS, provider: 'cpu' },
        maxNumSentences: 1,
      });
      engine = created;
      this.engines.set(model.id, engine);
    }

    const generation: Record<string, unknown> = { sid: voice.sid, speed };
    if (model.engine === 'supertonic') Object.assign(generation, { numSteps: 8, extra: { lang } });
    if (model.engine === 'pocket') {
      const wav = model.referenceWavs?.[voice.sid] ?? model.referenceWavs?.[0];
      if (!wav) throw new Error('Pocket TTS needs a reference recording');
      const path = join(this.dir(model), wav);
      const reference = this.references.get(path) ?? (sherpa.readWave(path) as Wave);
      this.references.set(path, reference);
      Object.assign(generation, {
        sid: 0,
        referenceAudio: reference.samples,
        referenceSampleRate: reference.sampleRate,
        numSteps: 5,
        extra: { max_reference_audio_len: 12, seed: 42 },
      });
    }

    const audio: Wave = await (
      await engine
    ).generateAsync({
      text,
      // Electron forbids ArrayBuffers that point at memory outside the V8 heap.
      enableExternalBuffer: false,
      generationConfig: new sherpa.GenerationConfig(generation),
    });
    return this.align(audio, words);
  }

  /** Writes out what was said: 16 kHz mono samples to text, in the language the recogniser hears. */
  transcribe(samples: Float32Array): Promise<string> {
    const result = this.alignment.then(async () => {
      const recogniser = await this.loadAligner();
      if (!recogniser) throw new Error('The speech recogniser is not installed. Run: npm run models');
      const stream = recogniser.createStream();
      stream.acceptWaveform({ samples: padSilence(samples), sampleRate: DICTATION_RATE });
      await recogniser.decodeAsync(stream);
      return (recogniser.getResult(stream) as { text: string }).text.trim();
    });
    this.alignment = result.catch(() => undefined);
    return result;
  }

  private align(audio: Wave, words: string[]): Promise<SynthResult> {
    const result = this.alignment.then(() => this.timings(audio, words));
    this.alignment = result.catch(() => undefined);
    return result;
  }

  private async timings(audio: Wave, words: string[]): Promise<SynthResult> {
    const duration = audio.samples.length / audio.sampleRate;
    const aligner = await this.loadAligner();
    if (!aligner) {
      return { ...audio, timings: estimateTimings(words, duration), aligned: false };
    }
    const stream = aligner.createStream();
    stream.acceptWaveform({ samples: audio.samples, sampleRate: audio.sampleRate });
    await aligner.decodeAsync(stream);
    const heard = aligner.getResult(stream) as { tokens: string[]; timestamps: number[] };
    return { ...audio, timings: alignWords(words, heard.tokens, heard.timestamps, duration), aligned: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private loadAligner(): Promise<any> | undefined {
    const model = this.installed('aligner');
    if (!model) return undefined;
    this.aligner ??= sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        nemoCtc: { model: join(this.dir(model), 'model.int8.onnx') },
        tokens: join(this.dir(model), 'tokens.txt'),
        numThreads: THREADS,
        provider: 'cpu',
      },
    });
    return this.aligner;
  }
}
