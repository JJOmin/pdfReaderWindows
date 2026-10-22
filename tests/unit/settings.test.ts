import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  normalizeProgress,
  normalizeSettings,
  parseProgressStore,
  PROGRESS_LIMIT,
  rememberProgress,
  resolveVoice,
  voiceChoice,
} from '../../src/shared/settings';
import type { Progress, VoiceOption } from '../../src/shared/types';

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

describe('polish', () => {
  it('is off by default and keeps only a real boolean', () => {
    expect(defaultSettings().polish).toBe(false);
    expect(normalizeSettings({ polish: true }).polish).toBe(true);
    expect(normalizeSettings({ polish: 'yes' }).polish).toBe(false);
    expect(normalizeSettings({}).polish).toBe(false);
  });
});

describe('focus mode', () => {
  it('is off by default and keeps only a real boolean', () => {
    expect(defaultSettings().focusMode).toBe(false);
    expect(normalizeSettings({ focusMode: true }).focusMode).toBe(true);
    expect(normalizeSettings({ focusMode: 'yes' }).focusMode).toBe(false);
    expect(normalizeSettings({}).focusMode).toBe(false);
  });
});

describe('voiceChoice', () => {
  const settings = normalizeSettings({ voices: { en: { main: { model: 'kokoro', sid: 3 } } } });

  it('is the same for the same voices, and differs when one changes', () => {
    const available = [voice('kokoro', 3, ['en']), voice('piper-thorsten', 0, ['de'])];
    expect(voiceChoice(settings, available)).toBe(voiceChoice(settings, [...available]));
    const other = normalizeSettings({ voices: { en: { main: { model: 'kokoro', sid: 4 } } } });
    expect(voiceChoice(other, [...available, voice('kokoro', 4, ['en'])])).not.toBe(
      voiceChoice(settings, available),
    );
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

describe('progress', () => {
  const place: Progress = {
    view: 'reading',
    zoom: 1.5,
    page: 3,
    offset: 0.25,
    sentence: { page: 3, index: 7 },
  };

  it('keeps a valid place as it is', () => {
    expect(normalizeProgress(place)).toEqual(place);
  });

  it('repairs what can be repaired and refuses what cannot', () => {
    expect(normalizeProgress(null)).toBeNull();
    expect(normalizeProgress('x')).toBeNull();
    expect(normalizeProgress({ ...place, page: 0 })).toBeNull();
    expect(normalizeProgress({ ...place, page: 2.5 })).toBeNull();
    expect(normalizeProgress({ ...place, view: 'x', zoom: 99, offset: 7 })).toMatchObject({
      view: 'pdf',
      zoom: 5,
      offset: 0.999,
    });
    expect(normalizeProgress({ ...place, zoom: 'big', offset: Number.NaN })).toMatchObject({
      zoom: null,
      offset: 0,
    });
    expect(normalizeProgress({ ...place, sentence: { page: 1 } })?.sentence).toBeNull();
    expect(normalizeProgress({ ...place, sentence: { page: 1, index: -1 } })?.sentence).toBeNull();
  });

  it('reads a store, dropping entries without a valid place or a time', () => {
    const store = parseProgressStore({
      version: 1,
      documents: {
        'a.pdf': { ...place, updated: 5 },
        'b.pdf': { ...place, page: 'one', updated: 6 },
        'c.pdf': { ...place },
        'd.pdf': 'text',
      },
    });
    expect(Object.keys(store.documents)).toEqual(['a.pdf']);
    expect(parseProgressStore('nonsense').documents).toEqual({});
    expect(parseProgressStore({ documents: [1, 2] }).documents).toEqual({});
  });

  it('keeps at most 300 documents and forgets the least recently touched first', () => {
    const store = parseProgressStore(null);
    for (let i = 0; i < PROGRESS_LIMIT; i++) rememberProgress(store, `doc${i}`, place, 1000 + i);
    expect(Object.keys(store.documents)).toHaveLength(PROGRESS_LIMIT);
    // Touching the oldest makes it the newest, so the next one to go is doc1.
    rememberProgress(store, 'doc0', { ...place, page: 9 }, 5000);
    rememberProgress(store, 'new', place, 5001);
    const keys = Object.keys(store.documents);
    expect(keys).toHaveLength(PROGRESS_LIMIT);
    expect(keys).not.toContain('doc1');
    expect(keys).toContain('doc0');
    expect(store.documents['doc0']).toMatchObject({ page: 9, updated: 5000 });
  });
});
