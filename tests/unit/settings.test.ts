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

  it('keeps valid reading settings, clamps numbers and ignores unknown fonts and themes', () => {
    const { reading } = normalizeSettings({
      reading: { font: 'OpenDyslexic', size: 500, lineHeight: 2, letterSpacing: -1, theme: 'neon' },
    });
    expect(reading).toEqual({
      font: 'OpenDyslexic',
      size: 40,
      lineHeight: 2,
      letterSpacing: -0.08,
      theme: defaultSettings().reading.theme,
    });
    expect(normalizeSettings({ reading: { font: 'Wingdings' } }).reading).toEqual(defaultSettings().reading);
    expect(normalizeSettings({ reading: null }).reading).toEqual(defaultSettings().reading);
  });
});

describe('resolveVoice', () => {
  const settings = normalizeSettings({
    voices: {
      en: { main: { model: 'kokoro', sid: 3 }, quote: { model: 'kokoro', sid: 26 } },
      de: { main: { model: 'piper-thorsten', sid: 0 }, quote: { model: 'supertonic', sid: 5 } },
    },
  });

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

  it('does not use a voice for a language it cannot speak', () => {
    // Kokoro only speaks English, so a German quote must not get the English quote voice.
    const available = [voice('kokoro', 26, ['en']), voice('piper-thorsten', 0, ['de'])];
    const german = normalizeSettings({ voices: { de: { quote: { model: 'kokoro', sid: 26 } } } });
    expect(resolveVoice(german, available, 'de', 'quote')).toMatchObject({ model: 'piper-thorsten' });
  });

  it('prefers a wrong-language voice over silence and returns nothing without voices', () => {
    expect(resolveVoice(settings, [voice('kokoro', 3, ['en'])], 'de', 'main')).toMatchObject({
      model: 'kokoro',
    });
    expect(resolveVoice(settings, [], 'de', 'main')).toBeUndefined();
  });
});
