# Specification

## Goal

A clean PDF reader for reviewing papers and taking notes, whose main feature is a read-aloud
voice that sounds good and shows where it is: the spoken sentence is tinted and the spoken word is
marked. German and English. Everything runs on the local PC.

## What works today (v0.2)

**Viewing.** Open a PDF from the dialog, with Ctrl+O, or as a command line argument. Scroll, zoom,
selectable text, working links.

**Reading view.** The toolbar button "Reading view" swaps the PDF pages for the text alone:
headings and paragraphs, hyphenation undone, no headers, footers or page numbers.

- Font (OpenDyslexic, Lexend, Verdana, Comic Sans MS, Arial, Georgia), size, line spacing, letter
  spacing and colours (light, sepia, dark) are yours to set and are remembered.
- Text is set ragged right in a narrow column, which is easier to track than justified lines.
- Everything else works as on the PDF pages: reading aloud with the sentence and word marked,
  marks and comments, search. Switching views keeps your place, and the voice keeps reading.
- The zoom buttons change the text size while this view is open.

**Reading aloud.**

- Play, pause, stop, previous and next sentence, speed. Space toggles play and pause.
- "Read from here" in the menu that appears on a text selection.
- The sentence is tinted, the current word is marked, and the view follows the voice unless you
  scrolled in the last three seconds.
- Word timings are measured, not estimated: a small speech recogniser listens to each synthesised
  sentence and reports when each word starts. Without the recogniser model the app falls back to
  an estimate by word length.
- Each sentence gets its own language. An English sentence in a German text is read by the
  English voice, also when it follows a colon inside a German sentence.
- Three voice roles per language: main text, quotes and headings. Set them under Voices, with a
  preview button for each.
- Four engines: Kokoro (English), Piper Thorsten (German), Supertonic 3 (both), Pocket TTS
  (English, optional download).

**Text detection.** Headings, paragraphs across two columns, hyphenation undone at line ends,
running headers, footers, page numbers and margin stamps dropped, numeric citations such as
"[3, 14]" skipped in speech, abbreviations and German ordinals not treated as sentence ends.

**Marks and notes.**

- Select text, pick highlight, underline or strikethrough, then one of four colours. The kind
  stays selected for the next mark.
- Comment on each mark, write general notes, click a mark to jump to its comment.
- Saved automatically as `<file>.pdf.notes.json` next to the PDF. The PDF itself is never changed.
- "Markdown" exports notes and marks as `<file>.pdf.notes.md`.
- "Save PDF" writes a copy of the PDF with every mark as a standard PDF annotation and its
  comment attached. The general notes become a sticky note on the first page. Any PDF program
  shows them. Checked with two unrelated PDF engines: PDF.js, which Firefox uses, and MuPDF.

**Search.** Ctrl+F or the search box. Matches are marked in the whole document, Enter and
Shift+Enter step through them, Escape clears. Case is ignored. A phrase is found even when the
PDF breaks it across lines or hyphenates it.

## Known limits

These are the honest gaps, in rough order of how much they hurt.

1. **Text inside figures, formulas, tables and footnotes is read aloud** and shown in the
   reading view. The reader cannot yet tell a figure label from a heading.
2. **A sentence that continues on the next page is read as two.** There is a short pause at the
   page break. The reading view also starts a new paragraph there.
3. **Reading order follows the PDF's internal order.** That is correct for LaTeX and Word output.
   A PDF with scrambled internal order is read scrambled.
4. **Scanned PDFs have no text** and cannot be read. There is no OCR.
5. **Marks sit a little off on some PDFs.** A mark is placed where the browser lays out the
   PDF's text, which can differ from the drawn letters by a character's width when the PDF uses
   an unusual font. Selection in every browser PDF viewer has the same limit.
6. **A mark cannot span two pages.** The selection is cut at the page end.
7. **A saved PDF is a one-way export.** Opening it here shows its annotations but does not turn
   them back into editable marks. Keep working in the original.
8. **The reading view shows text only.** No images, tables or formulas as pictures.
9. **Search does not look inside running headers and footers**, because they are left out of
   the readable text.
10. **The first sentence takes about five seconds** while the speech model loads. Later sentences
    are prepared ahead and start without a gap.
11. **Models are installed from the command line** with `npm run models`, not from the app.
12. **Saved PDFs were not opened in Adobe Acrobat or Edge.** The marks are standard annotations
    that carry their own drawing instructions, so they should look the same there, but neither
    program was used to confirm it.

## Backlog

Each item is written so it can be handed to `/spec` as is.

1. **Do not read figure and table text.** Done when `npm run dump -- bert.pdf 3` shows the caption
   "Figure 1: ..." and no fragments such as "E[CLS] E1 E[SEP]". Idea: PDF.js marks many figures as
   marked content, and figure text has many short lines with no sentence punctuation.
2. **Skip or shorten formulas and footnotes.** Done when a displayed equation is either skipped or
   announced as "equation", chosen in settings.
3. **Join sentences across page breaks.** Done when the last sentence of page 1 of bert.pdf is one
   utterance and the highlight moves onto page 2 with the voice.
4. **Change or recolour an existing mark** from its card in the sidebar.
5. **Stop at the reference list**, as an option. Done when reading ends at "References" or
   "Literatur".
6. **Remember the view and the page per document**, so a file reopens where it was left.
7. **Warm the speech model on start** so the first sentence starts within a second.
8. **Import annotations from a PDF** as editable marks, which closes the loop with "Save PDF".
9. **Download models from the Voices dialog.**
10. **Better voices on the GPU.** Chatterbox Multilingual needs a 64-bit Python, which is now
    installed, and a helper process next to the app.
11. **Package as an installer** with electron-builder.

## How to judge speech quality

Listening is the only test. Five samples of the same sentence are in
[docs/samples/](samples/). Use the preview buttons under Voices for the rest.
