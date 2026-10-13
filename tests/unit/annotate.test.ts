import { PDFDocument } from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { annotate, parseMarks } from '../../src/main/annotate';
import type { ExportMark } from '../../src/shared/types';

/** A quad for one line of text from (x, y) to (x + w, y + h). */
const quad = (x: number, y: number, w: number, h: number): number[] => [
  x,
  y + h,
  x + w,
  y + h,
  x,
  y,
  x + w,
  y,
];

const mark = (over: Partial<ExportMark> = {}): ExportMark => ({
  page: 1,
  kind: 'highlight',
  color: 'yellow',
  comment: '',
  quads: [quad(100, 700, 80, 12)],
  ...over,
});

async function blankPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return doc.save();
}

/** Reads the annotations back with PDF.js, the way another PDF reader would. */
async function annotationsOf(pdf: Uint8Array, page: number): Promise<Record<string, unknown>[]> {
  const task = getDocument({ data: pdf.slice(), verbosity: 0 });
  const annotations = await (await (await task.promise).getPage(page)).getAnnotations();
  await task.destroy();
  return annotations;
}

describe('annotate', () => {
  it('writes each kind of mark as a standard annotation with its comment and an appearance', async () => {
    const out = await annotate(
      await blankPdf(2),
      [
        mark({ comment: 'Prüfen: größer?' }),
        mark({ kind: 'underline', color: 'red', quads: [quad(100, 650, 80, 12), quad(100, 636, 40, 12)] }),
        mark({ page: 2, kind: 'strike', color: 'blue' }),
      ],
      '',
    );
    const [highlight, underline] = await annotationsOf(out, 1);
    expect(highlight).toMatchObject({ subtype: 'Highlight', hasAppearance: true });
    expect((highlight!.contentsObj as { str: string }).str).toBe('Prüfen: größer?');
    expect(highlight!.rect).toEqual([100, 700, 180, 712]);
    expect(underline).toMatchObject({ subtype: 'Underline', hasAppearance: true });
    // Two lines of text give two quads and a rectangle around both.
    expect(underline!.quadPoints).toHaveLength(16);
    expect(underline!.rect).toEqual([100, 636, 180, 662]);
    expect(await annotationsOf(out, 2)).toMatchObject([{ subtype: 'StrikeOut' }]);
  });

  it('adds the general notes as a sticky note on the first page', async () => {
    const out = await annotate(await blankPdf(1), [], '  Overall solid.  ');
    const [note] = await annotationsOf(out, 1);
    expect(note).toMatchObject({ subtype: 'Text' });
    expect((note!.contentsObj as { str: string }).str).toBe('Overall solid.');
  });

  it('leaves the PDF without annotations when there is nothing to add, and skips unknown pages', async () => {
    const out = await annotate(await blankPdf(1), [mark({ page: 9 }), mark({ quads: [] })], '');
    expect(await annotationsOf(out, 1)).toEqual([]);
  });
});

describe('parseMarks', () => {
  it('accepts valid marks and rejects malformed ones', () => {
    expect(parseMarks([mark()])).toEqual([mark()]);
    expect(() => parseMarks('nope')).toThrow();
    expect(() => parseMarks([mark({ kind: 'circle' as never })])).toThrow();
    expect(() => parseMarks([mark({ quads: [[1, 2, 3]] })])).toThrow();
    expect(() => parseMarks([mark({ quads: [[1, 2, 3, 4, 5, 6, 7, Number.NaN]] })])).toThrow();
  });
});
