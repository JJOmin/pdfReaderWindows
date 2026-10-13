import {
  LANGS,
  ROLES,
  type Lang,
  type Role,
  type Settings,
  type VoiceOption,
  type VoiceRef,
} from './types.ts';

export const MIN_SPEED = 0.6;
export const MAX_SPEED = 2;

export const defaultSettings = (): Settings => ({
  speed: 1,
  voices: {
    en: {
      main: { model: 'kokoro', sid: 3 },
      quote: { model: 'kokoro', sid: 26 },
      heading: { model: 'kokoro', sid: 16 },
    },
    de: {
      main: { model: 'piper-thorsten', sid: 0 },
      quote: { model: 'supertonic', sid: 5 },
      heading: { model: 'supertonic', sid: 1 },
    },
  },
});

const isVoice = (v: unknown): v is VoiceRef =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as VoiceRef).model === 'string' &&
  Number.isInteger((v as VoiceRef).sid);

/** Builds valid settings from anything read from disk or sent by the renderer. */
export function normalizeSettings(value: unknown): Settings {
  const settings = defaultSettings();
  const input = (typeof value === 'object' && value !== null ? value : {}) as Partial<Settings>;
  if (typeof input.speed === 'number' && Number.isFinite(input.speed)) {
    settings.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, input.speed));
  }
  for (const lang of LANGS) {
    for (const role of ROLES) {
      const voice: unknown = input.voices?.[lang]?.[role];
      if (isVoice(voice)) settings.voices[lang][role] = { model: voice.model, sid: voice.sid };
      else if (voice === null && role !== 'main') settings.voices[lang][role] = null;
    }
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
