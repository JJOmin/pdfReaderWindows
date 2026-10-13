import { describe, expect, it } from 'vitest';
import { requestKey, selectEvictions } from '../../src/shared/render-cache';
import type { SynthRequest } from '../../src/shared/types';

const request = (over: Partial<SynthRequest> = {}): SynthRequest => ({
  text: 'Das ist ein Satz.',
  words: ['Das', 'ist', 'ein', 'Satz'],
  lang: 'de',
  voice: { model: 'xtts', sid: 0 },
  speed: 1,
  ...over,
});

describe('requestKey', () => {
  it('is the same for the same sound', () => {
    expect(requestKey(request())).toBe(requestKey(request()));
    // The words only matter for timing, which is measured again from the audio.
    expect(requestKey(request({ words: [] }))).toBe(requestKey(request()));
  });

  it('differs when anything audible differs', () => {
    const base = requestKey(request());
    expect(requestKey(request({ text: 'Das ist ein Satz!' }))).not.toBe(base);
    expect(requestKey(request({ lang: 'en' }))).not.toBe(base);
    expect(requestKey(request({ voice: { model: 'xtts', sid: 1 } }))).not.toBe(base);
    expect(requestKey(request({ voice: { model: 'other', sid: 0 } }))).not.toBe(base);
    expect(requestKey(request({ speed: 1.25 }))).not.toBe(base);
  });

  it('treats speeds that differ by float noise as one', () => {
    expect(requestKey(request({ speed: 1.1 }))).toBe(requestKey(request({ speed: 1.1 + 1e-12 })));
  });

  it('cannot be confused by text that contains the separators', () => {
    const a = requestKey(request({ text: 'a","b' }));
    const b = requestKey(request({ text: 'a' }));
    expect(a).not.toBe(b);
  });
});

describe('selectEvictions', () => {
  const file = (name: string, size: number, mtime: number) => ({ name, size, mtime });

  it('keeps everything while under the limit', () => {
    expect(selectEvictions([file('a', 10, 1), file('b', 10, 2)], 20)).toEqual([]);
  });

  it('removes the least recently used files first, until the rest fits', () => {
    const files = [file('new', 10, 30), file('old', 10, 10), file('mid', 10, 20)];
    expect(selectEvictions(files, 20)).toEqual(['old']);
    expect(selectEvictions(files, 10)).toEqual(['old', 'mid']);
  });

  it('removes everything when the limit is smaller than any file', () => {
    expect(selectEvictions([file('a', 10, 1)], 5)).toEqual(['a']);
  });
});
