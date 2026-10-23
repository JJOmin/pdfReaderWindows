import { fadeEnvelope, POLISH_FADE, POLISH_HIGHPASS_HZ, POLISH_HIGHPASS_Q_DB } from '../../shared/polish';
import type { SynthResult, Utterance } from '../../shared/types';
import { isReferenceHeading } from '../../shared/utterances';

export type ReaderState = 'idle' | 'playing' | 'paused';

/** A position in the document: the n-th utterance of a page. */
export interface Cursor {
  page: number;
  index: number;
}

export interface ReaderHost {
  pageCount(): number;
  utterances(page: number): Promise<Utterance[]>;
  synthesize(utterance: Utterance): Promise<SynthResult>;
  /** `word` is -1 while the sentence is being prepared or before its first word. */
  onChange(state: ReaderState, utterance: Utterance | undefined, word: number): void;
  onError(error: unknown): void;
}

const CACHE_SIZE = 6;
const GAP = 0.08;
const HEADING_GAP = 0.35;

/** Reads the document aloud sentence by sentence and reports which word is being spoken. */
export class Reader {
  state: ReaderState = 'idle';
  /**
   * Fades each sentence in and out and high-passes it. Applied when a sentence starts playing, so
   * a change takes effect on the next sentence and the prepared audio stays valid.
   */
  polish = false;
  /** Reading ends at the reference list's heading, unless it was started there (backlog 5). */
  stopAtReferences = false;
  private readonly audio = new AudioContext();
  private cursor: Cursor | undefined;
  /** Bumped whenever playback is redirected, so a superseded loop notices and exits. */
  private run = 0;
  private source: AudioBufferSourceNode | undefined;
  /** The fade of the playing sentence, when polish is on. */
  private gain: GainNode | undefined;
  private finish: (() => void) | undefined;
  private cache = new Map<string, Promise<SynthResult>>();

  constructor(private readonly host: ReaderHost) {}

  /** Starts at `start` when idle, otherwise pauses or resumes. */
  toggle(start: Cursor): void {
    if (this.state === 'idle') void this.loop(start);
    else if (this.state === 'playing') {
      void this.audio.suspend();
      this.state = 'paused';
      this.host.onChange(this.state, undefined, -1);
    } else {
      void this.audio.resume();
      this.state = 'playing';
      this.host.onChange(this.state, undefined, -1);
    }
  }

  startAt(cursor: Cursor): void {
    void this.loop(cursor);
  }

  async skip(direction: 1 | -1): Promise<void> {
    if (!this.cursor) return;
    const target = await this.settle({ ...this.cursor, index: this.cursor.index + direction }, direction);
    if (target) void this.loop(target);
  }

  stop(): void {
    this.cancel();
    this.cursor = undefined;
    this.state = 'idle';
    this.host.onChange('idle', undefined, -1);
  }

  /** Drops prepared audio after a voice or speed change and re-reads the current sentence. */
  invalidate(): void {
    this.cache.clear();
    if (this.cursor && this.state === 'playing') void this.loop(this.cursor);
  }

  /** Plays a one-off sample, stopping any reading in progress. */
  async preview(sample: Promise<SynthResult>): Promise<void> {
    this.stop();
    const run = this.run;
    try {
      const result = await sample;
      if (run !== this.run) return;
      await this.audio.resume();
      await this.play(result, GAP, () => undefined);
    } catch (error) {
      this.host.onError(error);
    }
  }

  private cancel(): void {
    this.run++;
    if (this.source) {
      this.source.onended = null;
      if (this.gain) {
        // A cut in the middle of a waveform clicks: fade out first.
        const now = this.audio.currentTime;
        this.gain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(this.gain.gain.value, now);
        this.gain.gain.linearRampToValueAtTime(0, now + POLISH_FADE);
        this.source.stop(now + POLISH_FADE);
      } else this.source.stop();
      this.source = undefined;
      this.gain = undefined;
    }
    this.finish?.();
    this.finish = undefined;
  }

  /** Moves a cursor onto an existing utterance, crossing page boundaries in `direction`. */
  private async settle({ page, index }: Cursor, direction: 1 | -1): Promise<Cursor | undefined> {
    while (page >= 1 && page <= this.host.pageCount()) {
      const count = (await this.host.utterances(page)).length;
      if (index < 0) index = count - 1;
      if (index >= 0 && index < count) return { page, index };
      page += direction;
      index = direction === 1 ? 0 : -1;
    }
    return undefined;
  }

  private synth(cursor: Cursor, utterance: Utterance): Promise<SynthResult> {
    const key = `${cursor.page}:${cursor.index}`;
    let result = this.cache.get(key);
    if (!result) {
      result = this.host.synthesize(utterance);
      result.catch(() => this.cache.delete(key));
      this.cache.set(key, result);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }

  /** Prepares the next two sentences so playback continues without a gap. */
  private async prefetch(from: Cursor): Promise<void> {
    let at: Cursor | undefined = from;
    for (let i = 0; i < 2 && at; i++) {
      at = await this.settle({ page: at.page, index: at.index + 1 }, 1);
      if (at) this.synth(at, (await this.host.utterances(at.page))[at.index]!).catch(() => undefined);
    }
  }

  private async loop(start: Cursor): Promise<void> {
    this.cancel();
    const run = this.run;
    this.state = 'playing';
    try {
      await this.audio.resume();
      let previous: Utterance | undefined;
      let at = await this.settle(start, 1);
      while (at && run === this.run) {
        this.cursor = at;
        const utterance = (await this.host.utterances(at.page))[at.index]!;
        if (previous && this.stopAtReferences && isReferenceHeading(utterance)) break;
        this.host.onChange(this.state, utterance, -1);
        const pending = this.synth(at, utterance);
        void this.prefetch(at);
        const result = await pending;
        if (run !== this.run) return;
        const gap = utterance.role === 'heading' || previous?.role === 'heading' ? HEADING_GAP : GAP;
        await this.play(result, gap, (word) => this.host.onChange(this.state, utterance, word));
        previous = utterance;
        if (run === this.run) at = await this.settle({ page: at.page, index: at.index + 1 }, 1);
      }
      if (run === this.run) this.stop();
    } catch (error) {
      if (run !== this.run) return;
      this.stop();
      this.host.onError(error);
    }
  }

  /** Plays one buffer and calls `onWord` as each word starts. Resolves when it ends or is cancelled. */
  private play(result: SynthResult, gap: number, onWord: (word: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const buffer = this.audio.createBuffer(1, result.samples.length, result.sampleRate);
      buffer.copyToChannel(new Float32Array(result.samples), 0);
      const source = this.audio.createBufferSource();
      source.buffer = buffer;
      const startAt = this.audio.currentTime + gap;
      this.gain = undefined;
      if (this.polish) {
        const highpass = this.audio.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = POLISH_HIGHPASS_HZ;
        highpass.Q.value = POLISH_HIGHPASS_Q_DB;
        const gain = this.audio.createGain();
        const { fadeInEnd, fadeOutStart } = fadeEnvelope(buffer.duration);
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(1, startAt + fadeInEnd);
        gain.gain.setValueAtTime(1, startAt + fadeOutStart);
        gain.gain.linearRampToValueAtTime(0, startAt + buffer.duration);
        source.connect(highpass).connect(gain).connect(this.audio.destination);
        this.gain = gain;
      } else {
        source.connect(this.audio.destination);
      }
      let word = -1;
      const tick = (): void => {
        if (this.source !== source) return;
        // The context clock runs ahead of what the speakers play by the output latency.
        const time = this.audio.currentTime - startAt - this.audio.outputLatency;
        let next = word;
        while (next + 1 < result.timings.length && result.timings[next + 1]!.start <= time) next++;
        if (next !== word) onWord((word = next));
        requestAnimationFrame(tick);
      };
      source.onended = (): void => {
        if (this.source === source) {
          this.source = undefined;
          this.gain = undefined;
        }
        resolve();
      };
      this.source = source;
      this.finish = resolve;
      source.start(startAt);
      requestAnimationFrame(tick);
    });
  }
}
