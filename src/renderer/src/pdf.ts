import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { guessLang } from '../../shared/language';
import { ZOOM_LIMITS } from '../../shared/settings';
import { rawString, TEXT_CONTENT_OPTIONS, toRawItems } from '../../shared/items';
import { layoutPage, type Block } from '../../shared/layout';
import type { Lang, RawItem, RawRange, Utterance } from '../../shared/types';
import { buildUtterances } from '../../shared/utterances';
import { glyphBoxes, placeOnRaw, segmentRun, type FontMetrics, type Placement } from './glyphs';
import { lineRects, type Span, type TextView } from './view';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// The PDF.js worker resolves these itself, so they must be absolute.
const asset = (dir: string): string => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/** A page's text before it is split into sentences. */
export interface PageBlocks {
  /** Every text run of the page concatenated: the string raw offsets point into. */
  raw: string;
  blocks: Block[];
  /** The text runs in stream order, with where PDF.js puts each. */
  items: RawItem[];
  /** The page's box in PDF units: left, bottom, right, top. */
  view: number[];
}

/** How a document is shown when it is opened again: its zoom and the place at the top of the view. */
export interface Restore {
  /** PDF.js scale, or null for the page width. */
  zoom: number | null;
  page: number;
  offset: number;
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

let measuring: CanvasRenderingContext2D | undefined;

/** Width of a text in a font, in ems. */
function emWidth(family: string, text: string): number {
  measuring ??= document.createElement('canvas').getContext('2d')!;
  measuring.font = `100px ${family}`;
  return measuring.measureText(text).width / 100;
}

/**
 * Re-places a rendered text layer so every word sits where the PDF draws it. PDF.js puts a
 * whole line in one span and stretches it evenly, which drifts from the drawn words by up to
 * a character (see glyphs.ts). Each run becomes one span per word and per gap, with the same
 * style, its own left edge and a stretch that makes it exactly as wide as the drawn word.
 * The characters and their order are unchanged, so raw offsets still hold. A layer or run that
 * does not match what was expected is left as PDF.js made it.
 */
function placeLayer(layer: Element, text: PageBlocks, place: Placement): void {
  const spans = [...layer.querySelectorAll<HTMLSpanElement>('span')].filter(
    (span) => !span.classList.contains('markedContent') && span.firstChild instanceof Text,
  );
  const runs: { item: RawItem; start: number }[] = [];
  let start = 0;
  for (const item of text.items) {
    if (item.str !== '') runs.push({ item, start });
    start += item.str.length;
  }
  if (spans.length !== runs.length) return;
  if (spans.some((span, i) => span.dataset.placed !== undefined || span.textContent !== runs[i]!.item.str))
    return;

  const [left = 0, bottom = 0, right = 0] = text.view;
  const pageWidth = right - left;
  spans.forEach((span, i) => {
    const { item, start } = runs[i]!;
    if (item.rotated) return;
    const segments = segmentRun(item.str, start, place, { x: item.x, y: item.y + bottom });
    if (!segments) return;
    const family = span.style.fontFamily;
    const height = parseFloat(span.style.getPropertyValue('--font-height'));
    span.replaceWith(
      ...segments.map((segment) => {
        const piece = span.cloneNode(false) as HTMLSpanElement;
        piece.textContent = item.str.slice(segment.from, segment.to);
        piece.dataset.placed = '';
        piece.style.left = `${(((segment.x0 - left) / pageWidth) * 100).toFixed(3)}%`;
        const natural = emWidth(family, piece.textContent) * height;
        if (natural > 0) piece.style.setProperty('--scale-x', String((segment.x1 - segment.x0) / natural));
        return piece;
      }),
    );
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
  private placements = new Map<number, Promise<Placement | undefined>>();
  private lang: Promise<Lang> | undefined;
  private indexes = new WeakMap<Element, TextIndex>();
  /** Set when the document arrived while this view was hidden and could not be sized. */
  private needsFit = false;
  /** Where the document was left, applied once its pages can be laid out. */
  private restore: Restore | undefined;
  /** False from opening a document until its pages have their zoom and place. */
  laidOut = false;

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
    // Pages fitted to the width stay fitted when the window or the notes change the view's width.
    new ResizeObserver(() => {
      if (this.laidOut && this.fitsWidth && this.container.clientWidth > 0) {
        this.viewer.currentScaleValue = 'page-width';
      }
    }).observe(this.container);
  }

  get pageCount(): number {
    return this.doc?.numPages ?? 0;
  }

  get currentPage(): number {
    return this.viewer.currentPageNumber;
  }

  /** True while the pages are fitted to the view's width, not zoomed by the user. */
  get fitsWidth(): boolean {
    return this.viewer.currentScaleValue === 'page-width';
  }

  /** The zoom of the pages as PDF.js counts it: 1 is 100 %. */
  get scale(): number {
    return this.viewer.currentScale;
  }

  /** Opens a document. `restore` is the zoom and place to show it at instead of the page width. */
  async open(data: Uint8Array, restore?: Restore): Promise<void> {
    this.restore = restore;
    this.laidOut = false;
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
    this.placements.clear();
    this.lang = undefined;
    this.viewer.setDocument(this.doc);
    this.links.setDocument(this.doc);
    void old?.destroy();
  }

  /** Gives a new document its zoom, the saved one or the page width, and its saved place. */
  private fit(): void {
    this.needsFit = this.container.clientWidth === 0;
    if (this.needsFit) return;
    const restore = this.restore;
    this.restore = undefined;
    if (restore?.zoom) this.viewer.currentScale = restore.zoom;
    else this.viewer.currentScaleValue = 'page-width';
    this.laidOut = true;
    if (restore) this.showPage(Math.min(restore.page, this.pageCount), restore.offset);
  }

  /** Call when this view becomes visible again: PDF.js cannot lay out pages while hidden. */
  shown(page: number): void {
    // A document that is being given its saved place must not be moved to where the view was.
    const placing = this.needsFit && this.restore !== undefined;
    if (this.needsFit) this.fit();
    this.viewer.update();
    if (!placing) this.showPage(page);
  }

  /** Multiplies the zoom. With `origin` (client coordinates) that point of the page stays put. */
  zoom(factor: number, origin?: { x: number; y: number }): void {
    const current = this.viewer.currentScale;
    const target = Math.min(ZOOM_LIMITS[1], Math.max(ZOOM_LIMITS[0], current * factor));
    if (!origin) {
      this.viewer.currentScale = target;
      return;
    }
    // The point as a fraction of the page's content box, since the page's border does not scale.
    const page = document.elementFromPoint(origin.x, origin.y)?.closest<HTMLElement>('.page');
    const box = page?.getBoundingClientRect();
    const at = page &&
      box && {
        fx: (origin.x - box.left - page.clientLeft) / page.clientWidth,
        fy: (origin.y - box.top - page.clientTop) / page.clientHeight,
      };
    // A short delay lets a run of wheel events scale the pages first and draw them once.
    this.viewer.updateScale({ scaleFactor: target / current, drawingDelay: 150 });
    if (!page || !at) return;
    const now = page.getBoundingClientRect();
    this.container.scrollLeft += now.left + page.clientLeft + at.fx * page.clientWidth - origin.x;
    this.container.scrollTop += now.top + page.clientTop + at.fy * page.clientHeight - origin.y;
  }

  showPage(page: number, offset = 0): void {
    this.viewer.scrollPageIntoView({ pageNumber: page });
    const element = this.container.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`);
    if (!element || offset <= 0) return;
    const box = element.getBoundingClientRect();
    this.container.scrollTop +=
      box.top +
      element.clientTop +
      offset * element.clientHeight -
      this.container.getBoundingClientRect().top;
  }

  scrollAnchor(): { page: number; offset: number } {
    const top = this.container.getBoundingClientRect().top;
    let anchor = { page: 1, offset: 0 };
    for (const element of this.container.querySelectorAll<HTMLElement>('.page')) {
      const inner = element.getBoundingClientRect().top + element.clientTop;
      if (inner > top + 1) break;
      anchor = {
        page: Number(element.dataset.pageNumber),
        offset: Math.min(0.999, Math.max(0, (top - inner) / element.clientHeight)),
      };
    }
    return anchor;
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
        const text = {
          raw: rawString(items),
          blocks: layoutPage(items, top - bottom),
          items,
          view: proxy.view,
        };
        this.loaded.set(page, text);
        return text;
      })();
      this.blocks.set(page, result);
    }
    return result;
  }

  /** Where the PDF draws each character of a page, or undefined if that could not be worked out. */
  private placement(page: number): Promise<Placement | undefined> {
    let result = this.placements.get(page);
    if (!result) {
      result = (async () => {
        try {
          const [proxy, { raw }] = await Promise.all([this.doc!.getPage(page), this.pageBlocks(page)]);
          const list = await proxy.getOperatorList();
          const fontOf = (name: string): FontMetrics | undefined => {
            if (!proxy.commonObjs.has(name)) return undefined;
            const font = proxy.commonObjs.get(name) as { fontMatrix?: number[]; vertical?: boolean } | null;
            return font
              ? { scale: font.fontMatrix?.[0] ?? 0.001, vertical: font.vertical === true }
              : undefined;
          };
          return placeOnRaw(raw, glyphBoxes(list.fnArray, list.argsArray, pdfjs.OPS, fontOf));
        } catch {
          // shortcut: a page whose operator list cannot be read keeps PDF.js's layout, upgrade if that shows up
          return undefined;
        }
      })();
      this.placements.set(page, result);
    }
    return result;
  }

  /** Puts the words of a page's rendered text layer where the PDF draws them. */
  async align(page: number): Promise<void> {
    const layer = this.container.querySelector(`.page[data-page-number="${page}"] .textLayer`);
    if (!layer) return;
    const [text, place] = await Promise.all([this.pageBlocks(page), this.placement(page)]);
    if (place && layer.isConnected) placeLayer(layer, text, place);
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
    const [text, place] = await Promise.all([this.pageBlocks(page), this.placement(page)]);
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
      if (place) placeLayer(layer, text, place);
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
