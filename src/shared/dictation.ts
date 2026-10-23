/** Spoken comments (ADR 6 of the phone): the microphone, the recogniser and what goes into the comment. */

/** What the recogniser takes: 16 kHz, mono, samples from -1 to 1. */
export const DICTATION_RATE = 16000;
export const MAX_DICTATION_SECONDS = 60;
/** Silence on each side; without it the recogniser dropped or garbled the first word (phone ADR 6). */
const PAD_SECONDS = 0.4;

export function padSilence(samples: Float32Array, rate = DICTATION_RATE): Float32Array {
  const pad = Math.round(PAD_SECONDS * rate);
  const padded = new Float32Array(samples.length + 2 * pad);
  padded.set(samples, pad);
  return padded;
}

/** Checks audio that came from the renderer. A little over the longest recording is let through. */
export function parseDictation(value: unknown): Float32Array | undefined {
  if (!(value instanceof Float32Array)) return undefined;
  const limit = (MAX_DICTATION_SECONDS + 2) * DICTATION_RATE;
  return value.length > 0 && value.length <= limit ? value : undefined;
}

/** `heard` added to the words already in a comment, with one space between. */
export function joinHeard(comment: string, heard: string): string {
  const added = heard.trim();
  if (added === '') return comment;
  const before = comment.trimEnd();
  return before === '' ? added : `${before} ${added}`;
}
