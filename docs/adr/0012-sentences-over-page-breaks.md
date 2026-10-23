# 12. A sentence over a page break is read as one

Date: 2026-10-22

Status: **Accepted** by the owner on 2026-10-22, with the rule that a sentence that starts on a page
belongs to that page whole: its continuation on the next page is rendered and sent with it.
Improvement round 1, step R5 in SPEC.md; 8.4 in the Flutter repository's PLAN.md.

## Context

Everything is per page: the raw string, the raw ranges, the sentences, the library's page index with
its words hash, and the audio sent page by page (ADR 11). A sentence cut by a page break was read as
two, with a pause at the break, and its second half started the next page.

## Decision

1. **The join** (`joinedPage` in `shared/utterances.ts`, ported to the phone): when a page's last
   sentence has no end (`.`, `!`, `?`, `…` or `:`, with closing quotes or brackets) and neither it nor
   the next page's first sentence is a heading, the two are one sentence of the first page. The next
   page leaves its first sentence out.
2. **No second coordinate system.** A word of the continuation keeps its own page (`Word.page`); the
   sentence keeps its ranges on its page and gets a `next` part with the page and the ranges of the
   continuation. Every raw range is still an offset into the raw string of the page it is on.
3. **The library needs no new version.** A page's words are the words of its sentences, so page 1's
   words hash covers the continuation and page 2's leaves it out; the phone joins the same way and
   compares the same words. The golden page words are written with the join.
4. Both apps tint the sentence on both pages and the spoken word on its own page.

## Consequences

- A page's sentences depend on the next page's text, so preparing or reading a page lays out its
  neighbour too.
- A word hyphenated over the page break is read as two (`// shortcut` in `joinedPage`).
- A page whose last line is a caption or a list item without a full stop can be joined with the next
  page's first sentence. When unsure, joining was preferred to splitting (the text-detection skill).
