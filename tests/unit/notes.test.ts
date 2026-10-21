import { describe, expect, it } from 'vitest';
import { parseNotes, reanchor, toMarkdown } from '../../src/shared/notes';
import type { Annotation, NotesFile } from '../../src/shared/types';

const annotation = (over: Partial<Annotation> = {}): Annotation => ({
  id: 'a1',
  page: 2,
  start: 4,
  end: 9,
  text: 'quick',
  quote: 'quick',
  kind: 'highlight',
  color: 'yellow',
  comment: '',
  created: '2026-10-13T00:00:00.000Z',
  ...over,
});

describe('parseNotes', () => {
  it('accepts a valid file and rejects malformed ones', () => {
    const file: NotesFile = { version: 1, notes: 'n', annotations: [annotation({ kind: 'underline' })] };
    expect(parseNotes(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(parseNotes(null)).toBeNull();
    expect(parseNotes({ version: 2, notes: '', annotations: [] })).toBeNull();
    expect(parseNotes({ version: 1, notes: '', annotations: [{ id: 1 }] })).toBeNull();
    for (const bad of [{ color: 'pink' }, { kind: 'circle' }]) {
      expect(parseNotes({ version: 1, notes: '', annotations: [{ ...annotation(), ...bad }] })).toBeNull();
    }
  });

  it('reads files written before marks had a kind and a readable quote', () => {
    const old = { id: 'a1', page: 2, start: 4, end: 9, text: 'qu-ick', color: 'green', comment: 'c' };
    expect(parseNotes({ version: 1, notes: '', annotations: [old] })?.annotations[0]).toMatchObject({
      kind: 'highlight',
      quote: 'qu-ick',
    });
  });
});

describe('reanchor', () => {
  it('keeps, moves or drops an annotation depending on the page text', () => {
    expect(reanchor(annotation(), 'The quick fox')).toEqual(annotation());
    expect(reanchor(annotation(), 'A very quick fox')).toMatchObject({ start: 7, end: 12 });
    expect(reanchor(annotation(), 'Nothing here')).toBeNull();
  });

  it('finds text again where the page has other whitespace, as between PDF.js and the phone’s PDFium', () => {
    // PDF.js has no character at a line end; PDFium has an inserted space, so a mark made on the
    // phone holds "was trained" where the desktop's page reads "wastrained", and the other way round.
    const phone = annotation({ text: 'was trained', start: 0, end: 11 });
    expect(reanchor(phone, 'it wastrained twice')).toMatchObject({ start: 3, end: 13, text: 'wastrained' });
    const desktop = annotation({ text: 'wastrained', start: 0, end: 10 });
    expect(reanchor(desktop, 'it was trained twice')).toMatchObject({
      start: 3,
      end: 14,
      text: 'was trained',
    });
    expect(reanchor(phone, 'it was not trained')).toBeNull();
  });

  it('prefers an exact match, wherever it is', () => {
    expect(reanchor(annotation({ text: 'a b', start: 0, end: 3 }), 'ab a b')).toMatchObject({ start: 3 });
  });

  it('does not match a whitespace-only text', () => {
    expect(reanchor(annotation({ text: '  ', start: 0, end: 2 }), 'a b')).toBeNull();
  });
});

describe('toMarkdown', () => {
  it('groups marks by page in reading order and shows the readable quote', () => {
    const markdown = toMarkdown('paper.pdf', {
      version: 1,
      notes: 'Overall solid.',
      annotations: [
        annotation({ id: 'b', page: 3, text: 'la-terclaim', quote: 'later  claim', comment: 'Check this.' }),
        annotation({ id: 'c', page: 3, start: 50, quote: 'wrong', kind: 'strike' }),
        annotation({ id: 'a', page: 1, quote: 'first claim' }),
      ],
    });
    expect(markdown).toBe(
      [
        '# Notes on paper.pdf',
        '',
        'Overall solid.',
        '',
        '## Page 1',
        '',
        '> first claim',
        '',
        '## Page 3',
        '',
        '> later claim',
        '',
        'Check this.',
        '',
        '> ~~wrong~~',
        '',
      ].join('\n'),
    );
  });
});
