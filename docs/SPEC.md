# Specification

## Goal

A clean PDF reader for reviewing papers and taking notes, whose main feature is a read-aloud
voice that sounds good and shows where it is: the spoken sentence is tinted and the spoken word is
marked. German and English. Everything runs on the local PC. A paired phone on the same network
can fetch prepared audio and the reading place (planned, ADR 7).

## What works today (v0.2)

**Viewing.** Open a PDF from the dialog, with Ctrl+O, or as a command line argument. Scroll,
selectable text, working links.

- **Zoom** with Ctrl+wheel, Ctrl+Plus and Ctrl+Minus (the main keys and the numpad), or the
  toolbar buttons. Only the document zooms: the toolbar and the sidebar keep their size, and the
  window's own zoom, which would scale them, is switched off. Ctrl+wheel keeps the point under
  the pointer where it is. In the reading view the same inputs change the text size by two
  pixels a step.
- **Marks, the spoken word and search hits sit on the letters they belong to.** See limit 5 for
  how close, and where that stops being true.
- **A file reopens where it was left**: the view (PDF or reading), the zoom, the place in the
  document and the sentence the voice was in. The first press of Play continues from that
  sentence, whatever you scrolled to since. This is kept per file in `progress.json` in the
  app's data folder, written at most once a second and when the window closes, for the 300 files
  used last.

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
- **Focus** (toolbar toggle, off by default, remembered). While the voice is reading, each new
  sentence is scrolled to the vertical middle of the view, even if you scrolled a moment ago.
  A sentence taller than 60 % of the view cannot be centred as a whole, so the line of the word
  being spoken is kept in the middle instead, word by word. Works in both views. A sentence at
  the very top or bottom of the document cannot reach the middle, as there is nothing to scroll.
- **Soften sentence edges** (checkbox under Voices, off by default, remembered). At playback each
  sentence fades in and out over 8 ms and passes a 70 Hz high-pass, which hides clicks at the
  joins and a hard stop. It changes no sample count, so word timings and marks are untouched, and
  it applies to every voice. A change takes effect from the next sentence. It is not a denoiser:
  on clean synthetic speech a voice-chat denoiser has nothing to remove and can strip sibilants.
  Whether the fades are audible is not yet measured.
- Word timings are measured, not estimated: a small speech recogniser listens to each synthesised
  sentence and reports when each word starts. Without the recogniser model the app falls back to
  an estimate by word length.
- Each sentence gets its own language. An English sentence in a German text is read by the
  English voice, also when it follows a colon inside a German sentence.
- Three voice roles per language: main text, quotes and headings. Set them under Voices, with a
  preview button for each.
- Four CPU engines: Kokoro (English), Piper Thorsten (German), Supertonic 3 (both), Pocket TTS
  (English, optional download). One GPU engine: XTTS-v2 (both, optional, see below).

**GPU voice (XTTS-v2).** Optional, for Windows with an NVIDIA GPU. `npm run gpu-voice --
--accept-licence` creates a Python environment and downloads the weights (about 7 GB). After a
restart, "XTTS-v2 · Claribel Dervla (GPU)" is offered under Voices for both languages. Chosen by
listening, ADR 5.

- A sentence is rendered by a helper process (`helper/xtts_helper.py`) into a cache of 16-bit WAV
  files in the app's data folder, keyed by text, voice, language and speed. The cache is kept
  between sessions and trimmed to 2 GiB, least recently used first.
- A sentence not in the cache is rendered when it is needed, the one being waited for before any
  other. There is no **Pre-render** button for now: it was removed from the toolbar on
  2026-10-13. The job behind it (`src/shared/prerender.ts`, `Api.prerender`, `Tts.prerender`)
  is still there and tested, so the button can come back.
- The first XTTS sentence takes the model's load time (about 20 seconds here), then about 4
  seconds per sentence. The helper stops after ten minutes without a request and gives the GPU
  memory back.

**Installer.** `npm run dist` builds `PDF-Reader-<version>-setup.exe` for Windows x64 with the
recommended speech models inside. Unsigned. The GPU voice is not part of it. See ADR 6.

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
5. **Marks sit on the letters to within a fraction of a letter, not exactly.** The screen's text
   layer is built from the glyph positions in the PDF's own drawing instructions, one piece per
   word and per gap, so word edges follow the drawn words. Measured on the generated test PDF
   (Chromium output, justified Georgia body text, Arial headings, two columns) against the ink
   on the page, every word's edges were within 0.17 of the font height at 100 % zoom and 0.07
   at 200 %. What stays open:
   - Inside a word the letters are spread by a stand-in font, so a selection that starts or
     ends in the middle of a word can be off by a fraction of a letter.
   - Rotated or vertical text, a rotated page and a page whose drawing instructions cannot be
     matched to its text keep the plain text layer, where a line is stretched evenly and a mark
     can be off by a letter or more at the end of a long line. Not found in the test PDF, so not
     measured.
   - Only one PDF was measured. Other producers (LaTeX, Word, scans with OCR text) were not.
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
13. **The place in a document is remembered by the file's full path.** A moved or renamed PDF
    starts again at the top, and so does one that is replaced by a different file under the same
    name, with whatever place and sentence number the old one had.
14. **The GPU voice has limits.**
    - It is set up and tested on Windows with Python 3.12 and an RTX 2070 only.
    - Its Python environment is 5 GB, and the model is licensed for non-commercial use only.
    - It has one speaker. The model has dozens, chosen from by listening.
    - Rendered sentences are tied to the speed they were rendered at. Changing the speed
      slider re-renders on demand, at about half real time.
    - How it reads numbers, abbreviations and formulas was not checked.
    - The helper script is found next to the app's files; a packaged installer does not carry it.

## Next: phone sync

Designed in [ADR 7](adr/0007-phone-sync.md), accepted 2026-10-21. The phone's steps are M5 in
`../pdfreader_flutter/docs/PLAN.md`. Step S1 is that plan's step 5.1, the sentence match spike, and
it comes first: if PDF.js and PDFium sentences rarely match, the rest changes. The phone has no
voice of its own for now, so it can read nothing until S4 has prepared a library. S2 to S4 come
before the phone's playback steps. S5 and S6 come after them.

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Done when                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | The match spike, Flutter PLAN 5.1. **Done 2026-10-21.** The words were identical page by page, so the phone takes the desktop's sentence breaks by word index (ADR 7 section 3).                                                                                                                                                                                                                                                                            | Recorded in Flutter ADR 2. Open: one real German paper.                                                                                                                                                                                     |
| S2  | **Done 2026-10-21.** 16 unit tests. The golden files are `tests/golden/page-words-*.json`, written with `npm run dump -- <file> --words`. `src/shared/phone-library.ts`: a page's words (word-like segments after NFKC) and their hash, each sentence's first word index, the sync key's normalisation (hashing left to the caller, as in `requestKey`), the manifest, page index and state types with their parse functions, and picking the newest state. | Unit tests pass, including NFKC forms, line-break whitespace and a state body that is not valid. A golden file with the page words of `sample.pdf` and the paper is written for the phone's tests.                                          |
| S3  | **Done 2026-10-21.** 8 unit tests. `tests/e2e/opus.spec.ts` with the Kokoro and Piper samples, both at the exact length; numbers in ADR 7, "Not verified". `src/shared/ogg.ts`: Opus packets into Ogg pages (OpusHead, OpusTags, granule positions, CRC).                                                                                                                                                                                                   | Unit tests pass, the CRC included. e2e: a sentence encoded in the renderer with `AudioEncoder` and decoded again with `decodeAudioData` is as long as the original within 20 ms.                                                            |
| S4  | **Prepare for phone**: a Phone sync dialog with "Add this document". It renders every sentence at speed 1.0 with the chosen voices through `prerender.ts`, encodes it as Opus and writes the library folder through a new `Api` method checked in main.                                                                                                                                                                                                     | e2e on the fixture: the folder holds the PDF, the manifest, one `.opus` file and one index entry per distinct sentence, and every word's timing lies within its sentence's duration.                                                        |
| S5  | The server: the certificate (own DER writer, ADR 7 section 6), the UDP announcement, pairing with Accept, the requests of section 7, and the paired phones with Remove. Off by default.                                                                                                                                                                                                                                                                     | Unit tests for the code derivation and request checks. e2e with a Node test client: it finds the app by UDP, a wrong code fails, pairing works after Accept, the fixture's files download byte for byte, and an unknown token gets nothing. |
| S6  | The place: the desktop writes its own state for library documents and, on open, offers a newer place from a phone.                                                                                                                                                                                                                                                                                                                                          | e2e: the test client sends a state at page 2, and reopening the fixture offers page 2.                                                                                                                                                      |

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
6. **Warm the speech model on start** so the first sentence starts within a second.
7. **Import annotations from a PDF** as editable marks, which closes the loop with "Save PDF".
8. **Download models from the Voices dialog.**
9. **More GPU voices.** XTTS-v2 is done (ADR 5). Open: other speakers of the same model, a
   second model (Chatterbox and Fun-CosyVoice3 ran slower than real time, so they would need the
   pre-render and a wait), and a time-stretch so that changing the speed does not re-render.
10. **Package as an installer** with electron-builder. The GPU voice's helper and environment
    would stay an optional download.

## How to judge speech quality

Listening is the only test. Five samples of the same sentence are in
[docs/samples/](samples/), and eight GPU ones in [docs/samples/gpu/](samples/gpu/). Use the
preview buttons under Voices for the rest.
