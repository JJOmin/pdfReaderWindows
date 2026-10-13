import type { RawItem } from './types.ts';

/** Options for PDF.js `getTextContent` that yield the same strings as its text layer. */
export const TEXT_CONTENT_OPTIONS = { includeMarkedContent: true, disableNormalization: true } as const;

/** The parts of a PDF.js text content entry that layout reads. Marked-content markers have no `str`. */
interface PdfTextEntry {
  type?: string;
  str?: string;
  transform?: number[];
  height?: number;
  fontName?: string;
  hasEOL?: boolean;
}

/** Converts PDF.js text content into layout items. `bottom` is the page's lower edge in PDF units. */
export function toRawItems(entries: readonly PdfTextEntry[], bottom: number): RawItem[] {
  const items: RawItem[] = [];
  for (const entry of entries) {
    if (entry.str === undefined) continue;
    const [a = 1, b = 0, c = 0, d = 1, x = 0, y = 0] = entry.transform ?? [];
    items.push({
      str: entry.str,
      x,
      y: y - bottom,
      height: entry.height || Math.hypot(c, d),
      font: entry.fontName ?? '',
      hasEOL: entry.hasEOL ?? false,
      rotated: Math.abs(b) > 0.01 * Math.abs(a) || a <= 0,
    });
  }
  return items;
}

/** The page's raw string: the coordinate system of every RawRange. */
export const rawString = (items: readonly RawItem[]): string => items.map((i) => i.str).join('');
