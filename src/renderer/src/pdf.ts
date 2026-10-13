import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { guessLang } from '../../shared/language';
import { rawString, TEXT_CONTENT_OPTIONS, toRawItems } from '../../shared/items';
import { layoutPage, type Block } from '../../shared/layout';
import type { Lang, RawRange, Utterance } from '../../shared/types';
import { buildUtterances } from '../../shared/utterances';
import { lineRects, type Span, type TextView } from './view';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// The PDF.js worker resolves these itself, so they must be absolute.
const asset = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/** A page's text before it is split into sentences. */
export interface PageBlocks {
  /** Every text run of the page concatenated: the string raw offsets point into. */
  raw: string;
  blocks: Block[];
}

/** The text nodes of a rendered text layer and the raw offset each starts at. */
interface TextIndex {
  nodes: Text[];
  starts: number[];
  length: number;
}

function indexText(layer: Element): TextIndex {
  const index: TextIndex = { nodes: [], starts: [], length: 0 };
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    index.nodes.push(node as Text);
    index.starts.push(index.length);
    index.length += (node as Text).length;
  }
  return index;
}

function toDomRanges(index: TextIndex, ranges: readonly RawRange[]): Range[] {
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

/** The open document: its text, and the view that shows its pages as the PDF draws them. */
export class Pdf implements TextView {
  readonly events = new EventBus();
  readonly container = document.querySelector<HTMLDivElement>('#scroller')!;
  private readonly viewer: PDFViewer;
  private readonly links: PDFLinkService;
  private task: pdfjs.PDFDocumentLoadingTask | undefined;
  private doc: pdfjs.PDFDocumentProxy | undefined;
  private blocks = new Map<number, Promise<PageBlocks>>();
  private utterances = new Map<number, Promise<Utterance[]>>();
  /** Pages whose text has been read, for the synchronous lookups the views need. */
  private loaded = new Map<number, PageBlocks>();
  private lang: Promise<Lang> | undefined;
  private indexes = new WeakMap<Element, TextIndex>();
  /** Set when the document arrived while this view was hidden and could not be sized. */
  private needsFit = false;

  constructor() {
    this.links = new PDFLinkService({ eventBus: this.events });
    this.viewer = new PDFViewer({
      container: this.container,
      viewer: document.querySelector<HTMLDivElement>('#pages')!,
      eventBus: this.events,
      linkService: this.links,
      // Icons for sticky notes and other annotations already in a PDF.
      imageResourcesPath: asset('images'),
    });
    this.links.setViewer(this.viewer);
    this.events.on('pagesinit', () => this.fit());
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
    this.utterances.clear();
    this.loaded.clear();
    this.lang = undefined;
    this.viewer.setDocument(this.doc);
    this.links.setDocument(this.doc);
    void old?.destroy();
  }

  private fit(): void {
    this.needsFit = this.container.clientWidth === 0;
    if (!this.needsFit) this.viewer.currentScaleValue = 'page-width';
  }

  /** Call when this view becomes visible again: PDF.js cannot lay out pages while hidden. */
  shown(page: number): void {
    if (this.needsFit) this.fit();
    this.viewer.update();
    this.showPage(page);
  }

  zoom(factor: number): void {
    this.viewer.currentScale = Math.min(5, Math.max(0.3, this.viewer.currentScale * factor));
  }

  showPage(page: number): void {
    this.viewer.scrollPageIntoView({ pageNumber: page });
  }

  pageBlocks(page: number): Promise<PageBlocks> {
    let result = this.blocks.get(page);
    if (!result) {
      result = (async () => {
        const proxy = await this.doc!.getPage(page);
        // Same options as the text layer, so both see identical strings.
        const content = await proxy.getTextContent(TEXT_CONTENT_OPTIONS);
        const [, bottom = 0, , top = 0] = proxy.view;
        const items = toRawItems(content.items, bottom);
        const text = { raw: rawString(items), blocks: layoutPage(items, top - bottom) };
        this.loaded.set(page, text);
        return text;
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

  /** The sentences and headings of a page, in the order they are read aloud. */
  pageUtterances(page: number): Promise<Utterance[]> {
    let result = this.utterances.get(page);
    if (!result) {
      result = Promise.all([this.pageBlocks(page), this.documentLang()]).then(([{ blocks }, lang]) =>
        buildUtterances(blocks, page, lang),
      );
      this.utterances.set(page, result);
    }
    return result;
  }

  /** A page's text if it has been read already. */
  loadedPage(page: number): PageBlocks | undefined {
    return this.loaded.get(page);
  }

  /** The text nodes of a page's rendered text layer, or undefined while it is not on screen. */
  private textIndex(page: number): TextIndex | undefined {
    const rawLength = this.loaded.get(page)?.raw.length;
    const layer = this.container.querySelector(`.page[data-page-number="${page}"] .textLayer`);
    if (!layer || rawLength === undefined) return undefined;
    let index = this.indexes.get(layer);
    if (!index || index.nodes[0]?.isConnected === false) {
      index = indexText(layer);
      // A layer that is still rendering holds only part of the page.
      if (index.length !== rawLength) return undefined;
      this.indexes.set(layer, index);
    }
    return index;
  }

  domRanges(page: number, ranges: readonly RawRange[]): Range[] {
    const index = this.textIndex(page);
    return index ? toDomRanges(index, ranges) : [];
  }

  rawSpan(range: Range): Span | undefined {
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
    return { page, start: from, end: to, text: this.loaded.get(page)!.raw.slice(from, to) };
  }

  /**
   * Where passages of a page lie on the paper: for each passage, one quadrilateral per line
   * of text in PDF units (top-left, top-right, bottom-left, bottom-right). The page's text
   * is laid out off screen at scale 1, so this works for pages that are not displayed.
   */
  async quads(page: number, passages: readonly (readonly RawRange[])[]): Promise<number[][][]> {
    const proxy = await this.doc!.getPage(page);
    const viewport = proxy.getViewport({ scale: 1 });
    const host = document.createElement('div');
    host.className = 'measure';
    host.style.width = `${viewport.width}px`;
    host.style.height = `${viewport.height}px`;
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    host.append(layer);
    document.body.append(host);
    try {
      await new pdfjs.TextLayer({
        textContentSource: proxy.streamTextContent(TEXT_CONTENT_OPTIONS),
        container: layer,
        viewport,
      }).render();
      const index = indexText(layer);
      const origin = host.getBoundingClientRect();
      const point = (x: number, y: number): number[] =>
        viewport.convertToPdfPoint(x - origin.left, y - origin.top) as number[];
      return passages.map((ranges) =>
        toDomRanges(
          index,
          ranges.filter(([, end]) => end <= index.length),
        )
          .flatMap(lineRects)
          .map((r) => [
            ...point(r.left, r.top),
            ...point(r.right, r.top),
            ...point(r.left, r.bottom),
            ...point(r.right, r.bottom),
          ]),
      );
    } finally {
      host.remove();
    }
  }
}
