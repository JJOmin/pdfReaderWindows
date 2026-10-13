import { describe, expect, it } from 'vitest';
import { alignWords, estimateTimings } from '../../src/shared/align';

const starts = (timings: { start: number }[]): number[] => timings.map((t) => +t.start.toFixed(2));

describe('estimateTimings', () => {
  it('covers the whole duration in order, longer words taking longer', () => {
    const timings = estimateTimings(['a', 'considerably', 'b'], 3);
    expect(timings[0]?.start).toBe(0);
    expect(timings.at(-1)?.end).toBe(3);
    expect(timings[1]!.end - timings[1]!.start).toBeGreaterThan(timings[0]!.end - timings[0]!.start);
  });
});

describe('alignWords', () => {
  it('takes word starts from the recogniser tokens', () => {
    const timings = alignWords(
      ['The', 'proposed', 'method'],
      [' The', ' pro', 'posed', ' me', 'thod'],
      [0.1, 0.3, 0.5, 0.9, 1.1],
      1.5,
    );
    expect(starts(timings)).toEqual([0.1, 0.3, 0.9]);
    expect(timings.at(-1)?.end).toBe(1.5);
  });

  it('tolerates a word the recogniser split in two', () => {
    const timings = alignWords(
      ['benchmark', 'datasets', 'while'],
      [' benchmark', ' data', ' sets', ' while'],
      [0, 0.5, 0.8, 1.2],
      1.6,
    );
    expect(starts(timings)).toEqual([0, 0.5, 1.2]);
  });

  it('interpolates words the recogniser heard differently', () => {
    const timings = alignWords(
      ['in', '2020', 'we', 'found'],
      [' in', ' twenty', ' twenty', ' we', ' found'],
      [0, 0.2, 0.5, 1.0, 1.2],
      1.6,
    );
    expect(timings[0]?.start).toBe(0);
    expect(timings[1]!.start).toBeGreaterThan(0);
    expect(timings[1]!.start).toBeLessThan(1.0);
    expect(starts(timings).slice(2)).toEqual([1.0, 1.2]);
  });

  it('never goes backwards and survives empty recogniser output', () => {
    const timings = alignWords(['one', 'two', 'three'], [], [], 2);
    expect(timings).toHaveLength(3);
    timings.reduce((prev, t) => {
      expect(t.start).toBeGreaterThanOrEqual(prev);
      return t.start;
    }, 0);
  });
});
