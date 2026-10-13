import {
  LANGS,
  READING_FONTS,
  READING_THEMES,
  ROLES,
  type Lang,
  type ReadingSettings,
  type Role,
  type Settings,
  type VoiceOption,
  type VoiceRef,
} from './types.ts';

export const MIN_SPEED = 0.6;
export const MAX_SPEED = 2;

/** Allowed range of each numeric reading setting: minimum, maximum, slider step. */
export const READING_LIMITS = {
  size: [14, 40, 1],
  lineHeight: [1.2, 2.6, 0.1],
  // Below zero, because some fonts, OpenDyslexic above all, are set very wide already.
  letterSpacing: [-0.08, 0.2, 0.01],
} as const satisfies Record<string, readonly [number, number, number]>;

export const defaultSettings = (): Settings => ({
  speed: 1,
  voices: {
    en: {
      main: { model: 'kokoro', sid: 16 },
      quote: { model: 'kokoro', sid: 2 },
      heading: { model: 'supertonic', sid: 9 },
    },
    de: {
      main: { model: 'supertonic', sid: 9 },
      quote: { model: 'supertonic', sid: 7 },
      heading: { model: 'supertonic', sid: 1 },
    },
  },
  reading: { font: 'Verdana', size: 20, lineHeight: 1.7, letterSpacing: 0.03, theme: 'sepia' },
});

const isVoice = (v: unknown): v is VoiceRef =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as VoiceRef).model === 'string' &&
  Number.isInteger((v as VoiceRef).sid);

const clamp = (value: unknown, [min, max]: readonly [number, number, number], fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** Builds valid settings from anything read from disk or sent by the renderer. */
export function normalizeSettings(value: unknown): Settings {
  const settings = defaultSettings();
  const input = (typeof value === 'object' && value !== null ? value : {}) as Partial<Settings>;
  settings.speed = clamp(input.speed, [MIN_SPEED, MAX_SPEED, 0], settings.speed);
  for (const lang of LANGS) {
    for (const role of ROLES) {
      const voice: unknown = input.voices?.[lang]?.[role];
      if (isVoice(voice)) settings.voices[lang][role] = { model: voice.model, sid: voice.sid };
      else if (voice === null && role !== 'main') settings.voices[lang][role] = null;
    }
  }
  const reading: Partial<ReadingSettings> = typeof input.reading === 'object' ? (input.reading ?? {}) : {};
  if (READING_FONTS.includes(reading.font!)) settings.reading.font = reading.font!;
  if (READING_THEMES.includes(reading.theme!)) settings.reading.theme = reading.theme!;
  for (const key of ['size', 'lineHeight', 'letterSpacing'] as const) {
    settings.reading[key] = clamp(reading[key], READING_LIMITS[key], settings.reading[key]);
  }
  return settings;
}

/**
 * Picks the voice for a sentence from those installed: the role's voice, else the
 * language's main voice, else any voice that speaks the language, else any voice at all.
 */
export function resolveVoice(
  settings: Settings,
  available: VoiceOption[],
  lang: Lang,
  role: Role,
): VoiceRef | undefined {
  const has = (v: VoiceRef | null): v is VoiceRef =>
    v !== null && available.some((o) => o.model === v.model && o.sid === v.sid && o.langs.includes(lang));
  for (const candidate of [settings.voices[lang][role], settings.voices[lang].main]) {
    if (has(candidate)) return candidate;
  }
  return available.find((o) => o.langs.includes(lang)) ?? available[0];
}
