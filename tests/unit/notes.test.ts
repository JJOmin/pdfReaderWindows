import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markBadge, parseNotes, reanchor, toMarkdown } from '../../src/shared/notes';
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

describe('how a comment was made (via)', () => {
  const read = (over: Record<string, unknown>) =>
    parseNotes({ version: 1, notes: '', annotations: [{ ...annotation(), ...over }] })?.annotations[0];

  it('is read, and written back in the place the phone writes it, between created and updated', () => {
    const mark = read({ via: 'speech', updated: 5, comment: 'spoken' })!;
    expect(mark.via).toBe('speech');
    expect(Object.keys(mark).slice(-3)).toEqual(['created', 'via', 'updated']);
  });

  it('is left out of a mark that has none, so that a file written before reads and writes as it did', () => {
    expect('via' in read({})!).toBe(false);
  });

  it('ignores a value this version does not know instead of refusing the file', () => {
    expect('via' in read({ via: 'telepathy' })!).toBe(false);
    expect('via' in read({ via: 3 })!).toBe(false);
  });

  it('matches the golden file the phone also reads, byte for byte', () => {
    const golden = readFileSync('tests/golden/notes-via.json', 'utf8');
    expect(JSON.stringify(parseNotes(JSON.parse(golden)), null, 2)).toBe(golden);
  });
});

describe('markBadge', () => {
  it('shows nothing for a mark without a comment, however it was made', () => {
    expect(markBadge(annotation())).toBeUndefined();
    expect(markBadge(annotation({ comment: '  \n ' }))).toBeUndefined();
    expect(markBadge(annotation({ via: 'speech' }))).toBeUndefined();
  });

  it('shows a note for a written comment and a microphone for a spoken one', () => {
    expect(markBadge(annotation({ comment: 'typed' }))).toBe('note');
    expect(markBadge(annotation({ comment: 'spoken', via: 'speech' }))).toBe('speech');
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
