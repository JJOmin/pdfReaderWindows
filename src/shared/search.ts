import { rawRanges, type Block } from './layout.ts';
import type { RawRange } from './types.ts';

/**
 * Finds a phrase in a page's readable text, ignoring case. Searching the readable text
 * rather than the raw string lets a phrase match across a line break or a hyphenated word.
 * Each match is returned as the raw ranges it covers on the page.
 */
export function findInBlocks(blocks: readonly Block[], query: string): RawRange[][] {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  const pattern = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'giu');
  const matches: RawRange[][] = [];
  for (const block of blocks) {
    for (const match of block.text.matchAll(pattern)) {
      const ranges = rawRanges(block.raw, match.index, match.index + match[0].length);
      if (ranges.length > 0) matches.push(ranges);
    }
  }
  return matches;
}
