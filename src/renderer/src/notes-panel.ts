import { emptyNotes, reanchor, sortAnnotations, toMarkdown } from '../../shared/notes';
import { HIGHLIGHT_COLORS, type Annotation, type HighlightColor, type NotesFile } from '../../shared/types';
import { paint } from './highlights';
import type { Pdf } from './pdf';

const SAVE_DELAY = 400;
const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

interface Span {
  page: number;
  start: number;
  end: number;
  text: string;
}

/** Highlights, their comments and the document notes: editing, painting and saving. */
export class NotesPanel {
  private file: NotesFile = emptyNotes();
  private name = '';
  private selected: Span | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly menu = $('#selection-menu');
  private readonly list = $<HTMLOListElement>('#annotations');
  private readonly notes = $<HTMLTextAreaElement>('#notes');

  constructor(
    private readonly pdf: Pdf,
    private readonly onReadFrom: (page: number, offset: number) => void,
    private readonly status: (message: string, error?: boolean) => void,
  ) {
    this.notes.addEventListener('input', () => {
      this.file.notes = this.notes.value;
      this.save();
    });
    $('#export').addEventListener('click', () => void this.export());

    // The menu must not take the selection it acts on.
    this.menu.addEventListener('mousedown', (event) => event.preventDefault());
    this.menu.addEventListener('click', (event) => {
      const button = (event.target as Element).closest('button');
      const span = this.selected;
      if (!button || !span) return;
      if (button.dataset.color) this.add(span, button.dataset.color as HighlightColor);
      else this.onReadFrom(span.page, span.start);
      getSelection()?.removeAllRanges();
      this.hideMenu();
    });
    document.addEventListener('selectionchange', () => {
      if (getSelection()?.isCollapsed) this.hideMenu();
    });
    pdf.container.addEventListener('mouseup', (event) => this.onMouseUp(event));
    pdf.container.addEventListener('scroll', () => this.hideMenu());
  }

  load(name: string, file: NotesFile | null): void {
    this.name = name;
    this.file = file ?? emptyNotes();
    this.notes.value = this.file.notes;
    this.render();
  }

  /** Repaints every highlight whose page is currently rendered. */
  paint(): void {
    for (const color of HIGHLIGHT_COLORS) {
      const ranges = this.file.annotations
        .filter((a) => a.color === color)
        .flatMap((a) => {
          const raw = this.pdf.rawOf(a.page);
          const anchored = raw === undefined ? a : reanchor(a, raw);
          return anchored ? this.pdf.domRanges(a.page, [[anchored.start, anchored.end]]) : [];
        });
      paint(`note-${color}`, ranges);
    }
  }

  private onMouseUp(event: MouseEvent): void {
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const span = this.pdf.rawSpan(range);
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
    // A plain click on a highlight selects its card in the sidebar.
    const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (!caret || !(caret.offsetNode instanceof Text) || caret.offset >= caret.offsetNode.length) return;
    const probe = new Range();
    probe.setStart(caret.offsetNode, caret.offset);
    probe.setEnd(caret.offsetNode, caret.offset + 1);
    const hit = this.pdf.rawSpan(probe);
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
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      ...span,
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

      const meta = document.createElement('div');
      meta.className = 'meta';
      const remove = document.createElement('button');
      remove.className = 'delete';
      remove.textContent = '✕';
      remove.title = 'Delete highlight';
      remove.addEventListener('click', () => {
        this.file.annotations = this.file.annotations.filter((a) => a !== annotation);
        this.changed();
      });
      meta.append(`Page ${annotation.page}`, remove);

      const quote = document.createElement('blockquote');
      quote.textContent = annotation.text;
      quote.title = 'Show in document';
      quote.addEventListener('click', () => this.reveal(annotation));

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
      empty.textContent = 'Select text in the document to highlight it.';
      items.push(empty);
    }
    this.list.replaceChildren(...items);
  }

  private reveal(annotation: Annotation): void {
    const [range] = this.pdf.domRanges(annotation.page, [[annotation.start, annotation.end]]);
    if (range) range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else this.pdf.showPage(annotation.page);
  }

  /** Writes the notes file next to the PDF, at once or after a pause in typing. */
  private save(now = false): void {
    clearTimeout(this.saveTimer);
    const write = (): void => {
      window.api
        .saveNotes(this.file)
        .catch((error: unknown) => this.status(`Saving notes failed: ${String(error)}`, true));
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, SAVE_DELAY);
  }

  private async export(): Promise<void> {
    const path = await window.api.exportMarkdown(toMarkdown(this.name, this.file));
    this.status(path ? `Exported to ${path}` : 'Open a PDF first', !path);
  }
}
