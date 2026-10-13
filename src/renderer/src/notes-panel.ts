import { readableText } from '../../shared/layout';
import { emptyNotes, reanchor, sortAnnotations, toMarkdown } from '../../shared/notes';
import {
  HIGHLIGHT_COLORS,
  MARK_KINDS,
  type Annotation,
  type ExportMark,
  type HighlightColor,
  type MarkKind,
  type NotesFile,
  type RawRange,
} from '../../shared/types';
import { paint } from './highlights';
import type { Pdf } from './pdf';
import type { Span, TextView } from './view';

const SAVE_DELAY = 400;
const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

export interface NotesActions {
  readFrom(page: number, offset: number): void;
  reveal(page: number, ranges: readonly RawRange[]): void;
  status(message: string, error?: boolean): void;
}

/** Marks on the text, their comments and the document notes: editing, painting, saving, exporting. */
export class NotesPanel {
  private file: NotesFile = emptyNotes();
  private name = '';
  private selected: Span | undefined;
  /** The kind of mark the colour buttons make. Stays as chosen until changed. */
  private kind: MarkKind = 'highlight';
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly menu = $('#selection-menu');
  private readonly list = $<HTMLOListElement>('#annotations');
  private readonly notes = $<HTMLTextAreaElement>('#notes');

  constructor(
    private readonly pdf: Pdf,
    views: readonly TextView[],
    private readonly view: () => TextView,
    private readonly actions: NotesActions,
  ) {
    this.notes.addEventListener('input', () => {
      this.file.notes = this.notes.value;
      this.save();
    });
    $('#export').addEventListener('click', () => void this.exportMarkdown());
    $('#export-pdf').addEventListener('click', () => void this.exportPdf());

    // The menu must not take the selection it acts on.
    this.menu.addEventListener('mousedown', (event) => event.preventDefault());
    this.menu.addEventListener('click', (event) => {
      const button = (event.target as Element).closest('button');
      const span = this.selected;
      if (!button || !span) return;
      if (button.dataset.kind) {
        this.setKind(button.dataset.kind as MarkKind);
        return;
      }
      if (button.dataset.color) this.add(span, button.dataset.color as HighlightColor);
      else this.actions.readFrom(span.page, span.start);
      getSelection()?.removeAllRanges();
      this.hideMenu();
    });
    this.setKind(this.kind);
    document.addEventListener('selectionchange', () => {
      if (getSelection()?.isCollapsed) this.hideMenu();
    });
    for (const { container } of views) {
      container.addEventListener('mouseup', (event) => this.onMouseUp(event));
      container.addEventListener('scroll', () => this.hideMenu());
    }
  }

  load(name: string, file: NotesFile | null): void {
    this.name = name;
    this.file = file ?? emptyNotes();
    this.notes.value = this.file.notes;
    this.render();
  }

  /** Repaints every mark whose page is on screen in the active view. */
  paint(): void {
    const view = this.view();
    for (const kind of MARK_KINDS) {
      for (const color of HIGHLIGHT_COLORS) {
        const ranges = this.file.annotations
          .filter((a) => a.kind === kind && a.color === color)
          .flatMap((a) => {
            const anchored = this.anchored(a);
            return anchored ? view.domRanges(a.page, [[anchored.start, anchored.end]]) : [];
          });
        paint(`note-${kind}-${color}`, ranges);
      }
    }
  }

  /** The annotation at its current place in the page text, or undefined if its text is gone. */
  private anchored(annotation: Annotation): Annotation | undefined {
    const raw = this.pdf.loadedPage(annotation.page)?.raw;
    return raw === undefined ? annotation : (reanchor(annotation, raw) ?? undefined);
  }

  private setKind(kind: MarkKind): void {
    this.kind = kind;
    this.menu.dataset.kind = kind;
    for (const button of this.menu.querySelectorAll<HTMLElement>('[data-kind]')) {
      button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
    }
  }

  private onMouseUp(event: MouseEvent): void {
    const view = this.view();
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const span = view.rawSpan(range);
      if (!span || span.text.trim() === '') return;
      // Selections tend to pick up the spaces around them.
      const lead = span.text.length - span.text.trimStart().length;
      const text = span.text.trim();
      this.selected = {
        page: span.page,
        start: span.start + lead,
        end: span.start + lead + text.length,
        text,
      };
      const rect = range.getClientRects()[range.getClientRects().length - 1] ?? range.getBoundingClientRect();
      this.menu.hidden = false;
      this.menu.style.left = `${Math.max(8, Math.min(rect.right - 80, innerWidth - this.menu.offsetWidth - 8))}px`;
      this.menu.style.top = `${Math.min(rect.bottom + 6, innerHeight - this.menu.offsetHeight - 8)}px`;
      return;
    }
    // A plain click on a mark selects its card in the sidebar.
    const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (!caret || !(caret.offsetNode instanceof Text) || caret.offset >= caret.offsetNode.length) return;
    const probe = new Range();
    probe.setStart(caret.offsetNode, caret.offset);
    probe.setEnd(caret.offsetNode, caret.offset + 1);
    const hit = view.rawSpan(probe);
    const annotation =
      hit &&
      this.file.annotations.find((a) => a.page === hit.page && a.start <= hit.start && hit.start < a.end);
    if (annotation) this.focus(annotation.id);
  }

  private hideMenu(): void {
    this.menu.hidden = true;
    this.selected = undefined;
  }

  private add(span: Span, color: HighlightColor): void {
    const blocks = this.pdf.loadedPage(span.page)?.blocks ?? [];
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      ...span,
      // Text that layout drops, such as a page header, has no readable form.
      quote: readableText(blocks, span.start, span.end) || span.text,
      kind: this.kind,
      color,
      comment: '',
      created: new Date().toISOString(),
    };
    this.file.annotations.push(annotation);
    this.changed();
    this.focus(annotation.id);
  }

  private focus(id: string): void {
    $('#sidebar').hidden = false;
    for (const item of this.list.children)
      item.classList.toggle('focused', (item as HTMLElement).dataset.id === id);
    const item = this.list.querySelector<HTMLElement>(`[data-id="${id}"]`);
    item?.scrollIntoView({ block: 'nearest' });
    item?.querySelector('textarea')?.focus();
  }

  private changed(): void {
    this.render();
    this.paint();
    this.save(true);
  }

  private render(): void {
    const items = sortAnnotations(this.file.annotations).map((annotation) => {
      const item = document.createElement('li');
      item.dataset.id = annotation.id;
      item.dataset.color = annotation.color;
      item.dataset.kind = annotation.kind;

      const meta = document.createElement('div');
      meta.className = 'meta';
      const remove = document.createElement('button');
      remove.className = 'delete';
      remove.textContent = '✕';
      remove.title = 'Delete mark';
      remove.addEventListener('click', () => {
        this.file.annotations = this.file.annotations.filter((a) => a !== annotation);
        this.changed();
      });
      meta.append(`Page ${annotation.page}`, remove);

      const quote = document.createElement('blockquote');
      quote.textContent = annotation.quote;
      quote.title = 'Show in document';
      quote.addEventListener('click', () =>
        this.actions.reveal(annotation.page, [[annotation.start, annotation.end]]),
      );

      const comment = document.createElement('textarea');
      comment.placeholder = 'Comment';
      comment.rows = 2;
      comment.value = annotation.comment;
      comment.addEventListener('input', () => {
        annotation.comment = comment.value;
        this.save();
      });

      item.append(meta, quote, comment);
      return item;
    });
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Select text in the document to highlight, underline or strike it through.';
      items.push(empty);
    }
    this.list.replaceChildren(...items);
  }

  /** Writes the notes file next to the PDF, at once or after a pause in typing. */
  private save(now = false): void {
    clearTimeout(this.saveTimer);
    const write = (): void => {
      window.api
        .saveNotes(this.file)
        .catch((error: unknown) => this.actions.status(`Saving notes failed: ${String(error)}`, true));
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, SAVE_DELAY);
  }

  private async exportMarkdown(): Promise<void> {
    const path = await window.api.exportMarkdown(toMarkdown(this.name, this.file));
    this.actions.status(path ? `Exported to ${path}` : 'Open a PDF first', !path);
  }

  /** Saves a copy of the PDF that carries the marks and comments as standard PDF annotations. */
  private async exportPdf(): Promise<void> {
    try {
      const marks: ExportMark[] = [];
      let lost = 0;
      for (const page of new Set(this.file.annotations.map((a) => a.page))) {
        if (page < 1 || page > this.pdf.pageCount) continue;
        await this.pdf.pageBlocks(page);
        const onPage = this.file.annotations.filter((a) => a.page === page).map((a) => this.anchored(a));
        const found = onPage.filter((a) => a !== undefined);
        lost += onPage.length - found.length;
        const quads = await this.pdf.quads(
          page,
          found.map((a) => [[a.start, a.end]]),
        );
        found.forEach((a, i) =>
          marks.push({ page, kind: a.kind, color: a.color, comment: a.comment, quads: quads[i]! }),
        );
      }
      const path = await window.api.exportPdf(marks, this.file.notes);
      if (!path) return;
      const warning =
        lost > 0 ? ` ${lost} marks were left out because their text is no longer in the PDF.` : '';
      this.actions.status(`Saved ${path}.${warning}`, lost > 0);
    } catch (error) {
      this.actions.status(
        `Saving the PDF failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }
}
