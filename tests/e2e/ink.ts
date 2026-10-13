import type { Page } from '@playwright/test';

/** How far a word's highlight rectangle is from the word's ink on the page canvas, in font heights. */
export interface WordError {
  page: number;
  text: string;
  /** Left edge of the rectangle minus left edge of the ink: positive means the rectangle starts late. */
  left: number;
  /** Right edge of the rectangle minus right edge of the ink: positive means it ends late. */
  right: number;
  /** The larger of the two, absolute. */
  worst: number;
}

export interface Alignment {
  words: WordError[];
  /** Lines whose ink could not be split into as many words as the text layer holds. */
  skippedLines: number;
  /** CSS pixels per PDF point. 4/3 is 100 %. */
  pixelsPerPoint: number;
}

/**
 * Compares the text layer with what the canvas shows, for every pure word on the pages in
 * `pages`. The canvas ink of each line is split into words at gaps of 0.18 em and the n-th ink
 * word is paired with the n-th word of the line's text, so a rectangle that is far off still
 * meets its own word. Run in the page: the function must not use anything outside itself.
 */
export function measureAlignment(page: Page, pages: number[]): Promise<Alignment> {
  return page.evaluate(async (pageNumbers) => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const words: WordError[] = [];
    let skippedLines = 0;
    let pixelsPerPoint = 0;
    for (const pageNumber of pageNumbers) {
      const el = document.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`)!;
      el.scrollIntoView();
      // The canvas is settled when its pixels are as wide as the page box, which a zoom
      // changes only after the new render finished.
      for (let i = 0; i < 100; i++) {
        const canvas = el.querySelector<HTMLCanvasElement>('.canvasWrapper canvas');
        if (
          canvas &&
          Math.abs(canvas.width - Math.round(canvas.getBoundingClientRect().width * devicePixelRatio)) <= 1
        )
          break;
        await sleep(100);
      }
      await sleep(700);
      const canvas = el.querySelector<HTMLCanvasElement>('.canvasWrapper canvas')!;
      const box = canvas.getBoundingClientRect();
      const k = canvas.width / box.width;
      pixelsPerPoint = box.width / 595.92;
      const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const inkAt = (x: number, y: number): boolean => {
        const o = (y * canvas.width + x) * 4;
        return image.data[o]! * 0.3 + image.data[o + 1]! * 0.59 + image.data[o + 2]! * 0.11 < 170;
      };

      interface Token {
        text: string;
        height: number;
        left: number;
        right: number;
        top: number;
        bottom: number;
        pure: boolean;
      }
      const tokens: Token[] = [];
      const walker = document.createTreeWalker(el.querySelector('.textLayer')!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const height = parseFloat(getComputedStyle(node.parentElement!).fontSize);
        for (const match of node.data.matchAll(/\S+/gu)) {
          const range = new Range();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rect = [...range.getClientRects()].find((r) => r.width > 0.5);
          if (!rect) continue;
          tokens.push({
            text: match[0],
            height,
            left: rect.left - box.left,
            right: rect.right - box.left,
            top: rect.top - box.top,
            bottom: rect.bottom - box.top,
            pure: /^\p{L}+$/u.test(match[0]),
          });
        }
      }

      // Lines: the same top, split where the gap is wide (the columns of page 2).
      tokens.sort((a, b) => a.top - b.top || a.left - b.left);
      const lines: { top: number; left: number; right: number; tokens: Token[] }[] = [];
      for (const token of tokens) {
        const line = lines.find(
          (l) =>
            Math.abs(l.top - token.top) < 0.5 * token.height &&
            token.left - l.right < 1.5 * token.height &&
            token.left >= l.left - 1,
        );
        if (line) {
          line.tokens.push(token);
          line.right = Math.max(line.right, token.right);
        } else lines.push({ top: token.top, left: token.left, right: token.right, tokens: [token] });
      }

      for (const line of lines) {
        line.tokens.sort((a, b) => a.left - b.left);
        const height = line.tokens[0]!.height;
        const top = Math.min(...line.tokens.map((t) => t.top));
        const bottom = Math.max(...line.tokens.map((t) => t.bottom));
        const y0 = Math.max(0, Math.floor((top + (bottom - top) * 0.1) * k));
        const y1 = Math.min(canvas.height - 1, Math.ceil((bottom - (bottom - top) * 0.1) * k));
        const x0 = Math.max(0, Math.floor((line.left - 1.2 * height) * k));
        const x1 = Math.min(canvas.width - 1, Math.ceil((line.right + 1.2 * height) * k));
        const gap = Math.max(1, Math.round(0.18 * height * k));
        const clusters: [number, number][] = [];
        let start = -1;
        let last = -1;
        for (let x = x0; x <= x1; x++) {
          let has = false;
          for (let y = y0; y <= y1 && !has; y++) has = inkAt(x, y);
          if (!has) continue;
          if (start < 0) start = x;
          else if (x - last > gap) {
            clusters.push([start, last]);
            start = x;
          }
          last = x;
        }
        if (start >= 0) clusters.push([start, last]);
        if (clusters.length !== line.tokens.length) {
          skippedLines++;
          continue;
        }
        line.tokens.forEach((token, i) => {
          if (!token.pure) return;
          const [from, to] = clusters[i]!;
          const left = (token.left - from / k) / token.height;
          const right = (token.right - (to + 1) / k) / token.height;
          words.push({
            page: pageNumber,
            text: token.text,
            left,
            right,
            worst: Math.max(Math.abs(left), Math.abs(right)),
          });
        });
      }
    }
    return { words, skippedLines, pixelsPerPoint };
  }, pages);
}
