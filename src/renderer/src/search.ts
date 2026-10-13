import { findInBlocks } from '../../shared/search';
import type { RawRange } from '../../shared/types';
import { paint } from './highlights';
import type { Pdf } from './pdf';
import type { TextView } from './view';

/** Enough for any real query; a single letter in a long book would otherwise produce far more. */
const MAX_MATCHES = 5000;

interface Match {
  page: number;
  ranges: RawRange[];
}

/** Finds a phrase in the whole document and steps through the matches. */
export class Search {
  private matches: Match[] = [];
  private current = -1;
  /** Bumped by every new query, so an older search still running gives up. */
  private token = 0;

  constructor(
    private readonly pdf: Pdf,
    private readonly view: () => TextView,
    private readonly reveal: (page: number, ranges: readonly RawRange[]) => void,
    /** `current` counts from 1, and is 0 when there is no match. */
    private readonly onChange: (current: number, total: number) => void,
  ) {}

  async find(query: string): Promise<void> {
    const token = ++this.token;
    this.matches = [];
    this.current = -1;
    const from = this.view().currentPage;
    for (let page = 1; query.trim() !== '' && page <= this.pdf.pageCount; page++) {
      const { blocks } = await this.pdf.pageBlocks(page);
      if (token !== this.token) return;
      const first = this.matches.length;
      for (const ranges of findInBlocks(blocks, query)) this.matches.push({ page, ranges });
      // Start at the first match on or after the page on screen, not at the top of the document.
      if (this.current < 0 && page >= from && this.matches.length > first) this.select(first);
      if (this.matches.length >= MAX_MATCHES) break;
    }
    if (this.current < 0 && this.matches.length > 0) this.select(0);
    this.paint();
    this.onChange(this.current + 1, this.matches.length);
  }

  step(direction: 1 | -1): void {
    const total = this.matches.length;
    if (total > 0) this.select((this.current + direction + total) % total);
  }

  private select(index: number): void {
    this.current = index;
    const match = this.matches[index]!;
    this.reveal(match.page, match.ranges);
    this.paint();
    this.onChange(index + 1, this.matches.length);
  }

  /** Repaints the matches on the pages that are on screen. */
  paint(): void {
    const view = this.view();
    const current = this.matches[this.current];
    paint(
      'search-match',
      this.matches.flatMap((m) => view.domRanges(m.page, m.ranges)),
      3,
    );
    paint('search-current', current ? view.domRanges(current.page, current.ranges) : [], 4);
  }
}
