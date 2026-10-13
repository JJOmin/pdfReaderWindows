import { describe, expect, it } from 'vitest';
import { glyphBoxes, placeOnRaw, segmentRun, type TextOps } from '../../src/renderer/src/glyphs';

// Any distinct numbers will do: the module only compares against them.
const ops: TextOps = {
  save: 1,
  restore: 2,
  transform: 3,
  beginText: 4,
  setCharSpacing: 5,
  setWordSpacing: 6,
  setHScale: 7,
  setLeading: 8,
  setFont: 9,
  setTextRise: 10,
  moveText: 11,
  setLeadingMoveText: 12,
  setTextMatrix: 13,
  nextLine: 14,
  showText: 15,
  showSpacedText: 16,
  paintFormXObjectBegin: 17,
  paintFormXObjectEnd: 18,
  beginGroup: 19,
  endGroup: 20,
};

type Op = [number, unknown];
const glyph = (unicode: string, width: number, isSpace = unicode === ' '): object => ({
  unicode,
  width,
  isSpace,
});
const run = (list: Op[]): ReturnType<typeof glyphBoxes> =>
  glyphBoxes(
    list.map(([fn]) => fn),
    list.map(([, args]) => args),
    ops,
    () => ({ scale: 0.001, vertical: false }),
  );

describe('glyphBoxes', () => {
  it('advances by the glyph width and applies the pen moves between glyphs', () => {
    // Size 10, so a 600-unit glyph is 6 wide. The pen moves 5 after "V": kerning.
    const boxes = run([
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.setTextMatrix, [[1, 0, 0, 1, 100, 700]]],
      [ops.showText, [[glyph('V', 600)]]],
      [ops.moveText, [5, 0]],
      [ops.showText, [[glyph('o', 500)]]],
    ]);
    expect(boxes.map((b) => [b.text, b.x0, b.x1, b.y])).toEqual([
      ['V', 100, 106, 700],
      ['o', 105, 110, 700],
    ]);
  });

  it('reads TJ adjustments, word spacing and horizontal scaling', () => {
    const boxes = run([
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.setWordSpacing, [3]],
      [ops.setHScale, [50]],
      [ops.setTextMatrix, [[1, 0, 0, 1, 0, 0]]],
      // "a", a pull of 200/1000 em to the left (a gap), then a space and "b".
      [ops.showSpacedText, [[glyph('a', 500), 200, glyph(' ', 250), glyph('b', 500)]]],
    ]);
    // Everything is halved by the horizontal scale. The space is 2.5 wide plus 3 of word spacing.
    expect(boxes.map((b) => [b.text, b.x0, b.x1])).toEqual([
      ['a', 0, 2.5],
      [' ', (5 - 200 * 0.01) / 2, (5 - 2 + 2.5 + 3) / 2],
      ['b', (5 - 2 + 2.5 + 3) / 2, (5 - 2 + 2.5 + 3 + 5) / 2],
    ]);
  });

  it('applies the current transform and restores it with the graphics state', () => {
    const boxes = run([
      [ops.save, null],
      [ops.transform, [2, 0, 0, 2, 10, 0]],
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.showText, [[glyph('a', 1000)]]],
      [ops.restore, null],
      // The font is part of the graphics state too, so it is gone after the restore.
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.showText, [[glyph('b', 1000)]]],
    ]);
    expect(boxes.map((b) => [b.x0, b.x1])).toEqual([
      [10, 30],
      [0, 10],
    ]);
  });

  it('gives no position to rotated text but keeps it in the sequence', () => {
    const boxes = run([
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.setTextMatrix, [[0, 1, -1, 0, 50, 50]]],
      [ops.showText, [[glyph('a', 500)]]],
    ]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.x0).toBeNaN();
  });
});

describe('placeOnRaw', () => {
  const box = (
    text: string,
    x0: number,
    x1: number,
  ): { text: string; x0: number; x1: number; y: number } => ({
    text,
    x0,
    x1,
    y: 0,
  });

  it('puts every character of the raw string on its glyph', () => {
    const place = placeOnRaw('ab c', [box('a', 0, 5), box('b', 5, 10), box(' ', 10, 13), box('c', 13, 18)]);
    expect([...place.x0]).toEqual([0, 5, 10, 13]);
    expect([...place.x1]).toEqual([5, 10, 13, 18]);
  });

  it('gives a space PDF.js added the end of the glyph before it', () => {
    const place = placeOnRaw('a b', [box('a', 0, 5), box('b', 9, 14)]);
    expect([place.x0[1], place.x1[1]]).toEqual([5, 5]);
    expect(place.x0[2]).toBe(9);
  });

  it('splits a ligature over its characters', () => {
    const place = placeOnRaw('fi', [box('fi', 0, 10)]);
    expect([...place.x0]).toEqual([0, 5]);
  });

  it('skips a glyph the raw string lacks and carries on', () => {
    const place = placeOnRaw('ab', [box('a', 0, 5), box('#', 5, 6), box('b', 6, 11)]);
    expect([...place.x0]).toEqual([0, 6]);
  });

  it('leaves characters without a glyph unknown', () => {
    const place = placeOnRaw('abc', [box('a', 0, 5), box('c', 10, 15)]);
    expect(place.x0[1]).toBeNaN();
  });
});

describe('segmentRun', () => {
  const place = placeOnRaw('ab cd', [
    { text: 'a', x0: 10, x1: 15, y: 50 },
    { text: 'b', x0: 15, x1: 20, y: 50 },
    { text: ' ', x0: 20, x1: 28, y: 50 },
    { text: 'c', x0: 28, x1: 33, y: 50 },
    { text: 'd', x0: 33, x1: 38, y: 50 },
  ]);

  it('splits a run into words and the gaps between them', () => {
    expect(segmentRun('ab cd', 0, place, { x: 10, y: 50 })).toEqual([
      { from: 0, to: 2, x0: 10, x1: 20 },
      { from: 2, to: 3, x0: 20, x1: 28 },
      { from: 3, to: 5, x0: 28, x1: 38 },
    ]);
  });

  it('refuses a run that does not start where PDF.js put it', () => {
    expect(segmentRun('ab cd', 0, place, { x: 40, y: 50 })).toBeUndefined();
    expect(segmentRun('ab cd', 0, place, { x: 10, y: 80 })).toBeUndefined();
  });

  it('refuses a run whose edge it does not know', () => {
    const partial = placeOnRaw('abc', [
      { text: 'a', x0: 0, x1: 5, y: 0 },
      { text: 'b', x0: 5, x1: 10, y: 0 },
    ]);
    expect(segmentRun('abc', 0, partial, { x: 0, y: 0 })).toBeUndefined();
  });
});
