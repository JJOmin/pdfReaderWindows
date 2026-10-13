import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings, resolveVoice } from '../../src/shared/settings';
import type { VoiceOption } from '../../src/shared/types';

const voice = (model: string, sid: number, langs: VoiceOption['langs']): VoiceOption => ({
  model,
  sid,
  langs,
  label: `${model} ${sid}`,
});

describe('normalizeSettings', () => {
  it('returns defaults for garbage and clamps the speed', () => {
    expect(normalizeSettings('nonsense')).toEqual(defaultSettings());
    expect(normalizeSettings({ speed: 99 }).speed).toBe(2);
    expect(normalizeSettings({ speed: Number.NaN }).speed).toBe(1);
  });

  it('keeps valid voices, lets a role fall back to main, and ignores invalid entries', () => {
    const settings = normalizeSettings({
      voices: { en: { main: { model: 'pocket', sid: 1 }, quote: null, heading: { model: 7 } } },
    });
    expect(settings.voices.en.main).toEqual({ model: 'pocket', sid: 1 });
    expect(settings.voices.en.quote).toBeNull();
    expect(settings.voices.en.heading).toEqual(defaultSettings().voices.en.heading);
    expect(settings.voices.de).toEqual(defaultSettings().voices.de);
  });
});

describe('resolveVoice', () => {
  const settings = defaultSettings();

  it('uses the voice configured for the role', () => {
    const available = [voice('kokoro', 3, ['en']), voice('kokoro', 26, ['en'])];
    expect(resolveVoice(settings, available, 'en', 'quote')).toEqual({ model: 'kokoro', sid: 26 });
  });

  it('falls back to the main voice, then to any voice for the language', () => {
    const onlyMain = [voice('piper-thorsten', 0, ['de'])];
    expect(resolveVoice(settings, onlyMain, 'de', 'quote')).toEqual({ model: 'piper-thorsten', sid: 0 });
    const other = [voice('kokoro', 3, ['en']), voice('supertonic', 9, ['en', 'de'])];
    expect(resolveVoice(settings, other, 'de', 'main')).toMatchObject({ model: 'supertonic', sid: 9 });
  });

  it('prefers a wrong-language voice over silence and returns nothing without voices', () => {
    expect(resolveVoice(settings, [voice('kokoro', 3, ['en'])], 'de', 'main')).toMatchObject({
      model: 'kokoro',
    });
    expect(resolveVoice(settings, [], 'de', 'main')).toBeUndefined();
  });
});
