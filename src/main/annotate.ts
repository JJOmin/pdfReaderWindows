import {
  closePath,
  fill,
  lineTo,
  moveTo,
  PDFDocument,
  PDFHexString,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFOperator,
} from '@cantoo/pdf-lib';
import { HIGHLIGHT_COLORS, MARK_KINDS, type ExportMark, type HighlightColor } from '../shared/types';

const SUBTYPE = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' } as const;
/** Fill colours for highlights, and stronger tones of the same hues for lines. */
const FILL: Record<HighlightColor, [number, number, number]> = {
  yellow: [1, 0.87, 0.2],
  green: [0.55, 0.88, 0.57],
  blue: [0.55, 0.78, 1],
  red: [1, 0.6, 0.6],
};
const LINE: Record<HighlightColor, [number, number, number]> = {
  yellow: [0.83, 0.66, 0],
  green: [0.18, 0.62, 0.23],
  blue: [0.12, 0.5, 0.88],
  red: [0.88, 0.19, 0.19],
};
/** Where on a line of text the stroke sits, as a fraction of the line's height from its bottom. */
const LINE_HEIGHT = { underline: 0.1, strike: 0.4 } as const;
const MAX_MARKS = 20_000;

/** Checks marks received from the renderer. Anything malformed is an error, not silently skipped. */
export function parseMarks(value: unknown): ExportMark[] {
  if (!Array.isArray(value) || value.length > MAX_MARKS) throw new Error('Invalid marks');
  return value.map((mark: Partial<ExportMark> | null) => {
    const quads = mark?.quads;
    if (
      !mark ||
      !Number.isInteger(mark.page) ||
      !MARK_KINDS.includes(mark.kind!) ||
      !HIGHLIGHT_COLORS.includes(mark.color!) ||
      typeof mark.comment !== 'string' ||
      !Array.isArray(quads) ||
      !quads.every((q) => Array.isArray(q) && q.length === 8 && q.every((n) => Number.isFinite(n)))
    ) {
      throw new Error('Invalid mark');
    }
    return { page: mark.page!, kind: mark.kind!, color: mark.color!, comment: mark.comment, quads };
  });
}

/**
 * Returns a copy of the PDF with the marks added as standard annotations, which any PDF
 * reader shows. The document's general notes become a sticky note on the first page.
 */
export async function annotate(pdf: Uint8Array, marks: ExportMark[], notes: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const pages = doc.getPages();
  const now = PDFString.fromDate(new Date());

  for (const mark of marks) {
    const page = pages[mark.page - 1];
    if (!page || mark.quads.length === 0) continue;
    const xs = mark.quads.flatMap((q) => [q[0]!, q[2]!, q[4]!, q[6]!]);
    const ys = mark.quads.flatMap((q) => [q[1]!, q[3]!, q[5]!, q[7]!]);
    const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const color = mark.kind === 'highlight' ? FILL[mark.color] : LINE[mark.color];

    // The appearance is drawn here rather than left to each reader, so the mark looks the same everywhere.
    const drawing: PDFOperator[] = [pushGraphicsState()];
    for (const [tlx, tly, trx, try_, blx, bly, brx, bry] of mark.quads as number[][]) {
      if (mark.kind === 'highlight') {
        drawing.push(
          setGraphicsState('Multiply'),
          setFillingRgbColor(...color),
          moveTo(blx!, bly!),
          lineTo(brx!, bry!),
          lineTo(trx!, try_!),
          lineTo(tlx!, tly!),
          closePath(),
          fill(),
        );
      } else {
        const t = LINE_HEIGHT[mark.kind];
        const height = Math.hypot(tlx! - blx!, tly! - bly!);
        drawing.push(
          setStrokingRgbColor(...color),
          setLineWidth(Math.max(0.6, height * 0.07)),
          moveTo(blx! + (tlx! - blx!) * t, bly! + (tly! - bly!) * t),
          lineTo(brx! + (trx! - brx!) * t, bry! + (try_! - bry!) * t),
          stroke(),
        );
      }
    }
    drawing.push(popGraphicsState());
    const appearance = doc.context.register(
      doc.context.formXObject(drawing, {
        BBox: rect,
        // Multiply lets the text show through a highlight instead of being painted over.
        Resources: { ExtGState: { Multiply: { Type: 'ExtGState', BM: 'Multiply' } } },
      }),
    );

    page.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: SUBTYPE[mark.kind],
          Rect: rect,
          QuadPoints: mark.quads.flat(),
          C: color,
          Contents: PDFHexString.fromText(mark.comment),
          M: now,
          F: 4, // Print the mark along with the page.
          P: page.ref,
          AP: { N: appearance },
        }),
      ),
    );
  }

  const first = pages[0];
  if (first && notes.trim() !== '') {
    const box = first.getCropBox();
    const top = box.y + box.height;
    first.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Name: 'Comment',
          Rect: [box.x + 12, top - 36, box.x + 36, top - 12],
          C: FILL.yellow,
          Contents: PDFHexString.fromText(notes.trim()),
          M: now,
          F: 4,
          P: first.ref,
        }),
      ),
    );
  }
  return doc.save();
}
