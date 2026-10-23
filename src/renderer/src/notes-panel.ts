import { readableText } from '../../shared/layout';
import { joinHeard } from '../../shared/dictation';
import { emptyNotes, markBadge, reanchor, setComment, sortAnnotations, toMarkdown } from '../../shared/notes';
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
import { startRecording, type Recording } from './dictation';
import { icon, paintBadges } from './mark-badges';
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
  /** The cards that are open for changes. A card shows only, until its pencil is clicked. */
  private readonly editing = new Set<string>();
  /** The comment being dictated, and whose it is; one at a time, as there is one microphone. */
  private recording: { id: string; recording: Recording } | undefined;
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
    paintBadges(
      view,
      this.file.annotations,
      (a) => this.anchored(a),
      (a) => this.focus(a.id),
    );
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
    // A mark that was just made is for its comment: open to type or speak it.
    this.editing.add(annotation.id);
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
        this.editing.delete(annotation.id);
        this.changed();
      });
      const how = document.createElement('span');
      how.className = 'how';
      this.showHow(how, annotation);
      const edit = document.createElement('button');
      edit.className = 'edit';
      meta.append(`Page ${annotation.page}`, how, edit, remove);

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
        const before = markBadge(annotation);
        setComment(annotation, comment.value);
        // The icon appears with the first words and goes with the last.
        if (markBadge(annotation) !== before) {
          this.showHow(how, annotation);
          this.paint();
        }
        this.save();
      });

      item.append(meta, quote, this.styleTools(item, annotation), comment);
      // Closed, the comment can be read and copied but not changed; the tools and Delete are hidden.
      const showEditing = (): void => {
        const open = this.editing.has(annotation.id);
        item.dataset.editing = String(open);
        comment.readOnly = !open;
        comment.placeholder = open ? 'Comment' : 'No comment';
        edit.replaceChildren(icon(open ? 'done' : 'edit'));
        edit.title = open ? 'Done' : 'Edit the comment and the mark';
        edit.setAttribute('aria-label', edit.title);
        edit.setAttribute('aria-pressed', String(open));
      };
      edit.addEventListener('click', () => {
        if (!this.editing.delete(annotation.id)) this.editing.add(annotation.id);
        showEditing();
      });
      showEditing();
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

  /** The icon on a card that says whether its comment was typed or spoken; none without a comment. */
  private showHow(how: HTMLElement, annotation: Annotation): void {
    const badge = markBadge(annotation);
    how.replaceChildren(...(badge ? [icon(badge)] : []));
    how.dataset.how = badge ?? '';
    how.title = badge === 'speech' ? 'Spoken comment' : badge === 'note' ? 'Written comment' : '';
  }

  /** The buttons on a card that change its kind and colour, and the microphone for its comment. */
  private styleTools(item: HTMLElement, annotation: Annotation): HTMLElement {
    const tools = document.createElement('div');
    tools.className = 'tools';
    const kinds = document.createElement('span');
    kinds.className = 'group';
    for (const kind of MARK_KINDS) {
      const button = document.createElement('button');
      button.dataset.markKind = kind;
      button.title = { highlight: 'Highlight', underline: 'Underline', strike: 'Strike through' }[kind];
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(annotation.kind === kind));
      button.append(document.createElement('span'));
      button.firstElementChild!.textContent = 'A';
      kinds.append(button);
    }
    const colors = document.createElement('span');
    colors.className = 'group';
    for (const color of HIGHLIGHT_COLORS) {
      const button = document.createElement('button');
      button.dataset.color = color;
      button.title = color[0]!.toUpperCase() + color.slice(1);
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(annotation.color === color));
      colors.append(button);
    }
    // Restyling changes the card where it stands: rebuilding the list would take the typing away.
    tools.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLElement>('[data-mark-kind], [data-color]');
      if (!button) return;
      if (button.dataset.markKind) annotation.kind = button.dataset.markKind as MarkKind;
      else annotation.color = button.dataset.color as HighlightColor;
      item.dataset.kind = annotation.kind;
      item.dataset.color = annotation.color;
      for (const other of tools.querySelectorAll<HTMLElement>('[data-mark-kind], [data-color]')) {
        other.setAttribute(
          'aria-pressed',
          String(other.dataset.markKind === annotation.kind || other.dataset.color === annotation.color),
        );
      }
      this.paint();
      this.save(true);
    });

    const mic = document.createElement('button');
    mic.className = 'mic';
    mic.title = 'Speak a comment';
    mic.setAttribute('aria-label', 'Speak a comment');
    mic.setAttribute('aria-pressed', String(this.recording?.id === annotation.id));
    mic.append(icon('speech'));
    mic.addEventListener('click', () => void this.dictate(annotation.id, mic));
    tools.append(kinds, colors, mic);
    return tools;
  }

  /** The microphone on a card: first click listens, second click writes out what was said. */
  private async dictate(id: string, mic: HTMLButtonElement): Promise<void> {
    if (this.recording) {
      this.recording.recording.stop();
      return;
    }
    try {
      const recording = await startRecording();
      this.recording = { id, recording };
      this.listening(true);
      this.actions.status('Listening. Click the microphone again when you are done.');
      const samples = await recording.done;
      this.recording = undefined;
      this.listening(false);
      mic.disabled = true;
      this.actions.status('Writing out what you said…');
      const heard = await window.api.transcribe(samples);
      // The list may have been rebuilt, or the mark deleted, while the model was working.
      const annotation = this.file.annotations.find((a) => a.id === id);
      if (!annotation) return;
      if (heard === '') {
        this.actions.status('Nothing was heard.', true);
        return;
      }
      const before = markBadge(annotation);
      setComment(annotation, joinHeard(annotation.comment, heard), true);
      const item = this.list.querySelector<HTMLElement>(`[data-id="${id}"]`);
      const field = item?.querySelector('textarea');
      if (field) field.value = annotation.comment;
      const how = item?.querySelector<HTMLElement>('.how');
      if (how) this.showHow(how, annotation);
      if (markBadge(annotation) !== before) this.paint();
      this.save(true);
      this.actions.status('');
    } catch (error) {
      this.recording = undefined;
      this.listening(false);
      this.actions.status(error instanceof Error ? error.message : String(error), true);
    } finally {
      mic.disabled = false;
    }
  }

  /** Shows which card is listening, and keeps the other microphones from taking over. */
  private listening(on: boolean): void {
    for (const mic of this.list.querySelectorAll<HTMLButtonElement>('.mic')) {
      const own = on && mic.closest('li')?.dataset.id === this.recording?.id;
      mic.setAttribute('aria-pressed', String(own));
      mic.disabled = on && !own;
    }
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
