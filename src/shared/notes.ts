import { HIGHLIGHT_COLORS, type Annotation, type NotesFile } from './types.ts';

export const emptyNotes = (): NotesFile => ({ version: 1, notes: '', annotations: [] });

/** Validates a parsed notes file. Returns null for anything that is not one. */
export function parseNotes(value: unknown): NotesFile | null {
  const file = value as Partial<NotesFile> | null;
  if (!file || file.version !== 1 || typeof file.notes !== 'string') return null;
  if (!Array.isArray(file.annotations)) return null;
  const valid = file.annotations.every(
    (a: Partial<Annotation> | null) =>
      a &&
      typeof a.id === 'string' &&
      Number.isInteger(a.page) &&
      Number.isInteger(a.start) &&
      Number.isInteger(a.end) &&
      typeof a.text === 'string' &&
      HIGHLIGHT_COLORS.includes(a.color!) &&
      typeof a.comment === 'string',
  );
  return valid ? (file as NotesFile) : null;
}

/**
 * Checks an annotation against the page's raw text and moves it if the text sits elsewhere.
 * Returns null when the text is gone, for example after the PDF was replaced.
 */
export function reanchor(annotation: Annotation, pageRaw: string): Annotation | null {
  if (pageRaw.slice(annotation.start, annotation.end) === annotation.text) return annotation;
  const start = pageRaw.indexOf(annotation.text);
  return start < 0 ? null : { ...annotation, start, end: start + annotation.text.length };
}

export const sortAnnotations = (annotations: Annotation[]): Annotation[] =>
  [...annotations].sort((a, b) => a.page - b.page || a.start - b.start);

/** Renders notes and highlights as a Markdown review document. */
export function toMarkdown(title: string, file: NotesFile): string {
  const out = [`# Notes on ${title}`, ''];
  if (file.notes.trim() !== '') out.push(file.notes.trim(), '');
  let page = 0;
  for (const a of sortAnnotations(file.annotations)) {
    if (a.page !== page) {
      page = a.page;
      out.push(`## Page ${page}`, '');
    }
    out.push(`> ${a.text.replace(/\s+/gu, ' ').trim()}`, '');
    if (a.comment.trim() !== '') out.push(a.comment.trim(), '');
  }
  return out.join('\n');
}
