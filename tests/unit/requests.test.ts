import { describe, expect, it } from 'vitest';
import {
  isTrustedOrigin,
  MAX_REQUEST_TEXT,
  mayUseDevice,
  parseSynthRequest,
} from '../../src/shared/requests';

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

describe('isTrustedOrigin', () => {
  it('trusts the app’s own page, and the dev server only when one is named', () => {
    expect(isTrustedOrigin('app://reader/index.html')).toBe(true);
    expect(isTrustedOrigin('app://reader')).toBe(true);
    expect(isTrustedOrigin('http://localhost:5173/', 'http://localhost:5173/')).toBe(true);
    expect(isTrustedOrigin('http://localhost:5173/')).toBe(false);
  });

  it.each([
    ['another site', 'https://example.com/'],
    ['another app host', 'app://evil/index.html'],
    ['a file', 'file:///etc/passwd'],
    ['a look-alike', 'app://reader.evil.com/'],
    ['a look-alike with a user part', 'app://reader@evil.com/'],
    ['nothing', ''],
    ['not a URL', 'reader'],
  ])('refuses %s', (_name, url) => {
    expect(isTrustedOrigin(url)).toBe(false);
    expect(isTrustedOrigin(url, 'http://localhost:5173/')).toBe(false);
  });
});

describe('mayUseDevice', () => {
  it('lets the app’s page use the microphone, and nothing else', () => {
    expect(mayUseDevice('media', 'app://reader/index.html', ['audio'])).toBe(true);
    expect(mayUseDevice('media', 'app://reader/index.html', ['audio', 'video'])).toBe(false);
    expect(mayUseDevice('media', 'app://reader/index.html', ['video'])).toBe(false);
    expect(mayUseDevice('media', 'app://reader/index.html', [])).toBe(false);
    expect(mayUseDevice('media', 'app://reader/index.html')).toBe(false);
  });

  it.each(['geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fullscreen', 'midi'])(
    'refuses %s',
    (permission) => {
      expect(mayUseDevice(permission, 'app://reader/index.html', ['audio'])).toBe(false);
    },
  );

  it('refuses the microphone to any other page', () => {
    expect(mayUseDevice('media', 'https://example.com/', ['audio'])).toBe(false);
  });
});
