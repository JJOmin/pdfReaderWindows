import type { RawRange } from '../../shared/types';

/** A stretch of a page's raw string, with the raw text it covers. */
export interface Span {
  page: number;
  start: number;
  end: number;
  text: string;
}

/**
 * One way of showing the document's text: the PDF pages or the reading view. Both map
 * between raw ranges and the screen, so speech, marks and search work the same in either.
 */
export interface TextView {
  /** The element that scrolls. */
  readonly container: HTMLElement;
  readonly currentPage: number;
  showPage(page: number): void;
  /** DOM ranges covering raw ranges of a page. Empty while that page is not on screen. */
  domRanges(page: number, ranges: readonly RawRange[]): Range[];
  /** The page and raw span a DOM range covers. A range spanning pages is cut to the first. */
  rawSpan(range: Range): Span | undefined;
}

/** One rectangle per line of text a range covers, in client coordinates. */
export function lineRects(range: Range): DOMRect[] {
  // A range reports a rectangle per text node and per fully covered element, so lines repeat.
  const rects = [...range.getClientRects()]
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: DOMRect[] = [];
  for (const rect of rects) {
    const line = lines.at(-1);
    const overlap = line ? Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) : 0;
    if (line && overlap > 0.5 * Math.min(line.height, rect.height)) {
      const left = Math.min(line.left, rect.left);
      const top = Math.min(line.top, rect.top);
      lines[lines.length - 1] = new DOMRect(
        left,
        top,
        Math.max(line.right, rect.right) - left,
        Math.max(line.bottom, rect.bottom) - top,
      );
    } else {
      lines.push(rect);
    }
  }
  return lines;
}
