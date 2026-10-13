import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_TEXT, parseSynthRequest } from '../../src/shared/requests';

const valid = {
  text: 'Hello there.',
  words: ['Hello', 'there'],
  lang: 'en',
  voice: { model: 'kokoro', sid: 3 },
  speed: 1.2,
};

describe('parseSynthRequest', () => {
  it('accepts a well-formed request and returns a clean copy', () => {
    const parsed = parseSynthRequest({ ...valid, extra: 'ignored' });
    expect(parsed).toEqual(valid);
    expect(parsed).not.toHaveProperty('extra');
  });

  it('accepts a preview, which has no words', () => {
    expect(parseSynthRequest({ ...valid, words: [] })?.words).toEqual([]);
  });

  it('clamps the speed to what the app offers', () => {
    expect(parseSynthRequest({ ...valid, speed: 50 })?.speed).toBe(2);
    expect(parseSynthRequest({ ...valid, speed: 0 })?.speed).toBe(0.6);
  });

  it.each([
    ['not an object', 'text'],
    ['no text', { ...valid, text: '' }],
    ['blank text', { ...valid, text: '   ' }],
    ['text too long', { ...valid, text: 'a'.repeat(MAX_REQUEST_TEXT + 1) }],
    ['unknown language', { ...valid, lang: 'fr' }],
    ['no voice', { ...valid, voice: null }],
    ['fractional speaker', { ...valid, voice: { model: 'kokoro', sid: 1.5 } }],
    ['words that are not strings', { ...valid, words: [1, 2] }],
    ['speed that is not a number', { ...valid, speed: '1' }],
  ])('rejects %s', (_name, value) => {
    expect(parseSynthRequest(value)).toBeUndefined();
  });
});
