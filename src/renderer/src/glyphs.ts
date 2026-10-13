/**
 * Where the PDF draws each character, read from the page's operator list: the same
 * positions the canvas uses. PDF.js's text content does not carry them. It reports one
 * width per run, the sum of the font's nominal advances, while a producer such as Chromium
 * moves the pen glyph by glyph to apply kerning and justification. A text layer laid out
 * from run widths therefore drifts by up to a character inside a line.
 *
 * Pure data in, pure data out, so it is unit tested without a browser.
 */

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** The operator ids this module reads. Pass `pdfjs.OPS`. */
export type TextOps = Readonly<
  Record<
    | 'save'
    | 'restore'
    | 'transform'
    | 'beginText'
    | 'setCharSpacing'
    | 'setWordSpacing'
    | 'setHScale'
    | 'setLeading'
    | 'setFont'
    | 'setTextRise'
    | 'moveText'
    | 'setLeadingMoveText'
    | 'setTextMatrix'
    | 'nextLine'
    | 'showText'
    | 'showSpacedText'
    | 'paintFormXObjectBegin'
    | 'paintFormXObjectEnd'
    | 'beginGroup'
    | 'endGroup',
    number
  >
>;

/** What a font contributes to positions. */
export interface FontMetrics {
  /** `fontMatrix[0]`: glyph units to text space, 0.001 for nearly every font. */
  scale: number;
  vertical: boolean;
}

/** A glyph as the operator list carries it. */
interface ListGlyph {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
}

/** One drawn character, or several for a ligature, in page units (PDF points, y up). */
export interface GlyphBox {
  text: string;
  /** Left edge of the glyph's advance box. NaN when the position could not be worked out. */
  x0: number;
  /** Right edge: the end of the advance, including word spacing for a space. */
  x1: number;
  /** Baseline. */
  y: number;
}

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

interface State {
  ctm: Matrix;
  textMatrix: Matrix | null;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  fontSize: number;
  direction: 1 | -1;
  font: FontMetrics | undefined;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
}

/**
 * Walks a page's operator list the way PDF.js's canvas does and returns every shown glyph
 * with its place on the page, in drawing order. Glyphs that are not horizontal left to
 * right, or whose font is unknown, are returned with NaN positions so the order is kept.
 */
export function glyphBoxes(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  ops: TextOps,
  fontOf: (name: string) => FontMetrics | undefined,
): GlyphBox[] {
  const boxes: GlyphBox[] = [];
  const stack: State[] = [];
  let s: State = {
    ctm: IDENTITY,
    textMatrix: null,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    fontSize: 0,
    direction: 1,
    font: undefined,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
  };
  const save = (): void => void stack.push({ ...s });
  const restore = (): void => {
    s = stack.pop() ?? s;
  };
  const move = (dx: number, dy: number): void => {
    s.x = s.lineX += dx;
    s.y = s.lineY += dy;
  };

  const show = (glyphs: readonly (ListGlyph | number)[]): void => {
    const { font, fontSize } = s;
    if (!font || fontSize === 0) return;
    const advanceScale = fontSize * font.scale;
    const hs = s.hScale * s.direction;
    const m = multiply(s.ctm, s.textMatrix ?? IDENTITY);
    // Only left-to-right text on an upright baseline is placed; the rest keeps PDF.js's layout.
    const upright = !font.vertical && m[0] > 0 && Math.abs(m[1]) < 1e-3 * m[0];
    const at = (local: number): number => m[0] * (s.x + local * hs) + m[2] * (s.y + s.rise) + m[4];
    const baseline = m[1] * s.x + m[3] * (s.y + s.rise) + m[5];
    let local = 0;
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') {
        local -= (glyph * fontSize) / 1000;
        continue;
      }
      const width = glyph.width ?? 0;
      const spacing = (glyph.isSpace ? s.wordSpacing : 0) + s.charSpacing;
      const advance = width * advanceScale;
      const next = local + advance + spacing * s.direction;
      const known = upright && typeof glyph.width === 'number';
      boxes.push({
        text: glyph.unicode ?? '',
        x0: known ? at(local) : NaN,
        // A space owns the gap it leaves, justification included; a letter ends with its advance.
        x1: known ? at(glyph.isSpace ? next : local + advance) : NaN,
        y: known ? baseline : NaN,
      });
      local = next;
    }
    s.x += local * hs;
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]!;
    const args = argsArray[i] as unknown[] | null;
    switch (fn) {
      case ops.save:
      case ops.beginGroup:
        save();
        break;
      case ops.restore:
      case ops.endGroup:
        restore();
        break;
      case ops.transform:
        s.ctm = multiply(s.ctm, args as unknown as Matrix);
        break;
      case ops.paintFormXObjectBegin:
        save();
        if (args?.[0]) s.ctm = multiply(s.ctm, args[0] as Matrix);
        break;
      case ops.paintFormXObjectEnd:
        restore();
        break;
      case ops.beginText:
        s.textMatrix = null;
        s.x = s.lineX = 0;
        s.y = s.lineY = 0;
        break;
      case ops.setTextMatrix:
        s.textMatrix = Array.from(args![0] as ArrayLike<number>) as unknown as Matrix;
        s.x = s.lineX = 0;
        s.y = s.lineY = 0;
        break;
      case ops.moveText:
        move(args![0] as number, args![1] as number);
        break;
      case ops.setLeadingMoveText:
        s.leading = args![1] as number;
        move(args![0] as number, args![1] as number);
        break;
      case ops.setLeading:
        s.leading = -(args![0] as number);
        break;
      case ops.nextLine:
        move(0, s.leading);
        break;
      case ops.setCharSpacing:
        s.charSpacing = args![0] as number;
        break;
      case ops.setWordSpacing:
        s.wordSpacing = args![0] as number;
        break;
      case ops.setHScale:
        s.hScale = (args![0] as number) / 100;
        break;
      case ops.setTextRise:
        s.rise = args![0] as number;
        break;
      case ops.setFont: {
        const size = args![1] as number;
        s.font = fontOf(args![0] as string);
        s.fontSize = Math.abs(size);
        s.direction = size < 0 ? -1 : 1;
        break;
      }
      case ops.showText:
      case ops.showSpacedText:
        show(args![0] as (ListGlyph | number)[]);
        break;
    }
  }
  return boxes;
}

/** Where each character of a page's raw string is drawn. NaN where that is not known. */
export interface Placement {
  x0: Float64Array;
  x1: Float64Array;
  y: Float64Array;
}

/**
 * Lays the glyphs over the raw string. The two sequences agree character for character
 * except where PDF.js inserted a space the PDF does not draw; such a character takes the
 * end of the glyph before it. A glyph the raw string lacks is skipped, and characters
 * with no glyph stay NaN, so one odd glyph costs one place and not the page.
 */
export function placeOnRaw(raw: string, glyphs: readonly GlyphBox[]): Placement {
  const n = raw.length;
  const place: Placement = {
    x0: new Float64Array(n).fill(NaN),
    x1: new Float64Array(n).fill(NaN),
    y: new Float64Array(n).fill(NaN),
  };
  const RESYNC = 4;
  let r = 0;
  let previous: GlyphBox | undefined;
  for (const glyph of glyphs) {
    const { text } = glyph;
    if (text === '') continue;
    let from = r;
    // Spaces PDF.js added between words are not in the glyph stream.
    while (from < n && raw[from] === ' ' && text[0] !== ' ') from++;
    if (!raw.startsWith(text, from)) {
      const found = raw.indexOf(text, r);
      if (found < 0 || found - r > RESYNC) continue;
      from = found;
    }
    for (let i = r; i < from; i++) {
      if (raw[i] === ' ' && previous) {
        place.x0[i] = place.x1[i] = previous.x1;
        place.y[i] = previous.y;
      }
    }
    const step = (glyph.x1 - glyph.x0) / text.length;
    for (let k = 0; k < text.length; k++) {
      place.x0[from + k] = glyph.x0 + step * k;
      place.x1[from + k] = glyph.x0 + step * (k + 1);
      place.y[from + k] = glyph.y;
    }
    r = from + text.length;
    previous = glyph;
  }
  return place;
}

/** A word or a gap of one text run, with the stretch of the page it occupies. */
export interface Segment {
  /** Offsets into the run's text. */
  from: number;
  to: number;
  x0: number;
  x1: number;
}

/**
 * Splits a text run at its spaces into words and gaps, each with its true left and right
 * edge. Undefined when any place is unknown, or the run does not start where PDF.js says
 * it does, so a run that cannot be trusted keeps PDF.js's own layout.
 * `start` is the run's offset into the raw string; `x` and `y` are the run's origin.
 */
export function segmentRun(
  text: string,
  start: number,
  place: Placement,
  origin: { x: number; y: number },
  tolerance = 0.5,
): Segment[] | undefined {
  if (text === '') return undefined;
  const { x0, x1, y } = place;
  // Written so that NaN, an unknown place, fails the comparison.
  if (!(Math.abs(x0[start]! - origin.x) <= tolerance && Math.abs(y[start]! - origin.y) <= tolerance)) {
    return undefined;
  }
  const segments: Segment[] = [];
  let from = 0;
  while (from < text.length) {
    const blank = /\s/u.test(text[from]!);
    let to = from + 1;
    while (to < text.length && /\s/u.test(text[to]!) === blank) to++;
    const left = x0[start + from]!;
    // A gap reaches the next word; a word ends where its last letter does.
    const right = blank && to < text.length ? x0[start + to]! : x1[start + to - 1]!;
    if (!(left <= right + 0.01)) return undefined;
    segments.push({ from, to, x0: left, x1: Math.max(left, right) });
    from = to;
  }
  return segments;
}
