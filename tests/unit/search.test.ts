import { describe, expect, it } from 'vitest';
import { blockSpans, layoutPage, readableText } from '../../src/shared/layout';
import { findInBlocks } from '../../src/shared/search';
import type { RawItem } from '../../src/shared/types';

const line = (str: string, y: number): RawItem => ({
  str,
  x: 72,
  y,
  height: 10,
  font: 'body',
  hasEOL: true,
  rotated: false,
});

// Raw string: "A new language representa-" + "tion model was" + "trained (twice)."
const items = [
  line('A new language representa-', 700),
  line('tion model was', 688),
  line('trained (twice).', 676),
];
const pageRaw = items.map((i) => i.str).join('');
const blocks = layoutPage(items, 800);
const matched = (query: string): string[][] =>
  findInBlocks(blocks, query).map((ranges) => ranges.map(([a, b]) => pageRaw.slice(a, b)));

describe('findInBlocks', () => {
  it('ignores case and finds every occurrence', () => {
    expect(matched('MODEL')).toEqual([['model']]);
    expect(findInBlocks(blocks, 'a')).toHaveLength(6);
    expect(matched('missing')).toEqual([]);
    expect(matched('   ')).toEqual([]);
  });

  it('matches across a hyphenated line break and a plain one', () => {
    expect(matched('representation')).toEqual([['representa', 'tion']]);
    // The raw string has no character at a plain line break, so the two words are one raw range.
    expect(matched('was trained')).toEqual([['wastrained']]);
  });

  it('treats punctuation in the query literally', () => {
    expect(matched('(twice).')).toEqual([['(twice).']]);
    expect(matched('.*')).toEqual([]);
  });
});

describe('blockSpans', () => {
  it('maps a raw range back to readable text', () => {
    const start = pageRaw.indexOf('representa');
    const end = pageRaw.indexOf('was') + 3;
    expect(readableText(blocks, start, end)).toBe('representation model was');
    expect(blockSpans(blocks, start, end)).toEqual([{ block: 0, from: 15, to: 39 }]);
    expect(blockSpans(blocks, 9999, 10000)).toEqual([]);
  });
});
