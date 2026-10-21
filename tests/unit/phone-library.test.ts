import { describe, expect, it } from 'vitest';
import {
  newestState,
  pageWords,
  parseDeviceState,
  parseManifest,
  parsePageIndex,
  sentenceStarts,
  syncText,
  type DeviceState,
} from '../../src/shared/phone-library';
import type { Utterance } from '../../src/shared/types';

const utterance = (...words: string[]): Utterance => ({
  page: 1,
  text: words.join(' '),
  spoken: words.join(' '),
  lang: 'en',
  role: 'main',
  words: words.map((text) => ({ text, ranges: [] })),
  ranges: [],
});

const KEY = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const DEVICE = 'c'.repeat(32);

describe('pageWords', () => {
  it('is every word of every sentence, in order', () => {
    expect(pageWords([utterance('I.', 'INTRODUCTION'), utterance('Tutorials', 'help')])).toEqual([
      'I.',
      'INTRODUCTION',
      'Tutorials',
      'help',
    ]);
  });

  it('does not depend on where the sentences break', () => {
    // PDF.js and PDFium can break a heading off differently; the words must not change.
    const joined = pageWords([utterance('INTRODUCTION', 'Tutorials', 'help')]);
    const split = pageWords([utterance('INTRODUCTION'), utterance('Tutorials', 'help')]);
    expect(split).toEqual(joined);
  });

  it('applies NFKC, so a ligature and its letters are one word', () => {
    expect(pageWords([utterance('ﬁnd', 'Ａ')])).toEqual(['find', 'A']);
  });
});

describe('sentenceStarts', () => {
  it('gives the index of each sentence’s first word among the page’s words', () => {
    expect(sentenceStarts([utterance('a', 'b'), utterance('c'), utterance('d', 'e', 'f')])).toEqual([
      0, 2, 3,
    ]);
    expect(sentenceStarts([])).toEqual([]);
  });
});

describe('syncText', () => {
  it('folds whitespace, including line breaks, and trims', () => {
    expect(syncText('  Tutorials break\ndown \t complex topics. ')).toBe(
      'Tutorials break down complex topics.',
    );
  });

  it('applies NFKC', () => {
    expect(syncText('Eine ﬂache Ａrt')).toBe('Eine flache Art');
  });
});

const sentence = (over: Record<string, unknown> = {}) => ({
  key: KEY,
  lang: 'en',
  ms: 1000,
  from: 0,
  words: [
    [0, 400],
    [400, 1000],
  ],
  ...over,
});

describe('parsePageIndex', () => {
  const index = (over: Record<string, unknown> = {}) => ({
    wordCount: 5,
    wordsHash: HASH,
    sentences: [
      sentence(),
      sentence({
        from: 2,
        words: [
          [0, 100],
          [100, 200],
          [250, 300],
        ],
      }),
    ],
    ...over,
  });

  it('accepts a valid index as it is', () => {
    expect(parsePageIndex(index())).toEqual(index());
    expect(parsePageIndex(index({ wordCount: 0, sentences: [] }))).toEqual(
      index({ wordCount: 0, sentences: [] }),
    );
  });

  it('rejects an index whose sentences do not tile the words in order', () => {
    // The phone maps sentences to its own words by index, so a gap or overlap would misplace them.
    expect(parsePageIndex(index({ wordCount: 6 }))).toBeNull();
    expect(parsePageIndex(index({ wordCount: 4 }))).toBeNull();
    expect(parsePageIndex(index({ sentences: [sentence(), sentence({ from: 1 })] }))).toBeNull();
    expect(parsePageIndex(index({ sentences: [sentence({ from: 1 })], wordCount: 3 }))).toBeNull();
  });

  it('rejects bad fields', () => {
    expect(parsePageIndex(null)).toBeNull();
    expect(parsePageIndex(index({ wordsHash: 'B'.repeat(64) }))).toBeNull();
    expect(parsePageIndex(index({ sentences: 'x' }))).toBeNull();
    const bad = [
      { key: '../../etc' },
      { key: KEY.slice(1) },
      { lang: 'fr' },
      { ms: -1 },
      { ms: Number.NaN },
      { words: [] },
      {
        words: [
          [400, 0],
          [400, 1000],
        ],
      },
      {
        words: [
          [0, 400],
          [300, 1000],
        ],
      },
      {
        words: [
          [0, 400],
          [400, 1001],
        ],
      },
      { words: [[0], [400, 1000]] },
    ];
    for (const over of bad) {
      expect(
        parsePageIndex({ wordCount: 2, wordsHash: HASH, sentences: [sentence(over)] }),
        JSON.stringify(over),
      ).toBeNull();
    }
  });
});

describe('parseManifest', () => {
  const manifest = (over: Record<string, unknown> = {}) => ({
    version: 1,
    docId: HASH,
    name: 'paper.pdf',
    pages: 7,
    sentences: 355,
    bytes: 1_200_000,
    updated: 1_792_500_000_000,
    ...over,
  });

  it('accepts a valid manifest', () => {
    expect(parseManifest(manifest())).toEqual(manifest());
  });

  it('rejects other versions and bad fields', () => {
    expect(parseManifest(manifest({ version: 2 }))).toBeNull();
    expect(parseManifest(manifest({ docId: 'x' }))).toBeNull();
    expect(parseManifest(manifest({ name: '' }))).toBeNull();
    expect(parseManifest(manifest({ name: 'x'.repeat(256) }))).toBeNull();
    expect(parseManifest(manifest({ pages: 0 }))).toBeNull();
    expect(parseManifest(manifest({ sentences: 1.5 }))).toBeNull();
    expect(parseManifest(manifest({ bytes: -1 }))).toBeNull();
    expect(parseManifest(manifest({ updated: 'today' }))).toBeNull();
  });
});

describe('parseDeviceState', () => {
  const state = (over: Record<string, unknown> = {}) => ({
    device: DEVICE,
    name: 'Galaxy S20 FE',
    updated: 1_792_500_000_000,
    page: 34,
    offset: 0.2,
    sentence: { page: 34, index: 5, key: KEY },
    ...over,
  });

  it('accepts a valid state, with or without a sentence', () => {
    expect(parseDeviceState(state())).toEqual(state());
    expect(parseDeviceState(state({ sentence: null }))).toEqual(state({ sentence: null }));
  });

  it('clamps the offset as progress does', () => {
    expect(parseDeviceState(state({ offset: 3 }))?.offset).toBe(0.999);
    expect(parseDeviceState(state({ offset: -1 }))?.offset).toBe(0);
  });

  it('drops a sentence that is not valid but keeps the place', () => {
    expect(parseDeviceState(state({ sentence: { page: 34, index: -1, key: KEY } }))?.sentence).toBeNull();
    expect(parseDeviceState(state({ sentence: { page: 34, index: 5, key: 'x' } }))?.sentence).toBeNull();
  });

  it('rejects a state without a device, name, time or page', () => {
    expect(parseDeviceState(null)).toBeNull();
    expect(parseDeviceState(state({ device: '../x' }))).toBeNull();
    expect(parseDeviceState(state({ name: '' }))).toBeNull();
    expect(parseDeviceState(state({ name: 'x'.repeat(65) }))).toBeNull();
    expect(parseDeviceState(state({ updated: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parseDeviceState(state({ page: 0 }))).toBeNull();
  });
});

describe('newestState', () => {
  const at = (updated: number, device = DEVICE): DeviceState => ({
    device,
    name: 'x',
    updated,
    page: 1,
    offset: 0,
    sentence: null,
  });

  it('picks the most recently updated state', () => {
    expect(newestState([at(1), at(3, 'd'.repeat(32)), at(2)])?.updated).toBe(3);
    expect(newestState([])).toBeUndefined();
  });
});
