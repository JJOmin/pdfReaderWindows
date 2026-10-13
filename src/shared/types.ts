export type Lang = 'en' | 'de';
export type Role = 'main' | 'quote' | 'heading';
export const LANGS: readonly Lang[] = ['en', 'de'];
export const ROLES: readonly Role[] = ['main', 'quote', 'heading'];

/** One text run as PDF.js reports it, reduced to what layout needs. PDF units, y grows upwards. */
export interface RawItem {
  str: string;
  x: number;
  y: number;
  height: number;
  font: string;
  hasEOL: boolean;
  rotated: boolean;
}

/**
 * Half-open span of offsets into a page's raw string, which is every item's `str`
 * concatenated in stream order. The text layer DOM holds the same string, so raw
 * offsets are the one coordinate system shared by speech, highlights and annotations.
 */
export type RawRange = readonly [start: number, end: number];

export interface Word {
  text: string;
  ranges: RawRange[];
}

/** One unit handed to the speech engine: a sentence or a heading. */
export interface Utterance {
  page: number;
  /** Text as shown in the PDF. */
  text: string;
  /** Text sent to the engine: citations blanked out, whitespace collapsed. */
  spoken: string;
  lang: Lang;
  role: Role;
  words: Word[];
  ranges: RawRange[];
}

export interface WordTiming {
  start: number;
  end: number;
}

export interface VoiceRef {
  model: string;
  sid: number;
}

export const READING_FONTS = [
  'OpenDyslexic',
  'Lexend',
  'Verdana',
  'Comic Sans MS',
  'Arial',
  'Georgia',
] as const;
export const READING_THEMES = ['light', 'sepia', 'dark'] as const;

/** How the reading view sets its text. */
export interface ReadingSettings {
  font: (typeof READING_FONTS)[number];
  /** Font size in pixels. */
  size: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Extra space between letters, in em. */
  letterSpacing: number;
  theme: (typeof READING_THEMES)[number];
}

export interface Settings {
  /** Multiplier applied on top of every voice. */
  speed: number;
  voices: Record<Lang, Record<Role, VoiceRef | null>>;
  reading: ReadingSettings;
}

export interface VoiceOption extends VoiceRef {
  label: string;
  langs: Lang[];
}

export interface SynthRequest {
  text: string;
  words: string[];
  lang: Lang;
  voice: VoiceRef;
  speed: number;
}

export interface SynthResult {
  samples: Float32Array;
  sampleRate: number;
  timings: WordTiming[];
  /** False when timings are estimated from word lengths instead of measured. */
  aligned: boolean;
}

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'red'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export const MARK_KINDS = ['highlight', 'underline', 'strike'] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export interface Annotation {
  id: string;
  page: number;
  start: number;
  end: number;
  /** The marked slice of the page's raw string, kept so the mark can be found again if offsets shift. */
  text: string;
  /** The same passage as readable text: lines joined, hyphenation undone. Shown to the user. */
  quote: string;
  kind: MarkKind;
  color: HighlightColor;
  comment: string;
  created: string;
}

/** A mark with its place on the page, ready to be written into a PDF. */
export interface ExportMark {
  page: number;
  kind: MarkKind;
  color: HighlightColor;
  comment: string;
  /** One quadrilateral per line of text, in PDF units: top-left, top-right, bottom-left, bottom-right. */
  quads: number[][];
}

export interface NotesFile {
  version: 1;
  notes: string;
  annotations: Annotation[];
}

export interface OpenedPdf {
  name: string;
  data: Uint8Array;
  notes: NotesFile | null;
}

/** The API the preload script exposes to the renderer as `window.api`. */
export interface Api {
  openPdf(): Promise<OpenedPdf | null>;
  openInitial(): Promise<OpenedPdf | null>;
  saveNotes(notes: NotesFile): Promise<void>;
  exportMarkdown(markdown: string): Promise<string | null>;
  /** Asks where to save, then writes a copy of the PDF with the marks as standard annotations. */
  exportPdf(marks: ExportMark[], notes: string): Promise<string | null>;
  voices(): Promise<VoiceOption[]>;
  getSettings(): Promise<Settings>;
  setSettings(settings: Settings): Promise<void>;
  synthesize(request: SynthRequest): Promise<SynthResult>;
}
