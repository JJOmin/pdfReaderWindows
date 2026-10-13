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
