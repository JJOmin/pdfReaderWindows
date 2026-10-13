import {
  LANGS,
  READING_FONTS,
  READING_THEMES,
  ROLES,
  type Lang,
  type Progress,
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

/** The zoom of the PDF pages: smallest and largest PDF.js scale. */
export const ZOOM_LIMITS = [0.3, 5] as const;

/** Documents whose place is remembered; the one not opened for longest is forgotten first. */
export const PROGRESS_LIMIT = 300;

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
  focusMode: false,
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
  if (typeof input.focusMode === 'boolean') settings.focusMode = input.focusMode;
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

const integer = (value: unknown, min: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? value : undefined;

/** Builds a valid place in a document from anything read from disk or sent by the renderer. */
export function normalizeProgress(value: unknown): Progress | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Partial<Record<keyof Progress, unknown>>;
  const page = integer(input.page, 1);
  if (page === undefined) return null;
  const sentence = input.sentence as { page?: unknown; index?: unknown } | null | undefined;
  const sentencePage = integer(sentence?.page, 1);
  const sentenceIndex = integer(sentence?.index, 0);
  return {
    view: input.view === 'reading' ? 'reading' : 'pdf',
    zoom:
      typeof input.zoom === 'number' && Number.isFinite(input.zoom)
        ? Math.min(ZOOM_LIMITS[1], Math.max(ZOOM_LIMITS[0], input.zoom))
        : null,
    page,
    offset:
      typeof input.offset === 'number' && Number.isFinite(input.offset)
        ? Math.min(0.999, Math.max(0, input.offset))
        : 0,
    sentence:
      sentencePage !== undefined && sentenceIndex !== undefined
        ? { page: sentencePage, index: sentenceIndex }
        : null,
  };
}

/** Everything remembered about documents, keyed by their absolute path. */
export interface ProgressStore {
  version: 1;
  documents: Record<string, Progress & { updated: number }>;
}

/** Reads the progress file, which may hold anything: entries that are not valid are dropped. */
export function parseProgressStore(value: unknown): ProgressStore {
  const store: ProgressStore = { version: 1, documents: {} };
  const documents = (value as { documents?: unknown } | null)?.documents;
  if (typeof documents !== 'object' || documents === null) return store;
  for (const [key, entry] of Object.entries(documents)) {
    const progress = normalizeProgress(entry);
    const updated = (entry as { updated?: unknown } | null)?.updated;
    if (progress && typeof updated === 'number' && Number.isFinite(updated)) {
      store.documents[key] = { ...progress, updated };
    }
  }
  return store;
}

/** Records a document's place, and forgets the documents untouched for longest above the limit. */
export function rememberProgress(store: ProgressStore, key: string, progress: Progress, now: number): void {
  store.documents[key] = { ...progress, updated: now };
  const keys = Object.keys(store.documents);
  if (keys.length <= PROGRESS_LIMIT) return;
  const newest = new Set(
    keys.sort((a, b) => store.documents[b]!.updated - store.documents[a]!.updated).slice(0, PROGRESS_LIMIT),
  );
  store.documents = Object.fromEntries(Object.entries(store.documents).filter(([key]) => newest.has(key)));
}
