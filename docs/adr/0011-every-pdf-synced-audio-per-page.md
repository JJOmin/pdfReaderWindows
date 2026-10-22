# 11. Every PDF is synced at once; its audio follows page by page

Date: 2026-10-22

Status: **Accepted** by the owner on 2026-10-22, in their words: "as soon as I open a PDF, the audio
should be rendered, with a button to pause, but by default always running. As soon as I open a PDF,
it should be synced, and the audio should be uploaded per page, directly after rendering"; and a
document sent to the phone without audio is sent at once, its audio prepared in the background. It
changes ADR 7 section 2 (the library), ADR 8 (what is uploaded) and ADR 10 sections 3 and 6. Steps
S16 and S17 in SPEC.md, 7.9 in the Flutter repository's PLAN.md.

## Context

A document reaches the phone only after its whole audio was rendered: the library writes the
manifest, and with it the document, when the last page is done. Rendering a long paper takes many
minutes and is started by hand ("Sync this document"). Until then the PDF, its marks and the place
in it are not synced at all, and "Send to phone" cannot send it. The phone can already show and mark
a PDF without audio; it reads aloud only the pages that have it.

## Decision

1. **A document is in the library as soon as it is opened.** Opening a PDF copies it into the library
   and writes a manifest that says which pages have audio, none at first. From then on its PDF, notes
   and place are synced like any other, by Nextcloud and over Wi-Fi, and it can be sent to a phone.
   "Stop syncing" still leaves one out of the store.
2. **The manifest, version 2,** adds `voiced`, the pages that have audio, in any order, and `voices`, a
   hash of the voices that made them. `pages` is the PDF's page count; `updated` changes with every
   page added, so the journals and `GET /v1/changes` report it. Version 1 is read as every page voiced.
3. **Rendering starts on its own** when a PDF is opened, from the page on screen, and goes on to the
   end and then the pages before. A button pauses and resumes it; it runs by default. A page is
   written, index and audio, as soon as its sentences are rendered. A document whose audio was made
   with other voices is left as it is; "Prepare audio again" starts over with the chosen ones.
4. **Each page goes up as soon as it is written.** A change is sent at most 10 seconds after the first
   change not yet sent (instead of 10 seconds after the last, which page after page would put off to
   the end). Only the pages the store lacks are sent; the phone fetches only the pages it lacks, from
   the store or over Wi-Fi. Pages of other voices are replaced.
5. **The phone** lists such a document with how many of its pages have audio, reads aloud those pages
   and shows the others as a plain PDF. An update with new pages is fetched as before: on Wi-Fi by
   itself, on a metered network when the user taps.

## Consequences

- Every PDF the user opens is copied into the library and, when signed in, into their Nextcloud. That is
  what the owner asked for; "Stop syncing" is the way out for a single document.
- Rendering runs whenever a document is open: the GPU or CPU is busy while the user reads. Pausing is
  one click.
- A sentence shared by several pages is rendered once, as before; each page's pack carries it.
