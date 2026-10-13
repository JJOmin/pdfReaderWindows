# Specification

## Goal

A clean PDF reader for reviewing papers and taking notes, whose main feature is a read-aloud
voice that sounds good and shows where it is: the spoken sentence is tinted and the spoken word is
marked. German and English. Everything runs on the local PC.

## What works today (v0.1)

**Viewing.** Open a PDF from the dialog, with Ctrl+O, or as a command line argument. Scroll, zoom,
selectable text, working links.

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

**Notes.** Highlight a selection in four colours, comment on each highlight, write general notes,
click a highlight to jump to its comment. Saved automatically as `<file>.pdf.notes.json` next to
the PDF. Export to Markdown as `<file>.pdf.notes.md`.

## Known limits

These are the honest gaps, in rough order of how much they hurt.

1. **Text inside figures, formulas, tables and footnotes is read aloud.** The reader cannot yet
   tell a figure label from a heading.
2. **A sentence that continues on the next page is read as two.** There is a short pause at the
   page break.
3. **Reading order follows the PDF's internal order.** That is correct for LaTeX and Word output.
   A PDF with scrambled internal order is read scrambled.
4. **Scanned PDFs have no text** and cannot be read. There is no OCR.
5. **Highlights live in the notes file, not in the PDF.** Other PDF readers do not show them.
6. **A highlight cannot span two pages.** The selection is cut at the page end.
7. **The first sentence takes about five seconds** while the speech model loads. Later sentences
   are prepared ahead and start without a gap.
8. **Skipping far ahead waits** for the two sentences already being prepared.
9. **Models are installed from the command line** with `npm run models`, not from the app.

## Backlog

Each item is written so it can be handed to `/spec` as is.

1. **Do not read figure and table text.** Done when `npm run dump -- bert.pdf 3` shows the caption
   "Figure 1: ..." and no fragments such as "E[CLS] E1 E[SEP]". Idea: PDF.js marks many figures as
   marked content, and figure text has many short lines with no sentence punctuation.
2. **Skip or shorten formulas and footnotes.** Done when a displayed equation is either skipped or
   announced as "equation", chosen in settings.
3. **Join sentences across page breaks.** Done when the last sentence of page 1 of bert.pdf is one
   utterance and the highlight moves onto page 2 with the voice.
4. **Stop at the reference list**, as an option. Done when reading ends at "References" or
   "Literatur".
5. **Warm the speech model on start** so the first sentence starts within a second.
6. **Write highlights into the PDF** as standard annotations, so other readers show them.
7. **Download models from the Voices dialog.**
8. **Better German voice.** Try Pocket TTS German and Chatterbox Multilingual. The second needs a
   64-bit Python and uses the GPU.
9. **Package as an installer** with electron-builder.

## How to judge speech quality

Listening is the only test. Five samples of the same sentence are in
[docs/samples/](samples/). Use the preview buttons under Voices for the rest.
