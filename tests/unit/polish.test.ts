import { describe, expect, it } from 'vitest';
import { fadeEnvelope, POLISH_FADE } from '../../src/shared/polish';

describe('fadeEnvelope', () => {
  it('fades over the same length at both ends of a normal sentence', () => {
    const { fadeInEnd, fadeOutStart } = fadeEnvelope(3);
    expect(fadeInEnd).toBe(POLISH_FADE);
    expect(fadeOutStart).toBeCloseTo(3 - POLISH_FADE, 10);
  });

  it('never lets the fade-out start before the fade-in ends', () => {
    for (const duration of [0, 0.004, POLISH_FADE, 2 * POLISH_FADE, 0.5]) {
      const { fadeInEnd, fadeOutStart } = fadeEnvelope(duration);
      expect(fadeInEnd).toBeLessThanOrEqual(fadeOutStart);
      expect(fadeOutStart).toBeLessThanOrEqual(duration);
    }
  });

  it('treats a negative or empty duration as no audio', () => {
    expect(fadeEnvelope(-1)).toEqual({ fadeInEnd: 0, fadeOutStart: 0 });
    expect(fadeEnvelope(0)).toEqual({ fadeInEnd: 0, fadeOutStart: 0 });
  });
});
