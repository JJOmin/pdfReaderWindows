import {
  HIGHLIGHT_COLORS,
  MARK_KINDS,
  type Annotation,
  type MarkBadge,
  type NotesFile,
  type Removal,
} from './types.ts';

const time = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const emptyNotes = (): NotesFile => ({ version: 1, notes: '', annotations: [] });

/**
 * Validates a parsed notes file and fills in fields that older files lack.
 * Returns null for anything that is not a notes file.
 */
export function parseNotes(value: unknown): NotesFile | null {
  const file = value as Partial<NotesFile> | null;
  if (!file || file.version !== 1 || typeof file.notes !== 'string') return null;
  if (!Array.isArray(file.annotations)) return null;
  const annotations: Annotation[] = [];
  for (const a of file.annotations as (Partial<Annotation> | null)[]) {
    const kind = a?.kind ?? 'highlight';
    if (
      !a ||
      typeof a.id !== 'string' ||
      !Number.isInteger(a.page) ||
      !Number.isInteger(a.start) ||
      !Number.isInteger(a.end) ||
      typeof a.text !== 'string' ||
      !HIGHLIGHT_COLORS.includes(a.color!) ||
      !MARK_KINDS.includes(kind) ||
      typeof a.comment !== 'string'
    ) {
      return null;
    }
    const updated = time(a.updated);
    annotations.push({
      id: a.id,
      page: a.page!,
      start: a.start!,
      end: a.end!,
      text: a.text,
      quote: typeof a.quote === 'string' ? a.quote : a.text,
      kind,
      color: a.color!,
      comment: a.comment,
      created: typeof a.created === 'string' ? a.created : '',
      // Between `created` and `updated`, where the phone writes it too.
      ...(a.via === 'speech' ? { via: 'speech' as const } : {}),
      ...(updated === undefined ? {} : { updated }),
    });
  }
  // Entries that are not valid are dropped rather than refusing the file: losing a removal costs
  // a mark coming back, losing the file costs every mark.
  const removed: Removal[] = [];
  for (const r of Array.isArray(file.removed) ? (file.removed as unknown[]) : []) {
    const entry = r as Partial<Removal> | null;
    const updated = time(entry?.updated);
    if (typeof entry?.id === 'string' && updated !== undefined) removed.push({ id: entry.id, updated });
  }
  const notesUpdated = time(file.notesUpdated);
  return {
    version: 1,
    notes: file.notes,
    annotations,
    ...(notesUpdated === undefined ? {} : { notesUpdated }),
    ...(removed.length === 0 ? {} : { removed }),
  };
}

/**
 * A pattern for a mark's text that accepts any whitespace, or none, between any two characters:
 * the desktop's raw string has no character at a line end where the phone's has a space, so a mark
 * from one device holds whitespace the other's page lacks, or the reverse.
 */
const tolerantPattern = (text: string): RegExp | null => {
  const chars = [...text.replace(/\s+/gu, '')];
  return chars.length === 0
    ? null
    : new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s*'), 'u');
};

/**
 * Checks an annotation against the page's raw text and moves it if the text sits elsewhere.
 * Returns null when the text is gone, for example after the PDF was replaced.
 */
export function reanchor(annotation: Annotation, pageRaw: string): Annotation | null {
  if (pageRaw.slice(annotation.start, annotation.end) === annotation.text) return annotation;
  const start = pageRaw.indexOf(annotation.text);
  if (start >= 0) return { ...annotation, start, end: start + annotation.text.length };
  const match = tolerantPattern(annotation.text)?.exec(pageRaw);
  return match
    ? { ...annotation, start: match.index, end: match.index + match[0].length, text: match[0] }
    : null;
}

/**
 * The icon a mark shows above its text: none without a comment, a note for a typed comment and a
 * microphone for one that was spoken. The phone's `markBadge` follows the same rule.
 */
export const markBadge = (a: Annotation): MarkBadge | undefined =>
  a.comment.trim() === '' ? undefined : a.via === 'speech' ? 'speech' : 'note';

export const sortAnnotations = (annotations: Annotation[]): Annotation[] =>
  [...annotations].sort((a, b) => a.page - b.page || a.start - b.start);

/** Renders notes and marks as a Markdown review document. */
export function toMarkdown(title: string, file: NotesFile): string {
  const out = [`# Notes on ${title}`, ''];
  if (file.notes.trim() !== '') out.push(file.notes.trim(), '');
  let page = 0;
  for (const a of sortAnnotations(file.annotations)) {
    if (a.page !== page) {
      page = a.page;
      out.push(`## Page ${page}`, '');
    }
    const quote = a.quote.replace(/\s+/gu, ' ').trim();
    out.push(`> ${a.kind === 'strike' ? `~~${quote}~~` : quote}`, '');
    if (a.comment.trim() !== '') out.push(a.comment.trim(), '');
  }
  return out.join('\n');
}
