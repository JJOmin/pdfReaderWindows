import type { Annotation, NotesFile, Removal } from './types.ts';

/**
 * Notes are merged per mark (ADR 7 section 1, decided by the owner on 2026-10-21). Every mark
 * carries the time it was last changed; a mark that was deleted is kept as a removal, so that the
 * other device does not bring it back; the general notes carry their own time. A file written
 * before these fields has none, and counts as the oldest.
 */

const stamp = (a: Annotation): number => a.updated ?? 0;

/** Two marks' content, without the time of the change. */
const sameContent = (a: Annotation, b: Annotation): boolean =>
  JSON.stringify(withTime(a, undefined)) === JSON.stringify(withTime(b, undefined));

/** A copy of a mark with its time set, or with no time at all, which is not the same as `undefined`. */
const withTime = (a: Annotation, updated: number | undefined): Annotation => {
  const copy = { ...a };
  if (updated === undefined) delete copy.updated;
  else copy.updated = updated;
  return copy;
};

/** A notes file with the fields that are empty left out, so that it reads as it always did. */
function build(
  notes: string,
  annotations: Annotation[],
  notesUpdated: number | undefined,
  removed: Removal[],
): NotesFile {
  return {
    version: 1,
    notes,
    annotations,
    ...(notesUpdated === undefined ? {} : { notesUpdated }),
    ...(removed.length === 0 ? {} : { removed }),
  };
}

/**
 * `next`, a save of the notes, with its changes stamped by comparing it with `previous`, what was
 * stored before: a mark that is new or changed gets `now`, a mark that is gone becomes a removal,
 * and the general notes get `now` if their text changed. The sidebar does not know about any of
 * this, so the main process does it on every save.
 */
export function stampChanges(previous: NotesFile | null, next: NotesFile, now: number): NotesFile {
  const before = new Map((previous?.annotations ?? []).map((a) => [a.id, a]));
  const annotations = next.annotations.map((a): Annotation => {
    const old = before.get(a.id);
    return withTime(a, old && sameContent(old, a) ? (old.updated ?? a.updated) : now);
  });
  const present = new Set(next.annotations.map((a) => a.id));
  const removed = new Map<string, number>();
  for (const r of [...(previous?.removed ?? []), ...(next.removed ?? [])]) {
    removed.set(r.id, Math.max(removed.get(r.id) ?? 0, r.updated));
  }
  for (const a of before.values()) if (!present.has(a.id)) removed.set(a.id, now);
  // A mark that is here again was put back after it was removed: its new stamp wins.
  for (const id of present) removed.delete(id);
  // No file before means no notes before: empty notes stay unstamped.
  const same = (previous?.notes ?? '') === next.notes;
  const notesUpdated = same ? (previous?.notesUpdated ?? next.notesUpdated) : now;
  return build(
    next.notes,
    annotations,
    notesUpdated,
    [...removed].map(([id, updated]) => ({ id, updated })),
  );
}

/**
 * Two devices' notes made into one. Marks are kept by id from both sides, a mark changed on both
 * takes the later change, a removal beats a mark that was not changed after it, and the general
 * notes take the later text. The result does not depend on which side is `a`, apart from the order,
 * which keeps `a`'s marks first.
 */
export function mergeNotes(a: NotesFile, b: NotesFile): NotesFile {
  const removed = new Map<string, number>();
  for (const r of [...(a.removed ?? []), ...(b.removed ?? [])]) {
    removed.set(r.id, Math.max(removed.get(r.id) ?? 0, r.updated));
  }
  const live = new Map<string, Annotation>();
  for (const mark of [...a.annotations, ...b.annotations]) {
    const held = live.get(mark.id);
    // On a tie, the one that sorts later in its JSON, so that both sides agree.
    const later =
      !held ||
      stamp(mark) > stamp(held) ||
      (stamp(mark) === stamp(held) && JSON.stringify(mark) > JSON.stringify(held));
    if (later) live.set(mark.id, mark);
  }
  for (const [id, mark] of live) {
    const removedAt = removed.get(id);
    if (removedAt === undefined) continue;
    if (stamp(mark) > removedAt) removed.delete(id);
    else live.delete(id);
  }
  const order = new Map<string, number>();
  [...a.annotations, ...b.annotations].forEach((m, i) => order.has(m.id) || order.set(m.id, i));
  const annotations = [...live.values()].sort((x, y) => order.get(x.id)! - order.get(y.id)!);
  const aTime = a.notesUpdated ?? 0;
  const bTime = b.notesUpdated ?? 0;
  const takeA = aTime !== bTime ? aTime > bTime : a.notes >= b.notes;
  const winner = takeA ? a : b;
  return build(
    winner.notes,
    annotations,
    winner.notesUpdated,
    [...removed].map(([id, updated]) => ({ id, updated })),
  );
}
