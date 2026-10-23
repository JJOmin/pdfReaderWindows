import { describe, expect, it } from 'vitest';
import { mergeNotes, stampChanges } from '../../src/shared/notes-merge';
import { parseNotes } from '../../src/shared/notes';
import type { Annotation, NotesFile } from '../../src/shared/types';

const mark = (id: string, over: Partial<Annotation> = {}): Annotation => ({
  id,
  page: 1,
  start: 0,
  end: 5,
  text: 'quick',
  quote: 'quick',
  kind: 'highlight',
  color: 'yellow',
  comment: '',
  created: '2026-10-13T00:00:00.000Z',
  ...over,
});
const file = (annotations: Annotation[], extra: Partial<NotesFile> = {}): NotesFile => ({
  version: 1,
  notes: '',
  annotations,
  ...extra,
});
const ids = (f: NotesFile): string[] => f.annotations.map((a) => a.id).sort();

describe('stampChanges', () => {
  it('stamps a new mark, keeps an unchanged one, and re-stamps an edited one', () => {
    const before = file([mark('a', { updated: 100 }), mark('b', { updated: 100 })]);
    const after = file([mark('a'), mark('b', { comment: 'edited' }), mark('c')]);
    const stamped = stampChanges(before, after, 500);
    const updated = Object.fromEntries(stamped.annotations.map((a) => [a.id, a.updated]));
    // "a" came back without its stamp, as the sidebar rebuilds marks: it is the same mark.
    expect(updated).toEqual({ a: 100, b: 500, c: 500 });
  });

  it('records a mark that is gone as removed, and keeps what was removed before', () => {
    const before = file([mark('a', { updated: 100 }), mark('b', { updated: 100 })], {
      removed: [{ id: 'old', updated: 50 }],
    });
    const stamped = stampChanges(before, file([mark('b', { updated: 100 })]), 500);
    expect(stamped.removed).toEqual([
      { id: 'old', updated: 50 },
      { id: 'a', updated: 500 },
    ]);
  });

  it('stamps the general notes only when their text changed', () => {
    const before = file([], { notes: 'one', notesUpdated: 100 });
    expect(stampChanges(before, file([], { notes: 'one' }), 500).notesUpdated).toBe(100);
    expect(stampChanges(before, file([], { notes: 'two' }), 500).notesUpdated).toBe(500);
  });

  it('starts from nothing, and leaves the fields out where there is nothing to say', () => {
    const stamped = stampChanges(null, file([mark('a')]), 500);
    expect(stamped.annotations[0]!.updated).toBe(500);
    expect(stamped).not.toHaveProperty('removed');
    // A file with no marks and no notes stays as the desktop always wrote it.
    expect(JSON.stringify(stampChanges(null, file([]), 500))).toBe(JSON.stringify(file([])));
  });
});

describe('mergeNotes', () => {
  it('keeps marks that are new on either side', () => {
    const merged = mergeNotes(file([mark('a', { updated: 1 })]), file([mark('b', { updated: 2 })]));
    expect(ids(merged)).toEqual(['a', 'b']);
  });

  it('takes the later edit of a mark changed on both sides, whichever side it is', () => {
    const phone = file([mark('a', { comment: 'phone', updated: 200 })]);
    const desk = file([mark('a', { comment: 'desktop', updated: 100 })]);
    expect(mergeNotes(phone, desk).annotations[0]!.comment).toBe('phone');
    expect(mergeNotes(desk, phone).annotations[0]!.comment).toBe('phone');
  });

  it('keeps a deleted mark deleted, even where the other side still has it', () => {
    const gone = file([], { removed: [{ id: 'a', updated: 300 }] });
    const still = file([mark('a', { comment: 'edited before', updated: 200 })]);
    for (const merged of [mergeNotes(gone, still), mergeNotes(still, gone)]) {
      expect(ids(merged)).toEqual([]);
      expect(merged.removed).toEqual([{ id: 'a', updated: 300 }]);
    }
  });

  it('lets an edit made after the deletion bring the mark back', () => {
    const gone = file([], { removed: [{ id: 'a', updated: 300 }] });
    const later = file([mark('a', { comment: 'back', updated: 400 })]);
    const merged = mergeNotes(gone, later);
    expect(merged.annotations.map((a) => a.comment)).toEqual(['back']);
    expect(merged.removed).toBeUndefined();
  });

  it('treats a mark without a stamp, as the desktop wrote before, as the oldest', () => {
    const merged = mergeNotes(file([mark('a')]), file([mark('a', { comment: 'newer', updated: 1 })]));
    expect(merged.annotations[0]!.comment).toBe('newer');
    expect(
      mergeNotes(file([mark('a')]), file([], { removed: [{ id: 'a', updated: 1 }] })).annotations,
    ).toEqual([]);
  });

  it('takes the later general notes', () => {
    const a = file([], { notes: 'phone', notesUpdated: 200 });
    const b = file([], { notes: 'desktop', notesUpdated: 100 });
    expect(mergeNotes(a, b).notes).toBe('phone');
    expect(mergeNotes(b, a).notes).toBe('phone');
    expect(mergeNotes(a, b).notesUpdated).toBe(200);
  });

  it('gives the same marks whichever side is merged into which, and changes nothing merged with itself', () => {
    const a = file([mark('a', { updated: 5 }), mark('b', { comment: 'x', updated: 9 })], {
      removed: [{ id: 'z', updated: 4 }],
      notes: 'n',
      notesUpdated: 3,
    });
    const b = file([mark('b', { comment: 'y', updated: 8 }), mark('c', { updated: 1 })], {
      removed: [{ id: 'a', updated: 6 }],
    });
    const ab = mergeNotes(a, b);
    const ba = mergeNotes(b, a);
    expect(ids(ab)).toEqual(ids(ba));
    expect(ab.annotations.find((m) => m.id === 'b')!.comment).toBe('x');
    expect(ids(ab)).toEqual(['b', 'c']);
    expect(mergeNotes(ab, ab)).toEqual(ab);
  });

  it('keeps this side’s order and puts the other side’s new marks after', () => {
    const merged = mergeNotes(
      file([mark('z', { updated: 1 }), mark('a', { updated: 1 })]),
      file([mark('m', { updated: 1 })]),
    );
    expect(merged.annotations.map((a) => a.id)).toEqual(['z', 'a', 'm']);
  });
});

describe('how a comment was made (via)', () => {
  it('travels with the mark through a merge, so a spoken comment stays spoken on the other device', () => {
    const spoken = mark('a', { comment: 'spoken', via: 'speech', updated: 200 });
    const merged = mergeNotes(file([mark('a', { updated: 100 })]), file([spoken]));
    expect(merged.annotations[0]).toEqual(spoken);
    expect(mergeNotes(file([spoken]), file([mark('a', { updated: 100 })])).annotations[0]).toEqual(spoken);
  });

  it('counts as a change: marking a comment as spoken re-stamps the mark', () => {
    const before = file([mark('a', { comment: 'c', updated: 100 })]);
    const after = file([mark('a', { comment: 'c', via: 'speech', updated: 100 })]);
    expect(stampChanges(before, after, 500).annotations[0]!.updated).toBe(500);
  });

  it('is not lost when the mark is stamped again unchanged', () => {
    const before = file([mark('a', { comment: 'c', via: 'speech', updated: 100 })]);
    const again = stampChanges(before, file([mark('a', { comment: 'c', via: 'speech' })]), 500);
    expect(again.annotations[0]).toMatchObject({ via: 'speech', updated: 100 });
  });
});

describe('the new fields in a notes file', () => {
  it('are read and written back, and a file without them is read as it was', () => {
    const full = file([mark('a', { updated: 100 })], {
      notes: 'n',
      notesUpdated: 90,
      removed: [{ id: 'gone', updated: 80 }],
    });
    expect(parseNotes(JSON.parse(JSON.stringify(full)))).toEqual(full);
    const old = parseNotes({ version: 1, notes: '', annotations: [mark('a')] });
    expect(old).toEqual(file([mark('a')]));
    expect(old?.annotations[0]).not.toHaveProperty('updated');
  });

  it('drops entries that are not valid, instead of refusing the file', () => {
    const parsed = parseNotes({
      version: 1,
      notes: '',
      notesUpdated: 'soon',
      annotations: [{ ...mark('a'), updated: 'x' }],
      removed: [{ id: 'ok', updated: 1 }, { id: 3, updated: 1 }, { id: 'nan', updated: Number.NaN }, null],
    });
    expect(parsed?.removed).toEqual([{ id: 'ok', updated: 1 }]);
    expect(parsed?.annotations[0]).not.toHaveProperty('updated');
    expect(parsed).not.toHaveProperty('notesUpdated');
  });
});
