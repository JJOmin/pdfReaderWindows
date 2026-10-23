import type { SyncFacts } from './sync-state.ts';
import type { PreparedSentence } from './phone-library.ts';
import type { Backend } from './sync-config.ts';

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
  /** Set for a word of a sentence's continuation on the next page (ADR 12); else the utterance's page. */
  page?: number;
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
  /** The part of a sentence that runs over the page break, on the next page (ADR 12). */
  next?: { page: number; ranges: RawRange[] };
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
  /** While reading aloud, keep the spoken sentence in the middle of the view. */
  focusMode: boolean;
  /** Fade each sentence in and out and cut rumble below the voice, when it is played. */
  polish: boolean;
  /** Reading aloud ends at the reference list's heading (backlog 5). */
  stopAtReferences: boolean;
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
  /** When it was last changed, in milliseconds. Set when notes are saved; older files have none. */
  updated?: number;
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

/** A mark that was deleted, kept so that another device does not bring it back (ADR 7 section 1). */
export interface Removal {
  id: string;
  updated: number;
}

export interface NotesFile {
  version: 1;
  notes: string;
  annotations: Annotation[];
  /** When the general notes were last changed. */
  notesUpdated?: number;
  removed?: Removal[];
}

/** Where the user was in a document, so that it opens there again. */
export interface Progress {
  view: 'pdf' | 'reading';
  /** The pages' zoom as PDF.js counts it, 1 being 100 %, or null for fit to width. */
  zoom: number | null;
  /** The page at the top of the view, and how far down it the top edge lies, from 0 to 1. */
  page: number;
  offset: number;
  /** The sentence the voice read last: its page and its place among that page's sentences. */
  sentence: { page: number; index: number } | null;
}

/** Another device's newer place in a prepared document, offered when it opens (ADR 7 section 8). */
export interface PlaceOffer {
  /** The device's name, such as "Galaxy S20 FE". */
  from: string;
  page: number;
  offset: number;
  /** The sentence it read last, as an index among this page's sentences here. */
  sentence: { page: number; index: number } | null;
}

export interface OpenedPdf {
  /** Names this opening of a file; progress is saved against it, never against a path. */
  id: number;
  name: string;
  data: Uint8Array;
  notes: NotesFile | null;
  progress: Progress | null;
  offer: PlaceOffer | null;
}

/** Where the phone library is kept in sync (ADR 8). */
export interface SyncStatus {
  backend: Backend;
  /** Who is signed in: `user at server`, empty when nothing is connected. */
  account: string;
  /** Syncs on its own (ADR 10 section 3). */
  auto: boolean;
}

/** A phone a document can be sent to (ADR 10 section 6). */
export interface SendTarget {
  device: string;
  name: string;
}

/** A document in the phone library, for the list of what is synced. */
export interface SyncedDocument {
  docId: string;
  name: string;
  /** False after "Stop syncing". */
  synced: boolean;
}

export interface SyncReport {
  /** Documents in the phone library. */
  documents: number;
  /** Of those, how many were sent now. The rest were already in the store. */
  uploaded: number;
  /** Files from other devices that this key cannot open. */
  unreadable: number;
}

/** The phone server of ADR 7, as the Phone dialog shows it. */
export interface PhoneServerStatus {
  /** Switched on by the user; off by default. */
  enabled: boolean;
  /** Listening now. False while switched on means `error` says why. */
  running: boolean;
  error: string;
  /** The code the user types on the phone, `XXXX-XXXX-XXXX`; empty while switched off. */
  code: string;
  /**
   * What the QR code holds while the dialog is open (ADR 10 section 5); empty otherwise. It carries a
   * secret that proves a phone saw this screen, so it is shown, never logged or saved.
   */
  pairingUrl: string;
  port: number;
  /** This computer's addresses, for typing on a network that blocks multicast. */
  addresses: string[];
  /** Interfaces that look like a VPN, which usually keeps the phone from connecting. */
  vpn: string[];
  /** `seen`: when the phone last asked for anything this session, 0 if it has not. */
  phones: { device: string; name: string; paired: number; seen: number }[];
}

export type PhoneEvent = { kind: 'pair'; name: string } | { kind: 'changed' };

/** The API the preload script exposes to the renderer as `window.api`. */
export interface Api {
  openPdf(): Promise<OpenedPdf | null>;
  openInitial(): Promise<OpenedPdf | null>;
  /** A PDF dropped on the window. */
  openDropped(file: File): Promise<OpenedPdf | null>;
  saveNotes(notes: NotesFile): Promise<void>;
  exportMarkdown(markdown: string): Promise<string | null>;
  /** Asks where to save, then writes a copy of the PDF with the marks as standard annotations. */
  exportPdf(marks: ExportMark[], notes: string): Promise<string | null>;
  voices(): Promise<VoiceOption[]>;
  getSettings(): Promise<Settings>;
  setSettings(settings: Settings): Promise<void>;
  /** Remembers where the user is in the document that opening `id` gave. Stale ids are ignored. */
  saveProgress(id: number, progress: Progress): Promise<void>;
  synthesize(request: SynthRequest): Promise<SynthResult>;
  /**
   * Renders a sentence with a GPU voice into the cache without returning the audio, so that
   * `synthesize` finds it later. Runs behind any sentence somebody is waiting for.
   */
  prerender(request: SynthRequest): Promise<void>;
  /**
   * Phone library (ADR 7): stores a sentence's Ogg Opus audio for the document that opening `id`
   * gave. The main process names the file by the sentence's sync key.
   */
  addPhoneAudio(id: number, text: string, audio: Uint8Array): Promise<void>;
  /** Writes a page's index once its audio is stored. The last page writes the PDF and the manifest. */
  addPhonePage(
    id: number,
    page: number,
    pages: number,
    sentences: PreparedSentence[],
    voices: string,
  ): Promise<void>;
  /**
   * Puts the open PDF in the phone library without audio, if it is not there (ADR 11). Says which
   * pages have audio already, and made by which voices.
   */
  addToLibrary(id: number, pages: number): Promise<{ voiced: number[]; voices: string }>;
  syncStatus(): Promise<SyncStatus>;
  /**
   * Signs in to Nextcloud at the server's address, in the system browser. Resolves when the user
   * has approved, and rejects when they cancel or it times out.
   */
  syncConnect(backend: 'nextcloud', server: string): Promise<SyncStatus>;
  /** Stops a sign-in that is waiting for the browser. */
  syncCancel(): Promise<void>;
  /** Forgets the sign-in. The files in the store stay where they are. */
  syncDisconnect(): Promise<SyncStatus>;
  /** The key that encrypts the store, for entering on another device. Made on first use. */
  syncKey(): Promise<string>;
  /** Replaces the key with one from another device. Returns the key as stored. */
  syncSetKey(key: string): Promise<string>;
  /** Switches syncing on its own on or off. */
  syncSetAuto(on: boolean): Promise<SyncStatus>;
  /** The prepared documents and whether each is synced. */
  syncDocuments(): Promise<SyncedDocument[]>;
  /** "Stop syncing" or "Sync this document" for a prepared document, without preparing it again. */
  syncSetDocument(docId: string, synced: boolean): Promise<SyncedDocument[]>;
  /**
   * Sends the phone library to the store and fetches what the other devices changed. `full` walks
   * the whole store instead of asking the change journals (ADR 10 section 2).
   */
  syncRun(full?: boolean): Promise<SyncReport>;
  phoneServer(): Promise<PhoneServerStatus>;
  /** Switches phone sync on the local network on or off (ADR 7). It stays so across restarts. */
  phoneServerEnable(on: boolean): Promise<PhoneServerStatus>;
  /** Forgets a paired phone; its token stops working at once. */
  phoneRemove(device: string): Promise<PhoneServerStatus>;
  /** The Phone dialog opened or closed: pairing requests are answered only while it is open. */
  phonePairing(open: boolean): Promise<void>;
  /** The phones the open document can be sent to. */
  sendTargets(): Promise<SendTarget[]>;
  /** Offers the open, prepared document to a phone; it asks its user. Resolves to the phone's name. */
  sendToPhone(device: string): Promise<string>;
  /** A phone asks to pair (answer with `phoneAnswer`), or the paired phones changed. */
  onPhoneEvent(listener: (event: PhoneEvent) => void): void;
  phoneAnswer(accept: boolean): Promise<void>;
  /** A PDF opened from outside the window, from Finder or the Mac's File menu: show it. */
  onOpened(listener: (opened: OpenedPdf) => void): void;
  /** What the sync button shows, apart from a document being prepared in the window. */
  syncState(): Promise<SyncFacts>;
  /** Something the sync button shows may have changed: ask `syncState` again. */
  onSyncChanged(listener: () => void): void;
  /** "Send to Phone…" in the app menu: open the Phone dialog at "Send to". */
  onSendMenu(listener: () => void): void;
  /** A phone's marks were merged into the open document's notes: show these. */
  onNotesChanged(listener: (notes: NotesFile) => void): void;
}
