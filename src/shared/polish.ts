/** Corner of the high-pass filter that removes rumble and DC offset below the voice. */
export const POLISH_HIGHPASS_HZ = 70;

/**
 * Web Audio's biquad Q is in decibels. Butterworth, the flattest response, is 1/sqrt(2) as a
 * ratio, which is -3.01 dB; the default would add a bump at the corner.
 */
export const POLISH_HIGHPASS_Q_DB = -3.0103;

/** Length of the fade at each end of a sentence: long enough to hide a click, too short to hear. */
export const POLISH_FADE = 0.008;

/**
 * Where, in seconds from the start of a sentence, the fade-in ends and the fade-out begins.
 * Shorter than two fades, a sentence fades in and out over half its length each, so the gain
 * ramps never overlap.
 */
export function fadeEnvelope(
  duration: number,
  fade = POLISH_FADE,
): { fadeInEnd: number; fadeOutStart: number } {
  const length = Math.min(fade, Math.max(0, duration) / 2);
  return { fadeInEnd: length, fadeOutStart: Math.max(0, duration) - length };
}
