import { describe, expect, it } from 'vitest';
import { parseNotes, reanchor, toMarkdown } from '../../src/shared/notes';
import type { Annotation, NotesFile } from '../../src/shared/types';

const annotation = (over: Partial<Annotation> = {}): Annotation => ({
  id: 'a1',
  page: 2,
  start: 4,
  end: 9,
  text: 'quick',
  color: 'yellow',
  comment: '',
  created: '2026-10-13T00:00:00.000Z',
  ...over,
});

describe('parseNotes', () => {
  it('accepts a valid file and rejects malformed ones', () => {
    const file: NotesFile = { version: 1, notes: 'n', annotations: [annotation()] };
    expect(parseNotes(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(parseNotes(null)).toBeNull();
    expect(parseNotes({ version: 2, notes: '', annotations: [] })).toBeNull();
    expect(parseNotes({ version: 1, notes: '', annotations: [{ id: 1 }] })).toBeNull();
    expect(
      parseNotes({ version: 1, notes: '', annotations: [annotation({ color: 'pink' as never })] }),
    ).toBeNull();
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
  it('groups highlights by page in reading order', () => {
    const markdown = toMarkdown('paper.pdf', {
      version: 1,
      notes: 'Overall solid.',
      annotations: [
        annotation({ id: 'b', page: 3, text: 'later  claim', comment: 'Check this.' }),
        annotation({ id: 'a', page: 1, text: 'first claim' }),
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
      ].join('\n'),
    );
  });
});
