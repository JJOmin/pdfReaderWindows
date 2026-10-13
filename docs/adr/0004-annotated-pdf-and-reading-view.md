# 4. Saving marks into a PDF, and a second view of the text

Date: 2026-10-13

## Context

Two requests arrived together. Marks and comments should be visible to people who do not have
this app. And the text should be readable in a plain, restyled form for readers with dyslexia,
with speech, marks and search working there as they do on the PDF pages.

## Decision: marks become standard PDF annotations in a copy

"Save PDF" writes a new file. Each mark becomes a Highlight, Underline or StrikeOut annotation
with its comment, and the general notes become a Text annotation on page one. The library
`@cantoo/pdf-lib` writes them. The original PDF and the notes file stay the source of truth.

Each annotation carries its own appearance stream, the drawing instructions for the mark. A PDF
program may draw an annotation that has none in its own style or, rarely, not at all. With the
stream the mark looks the same everywhere.

Where a mark lies on the paper is measured at save time. The page's text is laid out off screen
at scale 1 with the same PDF.js text layer the user selects on, and the rectangles of the marked
range are converted to PDF units. The saved mark therefore sits where the user saw it, and pages
that were never displayed need no special case.

### Why a library, against the "no new dependency" rule

PDF.js can write highlights but not underline or strikethrough. Writing annotations by hand
means parsing and rewriting PDF object and cross-reference structures, which is far more code
and risk than the feature is worth. `pdf-lib` is the established pure-JavaScript choice. The
`@cantoo` fork is the maintained one. The original has had no release since 2022.

### Considered

- **Writing the marks into the original file.** Rejected: a reader should never alter the
  user's source document as a side effect.
- **Leaving the appearance to each PDF program.** Less code, but the result then depends on the
  program.

## Decision: views are interchangeable behind one interface

`TextView` in `src/renderer/src/view.ts` has two implementations, the PDF pages and the reading
view. Both map raw ranges to DOM ranges and back. Speech highlighting, marks and search are
written once against raw ranges and painted through whichever view is on screen.

The reading view renders the same blocks the speech pipeline already produces: one element per
paragraph or heading, holding one text node with the block's readable text. A block already
knows the raw offset of each of its characters, so mapping in both directions needs no new data.

Search runs on the blocks' readable text, not on the raw string. That is why a phrase is found
across a line break or a hyphenated word, and why the same match list serves both views.

### Why

- One code path per feature. A third view, such as a two-page spread, would get speech, marks and
  search by implementing four methods.
- The reading view costs nothing while unused: it is built when first shown.

### Consequences

- Whatever text detection gets wrong, the reading view shows. Fixing layout fixes both speech and
  the reading view.
- Text that layout drops, such as running headers, cannot be found by search or shown in the
  reading view. A mark made on such text on the PDF page still works there.
- Fonts are bundled with the app (OpenDyslexic and Lexend, both under the Open Font License), so
  the reading view works offline.
