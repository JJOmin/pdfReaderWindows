import type { RawItem, RawRange } from './types.ts';

/** A paragraph or heading in reading order, with each character traced back to the page. */
export interface Block {
  text: string;
  /** Raw offset of each character of `text`, or -1 for characters layout inserted. */
  raw: number[];
  heading: boolean;
}

interface Line {
  text: string;
  raw: number[];
  y: number;
  size: number;
  font: string;
}

const HEADER_ZONE = 0.935;
const FOOTER_ZONE = 0.065;
const NUMBERED_HEADING = /^(\d+(\.\d+)*\.?|[IVX]+\.)\s+\p{Lu}/u;
/** A figure's or table's caption, which is read although it is set small (backlog 1). */
const CAPTION = /^(fig(ure|\.)?|table|tab\.|abb(ildung|\.)|tabelle)\s*[\dIVX]/iu;
/** Text this much smaller than the body, without a sentence's end, is a label inside a figure. */
const FIGURE_SIZE = 0.88;
/** Below this share of letters among the visible characters a block is a table row or a formula. */
const SYMBOLIC = 0.5;
const MATH_OPERATOR = /[=<>≤≥≈≠∑Σ∏∫∂√∞∈∉±×÷^]/u;
/** A word of three letters or more. A formula has at most two, such as "max" and "log". */
const PROSE_WORD = /\p{L}{3,}/gu;

function dominant<T>(entries: Iterable<readonly [T, number]>): T | undefined {
  const weights = new Map<T, number>();
  for (const [key, weight] of entries) weights.set(key, (weights.get(key) ?? 0) + weight);
  let best: T | undefined;
  let bestWeight = -1;
  for (const [key, weight] of weights) {
    if (weight > bestWeight) [best, bestWeight] = [key, weight];
  }
  return best;
}

function toLines(items: RawItem[]): Line[] {
  const lines: Line[] = [];
  let parts: { item: RawItem; offset: number }[] = [];
  const flush = (): void => {
    const visible = parts.filter((p) => p.item.str.trim() !== '');
    if (visible.length > 0) {
      let text = '';
      const raw: number[] = [];
      for (const { item, offset } of parts) {
        let at = offset;
        for (const ch of item.str) {
          // Normalising per character keeps the map exact when a ligature expands.
          for (const unit of ch.normalize('NFKC')) {
            text += unit;
            for (let i = 0; i < unit.length; i++) raw.push(at);
          }
          at += ch.length;
        }
      }
      lines.push({
        text,
        raw,
        y: visible[0]!.item.y,
        size: dominant(visible.map((p) => [Math.round(p.item.height * 2) / 2, p.item.str.length]))!,
        font: dominant(visible.map((p) => [p.item.font, p.item.str.length]))!,
      });
    }
    parts = [];
  };

  let offset = 0;
  for (const item of items) {
    // Rotated runs are margin stamps such as the arXiv identifier, never body text.
    if (!item.rotated) {
      const last = parts.at(-1)?.item;
      if (last && item.str.trim() !== '' && Math.abs(item.y - last.y) > 2 * last.height) flush();
      parts.push({ item, offset });
    }
    offset += item.str.length;
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

/** Joins a line onto its block: undoes line-break hyphenation, otherwise adds a space. */
function appendLine(block: { text: string; raw: number[] }, line: Line): void {
  const text = line.text.trimStart();
  const raw = line.raw.slice(line.text.length - text.length);
  const lastWord = /(\S+)-$/u.exec(block.text)?.[1];
  const nextWord = /^\S+/u.exec(text)?.[0] ?? '';
  if (lastWord !== undefined && /^\p{Ll}/u.test(nextWord)) {
    if (/^(und|oder|bzw\.?|and|or)$/u.test(nextWord)) {
      // "Vor- und Nachteile": the hyphen stands for an omitted word part.
      block.text += ' ';
      block.raw.push(-1);
    } else if (!lastWord.includes('-')) {
      // shortcut: "state-of-the-" + "art" keeps its hyphen, a plain "Ent-" + "wicklung"
      // loses it. Wrong for a compound broken at its only hyphen before a lower-case
      // part; upgrade to a dictionary lookup if that shows up in real papers.
      block.text = block.text.slice(0, -1);
      block.raw.pop();
    }
  } else if (block.text !== '' && !/[-\s]$/u.test(block.text)) {
    block.text += ' ';
    block.raw.push(-1);
  }
  block.text += text;
  block.raw.push(...raw);
}

/**
 * Text that is not read (backlog 1 and 2): a label inside a figure (smaller than the body, no
 * sentence end, short), a table row (mostly digits and symbols), or a displayed formula (a math
 * operator and hardly a word of prose). Fonts
 * are not asked: PDF.js and PDFium name them differently, and the phone must leave out the same text.
 */
function notProse(text: string, size: number, bodySize: number, unterminated: boolean): boolean {
  const visible = text.replace(/\s/gu, '');
  const letters = (visible.match(/\p{L}/gu) ?? []).length;
  const symbolic = visible.length >= 3 && letters / visible.length < SYMBOLIC;
  const label = unterminated && text.length <= 80 && size <= bodySize * FIGURE_SIZE;
  const formula =
    text.length <= 150 && MATH_OPERATOR.test(text) && (text.match(PROSE_WORD) ?? []).length <= 2;
  return symbolic || label || formula;
}

/**
 * Turns one page's text runs into paragraphs and headings, dropping running headers and footers, and
 * figure labels, table rows and displayed formulas.
 */
export function layoutPage(items: RawItem[], pageHeight: number): Block[] {
  const lines = toLines(items);
  const bodySize = dominant(lines.map((l) => [l.size, l.text.length])) ?? 0;
  const bodyFont = dominant(lines.map((l) => [l.font, l.text.length]));

  const groups: Line[][] = [];
  for (const line of lines) {
    const group = groups.at(-1);
    const prev = group?.at(-1);
    const gap = prev ? prev.y - line.y : 0;
    const size = prev ? Math.max(prev.size, line.size) : 0;
    const sameBlock =
      prev !== undefined &&
      Math.abs(prev.size - line.size) <= 0.7 &&
      gap > 0 &&
      gap <= 1.9 * size &&
      !(prev.font !== line.font && gap > 1.35 * size);
    if (sameBlock) group!.push(line);
    else groups.push([line]);
  }

  const blocks: Block[] = [];
  for (const group of groups) {
    const block = { text: '', raw: [] as number[] };
    for (const line of group) appendLine(block, line);
    block.text = block.text.trimEnd();
    block.raw.length = block.text.length;

    const first = group[0]!;
    const inMargin = first.y > pageHeight * HEADER_ZONE || group.at(-1)!.y < pageHeight * FOOTER_ZONE;
    if (block.text === '' || (inMargin && block.text.length < 150)) continue;

    const short = block.text.length <= 200 && group.length <= 3;
    const unterminated = !/[.!?:,;]$/u.test(block.text);
    const larger = first.size >= bodySize * 1.12;
    const numbered = group.length === 1 && block.text.length <= 100 && NUMBERED_HEADING.test(block.text);
    const titleLike =
      group.length === 1 && first.font !== bodyFont && block.text.length <= 60 && /^\p{Lu}/u.test(block.text);
    const heading = short && unterminated && (larger || numbered || titleLike);
    // A numbered section heading in small capitals is smaller than the body, but no figure label.
    // `heading` is not asked: it depends on font names, which the phone sees differently.
    const kept = larger || CAPTION.test(block.text) || NUMBERED_HEADING.test(block.text);
    if (!kept && notProse(block.text, first.size, bodySize, unterminated)) {
      continue;
    }
    blocks.push({ ...block, heading });
  }
  return blocks;
}

/** Collapses the raw offsets behind `text[start..end)` into contiguous page ranges. */
export function rawRanges(raw: readonly number[], start: number, end: number): RawRange[] {
  const ranges: [number, number][] = [];
  for (let i = start; i < end; i++) {
    const at = raw[i]!;
    if (at < 0) continue;
    const last = ranges.at(-1);
    // A ligature maps several characters to one offset, which extends nothing.
    if (last && (at === last[1] || at === last[1] - 1)) last[1] = at + 1;
    else ranges.push([at, at + 1]);
  }
  return ranges;
}

/** A stretch of one block's readable text. */
export interface BlockSpan {
  block: number;
  from: number;
  to: number;
}

/** The inverse of `rawRanges`: where the page's raw range `[start, end)` shows up in the blocks' text. */
export function blockSpans(blocks: readonly Block[], start: number, end: number): BlockSpan[] {
  const inside = (at: number): boolean => at >= start && at < end;
  return blocks.flatMap((block, index) => {
    const from = block.raw.findIndex(inside);
    return from < 0 ? [] : [{ block: index, from, to: block.raw.findLastIndex(inside) + 1 }];
  });
}

/** The readable text behind a raw range: lines joined and hyphenation undone. */
export const readableText = (blocks: readonly Block[], start: number, end: number): string =>
  blockSpans(blocks, start, end)
    .map((span) => blocks[span.block]!.text.slice(span.from, span.to))
    .join(' ');
