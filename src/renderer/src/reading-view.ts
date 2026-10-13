import '@fontsource/lexend/400.css';
import '@fontsource/lexend/700.css';
import '@fontsource/opendyslexic/400.css';
import '@fontsource/opendyslexic/700.css';
import { blockSpans, rawRanges } from '../../shared/layout';
import { READING_LIMITS } from '../../shared/settings';
import { READING_FONTS, READING_THEMES, type RawRange, type ReadingSettings } from '../../shared/types';
import type { Pdf } from './pdf';
import type { Span, TextView } from './view';

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

/**
 * The document as plain, restyled text: one section per page, one element per paragraph or
 * heading. Each element holds a single text node with the block's readable text, so a
 * position in a block's text is a position in the DOM.
 */
export class ReadingView implements TextView {
  readonly container = $('#reading');
  private readonly article = $('#reading-text');
  /** Bumped when another document is loaded, so a build in progress stops. */
  private generation = 0;
  private built = false;
  /** A page asked for before its text was built: scrolled to as soon as it appears. */
  private wanted: { page: number; offset: number } | undefined;

  constructor(
    private readonly pdf: Pdf,
    /** Called as each page's text appears, so marks on it can be painted. */
    private readonly onPage: (page: number) => void,
  ) {}

  /** Forgets the text of the previous document. */
  reset(): void {
    this.generation++;
    this.built = false;
    this.article.replaceChildren();
  }

  /**
   * Builds the text of the open document, page by page, unless that is done or under way.
   * Called when the view is shown, so a document only read as PDF never pays for it.
   */
  async build(): Promise<void> {
    if (this.built) return;
    this.built = true;
    const generation = this.generation;
    for (let page = 1; page <= this.pdf.pageCount; page++) {
      const { blocks } = await this.pdf.pageBlocks(page);
      if (generation !== this.generation) return;
      const section = document.createElement('section');
      section.dataset.page = String(page);
      for (const block of blocks) {
        const element = document.createElement(block.heading ? 'h2' : 'p');
        element.textContent = block.text;
        section.append(element);
      }
      this.article.append(section);
      if (this.wanted?.page === page) this.showPage(page, this.wanted.offset);
      this.onPage(page);
    }
  }

  get currentPage(): number {
    const line = this.container.getBoundingClientRect().top + 80;
    let page = 1;
    for (const section of this.article.children) {
      if (section.getBoundingClientRect().top > line) break;
      page = Number((section as HTMLElement).dataset.page);
    }
    return page;
  }

  showPage(page: number, offset = 0): void {
    const section = this.article.children[page - 1];
    this.wanted = section ? undefined : { page, offset };
    if (!section) return;
    section.scrollIntoView({ block: 'start' });
    if (offset <= 0) return;
    const box = section.getBoundingClientRect();
    this.container.scrollTop += box.top + offset * box.height - this.container.getBoundingClientRect().top;
  }

  /** True once the page asked for last has appeared, so that the scroll position means something. */
  get settled(): boolean {
    return this.wanted === undefined && this.article.children.length > 0;
  }

  scrollAnchor(): { page: number; offset: number } {
    const top = this.container.getBoundingClientRect().top;
    let anchor = { page: 1, offset: 0 };
    for (const section of this.article.children) {
      const box = section.getBoundingClientRect();
      if (box.top > top + 1) break;
      anchor = {
        page: Number((section as HTMLElement).dataset.page),
        offset: Math.min(0.999, Math.max(0, (top - box.top) / box.height)),
      };
    }
    return anchor;
  }

  domRanges(page: number, ranges: readonly RawRange[]): Range[] {
    const section = this.article.children[page - 1];
    const blocks = this.pdf.loadedPage(page)?.blocks;
    if (!section || !blocks) return [];
    return ranges.flatMap(([start, end]) =>
      blockSpans(blocks, start, end).map((span) => {
        const text = section.children[span.block]!.firstChild!;
        const range = new Range();
        range.setStart(text, span.from);
        range.setEnd(text, span.to);
        return range;
      }),
    );
  }

  rawSpan(range: Range): Span | undefined {
    const { startContainer } = range;
    const element = startContainer instanceof Element ? startContainer : startContainer.parentElement;
    const section = element?.closest<HTMLElement>('section[data-page]');
    const page = Number(section?.dataset.page);
    const text = this.pdf.loadedPage(page);
    if (!section || !text) return undefined;
    let from = -1;
    let to = -1;
    [...section.children].forEach((child, i) => {
      const node = child.firstChild as Text;
      if (!range.intersectsNode(node)) return;
      const covered = rawRanges(
        text.blocks[i]!.raw,
        node === range.startContainer ? range.startOffset : 0,
        node === range.endContainer ? range.endOffset : node.length,
      );
      if (covered.length === 0) return;
      if (from < 0) from = covered[0]![0];
      to = covered.at(-1)![1];
    });
    return from < 0 ? undefined : { page, start: from, end: to, text: text.raw.slice(from, to) };
  }

  /** Applies the text settings and wires the controls that change them. */
  bindControls(settings: ReadingSettings, onChange: () => void): void {
    const apply = (): void => {
      this.container.dataset.theme = settings.theme;
      const { style } = this.container;
      style.setProperty('--reading-font', `"${settings.font}"`);
      style.setProperty('--reading-size', `${settings.size}px`);
      style.setProperty('--reading-line-height', String(settings.lineHeight));
      style.setProperty('--reading-letter-spacing', `${settings.letterSpacing}em`);
    };
    const select = <K extends 'font' | 'theme'>(key: K, options: readonly ReadingSettings[K][]): void => {
      const control = $<HTMLSelectElement>(`#reading-${key}`);
      for (const option of options)
        control.add(new Option(option[0]!.toUpperCase() + option.slice(1), option));
      control.value = settings[key];
      control.addEventListener('change', () => {
        settings[key] = control.value as ReadingSettings[K];
        apply();
        onChange();
      });
    };
    select('font', READING_FONTS);
    select('theme', READING_THEMES);
    for (const key of ['size', 'lineHeight', 'letterSpacing'] as const) {
      const control = $<HTMLInputElement>(`#reading-${key}`);
      [control.min, control.max, control.step] = READING_LIMITS[key].map(String) as [string, string, string];
      control.value = String(settings[key]);
      control.addEventListener('input', () => {
        settings[key] = Number(control.value);
        apply();
      });
      control.addEventListener('change', onChange);
    }
    apply();
  }
}
