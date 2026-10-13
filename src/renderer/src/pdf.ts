import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { guessLang } from '../../shared/language';
import { rawString, TEXT_CONTENT_OPTIONS, toRawItems } from '../../shared/items';
import { layoutPage, type Block } from '../../shared/layout';
import type { Lang, RawRange, Utterance } from '../../shared/types';
import { buildUtterances } from '../../shared/utterances';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// The PDF.js worker resolves these itself, so they must be absolute.
const asset = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href;

export interface PageText {
  /** Every text run of the page concatenated: the string raw offsets point into. */
  raw: string;
  utterances: Utterance[];
}

interface TextIndex {
  nodes: Text[];
  starts: number[];
}

/** The PDF view plus everything that maps between page text and the screen. */
export class Pdf {
  readonly events = new EventBus();
  readonly container = document.querySelector<HTMLDivElement>('#scroller')!;
  private readonly viewer: PDFViewer;
  private readonly links: PDFLinkService;
  private task: pdfjs.PDFDocumentLoadingTask | undefined;
  private doc: pdfjs.PDFDocumentProxy | undefined;
  private blocks = new Map<number, Promise<{ raw: string; blocks: Block[] }>>();
  private pages = new Map<number, Promise<PageText>>();
  /** Raw strings of the pages read so far, for the synchronous DOM mapping below. */
  private raws = new Map<number, string>();
  private lang: Promise<Lang> | undefined;
  private indexes = new WeakMap<Element, TextIndex>();

  constructor() {
    this.links = new PDFLinkService({ eventBus: this.events });
    this.viewer = new PDFViewer({
      container: this.container,
      viewer: document.querySelector<HTMLDivElement>('#pages')!,
      eventBus: this.events,
      linkService: this.links,
    });
    this.links.setViewer(this.viewer);
    this.events.on('pagesinit', () => (this.viewer.currentScaleValue = 'page-width'));
  }

  get pageCount(): number {
    return this.doc?.numPages ?? 0;
  }

  get currentPage(): number {
    return this.viewer.currentPageNumber;
  }

  async open(data: Uint8Array): Promise<void> {
    const old = this.task;
    this.task = pdfjs.getDocument({
      data,
      cMapUrl: asset('cmaps'),
      standardFontDataUrl: asset('standard_fonts'),
      wasmUrl: asset('wasm'),
      iccUrl: asset('iccs'),
    });
    this.doc = await this.task.promise;
    this.blocks.clear();
    this.pages.clear();
    this.raws.clear();
    this.lang = undefined;
    this.viewer.setDocument(this.doc);
    this.links.setDocument(this.doc);
    void old?.destroy();
  }

  zoom(factor: number): void {
    this.viewer.currentScale = Math.min(5, Math.max(0.3, this.viewer.currentScale * factor));
  }

  showPage(page: number): void {
    this.viewer.scrollPageIntoView({ pageNumber: page });
  }

  private pageBlocks(page: number): Promise<{ raw: string; blocks: Block[] }> {
    let result = this.blocks.get(page);
    if (!result) {
      result = (async () => {
        const proxy = await this.doc!.getPage(page);
        // Same options as the text layer, so both see identical strings.
        const content = await proxy.getTextContent(TEXT_CONTENT_OPTIONS);
        const [, bottom = 0, , top = 0] = proxy.view;
        const items = toRawItems(content.items, bottom);
        const raw = rawString(items);
        this.raws.set(page, raw);
        return { raw, blocks: layoutPage(items, top - bottom) };
      })();
      this.blocks.set(page, result);
    }
    return result;
  }

  /** The document's main language, judged from its first pages. */
  private documentLang(): Promise<Lang> {
    this.lang ??= (async () => {
      const sample: string[] = [];
      for (let page = 1; page <= Math.min(5, this.pageCount); page++) {
        sample.push(...(await this.pageBlocks(page)).blocks.map((b) => b.text));
      }
      return guessLang(sample.join(' ')).lang;
    })();
    return this.lang;
  }

  pageText(page: number): Promise<PageText> {
    let result = this.pages.get(page);
    if (!result) {
      result = (async () => {
        const [{ raw, blocks }, lang] = await Promise.all([this.pageBlocks(page), this.documentLang()]);
        return { raw, utterances: buildUtterances(blocks, page, lang) };
      })();
      this.pages.set(page, result);
    }
    return result;
  }

  /** The raw string of a page, once its text has been read. */
  rawOf(page: number): string | undefined {
    return this.raws.get(page);
  }

  /** The text nodes of a page's rendered text layer, or undefined while it is not on screen. */
  private textIndex(page: number): TextIndex | undefined {
    const rawLength = this.raws.get(page)?.length;
    const layer = this.container.querySelector(`.page[data-page-number="${page}"] .textLayer`);
    if (!layer || rawLength === undefined) return undefined;
    let index = this.indexes.get(layer);
    if (!index || index.nodes[0]?.isConnected === false) {
      index = { nodes: [], starts: [] };
      let length = 0;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        index.nodes.push(node as Text);
        index.starts.push(length);
        length += (node as Text).length;
      }
      // A layer that is still rendering holds only part of the page.
      if (length !== rawLength) return undefined;
      this.indexes.set(layer, index);
    }
    return index;
  }

  /** DOM ranges covering raw ranges of a page. Empty while the page's text is not rendered. */
  domRanges(page: number, ranges: readonly RawRange[]): Range[] {
    const index = this.textIndex(page);
    if (!index) return [];
    const locate = (offset: number): number => {
      let lo = 0;
      let hi = index.starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (index.starts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    return ranges.map(([start, end]) => {
      const range = new Range();
      const first = locate(start);
      const last = locate(end - 1);
      range.setStart(index.nodes[first]!, start - index.starts[first]!);
      range.setEnd(index.nodes[last]!, end - index.starts[last]!);
      return range;
    });
  }

  /** The page and raw span a DOM range covers. Selections spanning pages are cut to the first. */
  rawSpan(range: Range): { page: number; start: number; end: number; text: string } | undefined {
    const { startContainer } = range;
    const element = startContainer instanceof Element ? startContainer : startContainer.parentElement;
    const page = Number(element?.closest<HTMLElement>('.page')?.dataset.pageNumber);
    const index = this.textIndex(page);
    if (!index) return undefined;
    let from = -1;
    let to = -1;
    index.nodes.forEach((node, i) => {
      if (!range.intersectsNode(node)) return;
      const base = index.starts[i]!;
      if (from < 0) from = base + (node === range.startContainer ? range.startOffset : 0);
      to = base + (node === range.endContainer ? range.endOffset : node.length);
    });
    if (from < 0 || to <= from) return undefined;
    return { page, start: from, end: to, text: this.raws.get(page)!.slice(from, to) };
  }
}
