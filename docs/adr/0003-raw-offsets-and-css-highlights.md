# 3. Raw offsets and CSS highlights

Date: 2026-10-13

## Context

Three features need to point at text on a page: the spoken sentence and word, user highlights on
screen, and annotations saved to disk. The text the voice speaks is not the text in the PDF:
hyphens are removed, ligatures expanded, lines joined, headers dropped.

## Decision

A page's **raw string** is every PDF.js text run concatenated in stream order. Positions are
half-open ranges of offsets into it. While layout rewrites the text for speech, it keeps for
every character the raw offset it came from.

Highlights are painted with the CSS Custom Highlight API over PDF.js's transparent text layer.

## Why

- The text layer's DOM text nodes hold exactly the raw string, because both are built from the
  same PDF.js call with the same options. Mapping a raw offset to a DOM position is a walk over
  text nodes and needs no knowledge of PDF.js internals.
- One coordinate system serves all three features. A selection becomes an annotation and an
  annotation becomes a painted range through the same two functions.
- The Highlight API paints ranges without changing the DOM. PDF.js can re-render a page at any
  time and nothing of ours is lost. Overlapping highlights and priorities come for free.

## Consequences

- A page's highlights can only be painted while its text layer is rendered. They are repainted
  whenever PDF.js reports a rendered text layer.
- Saved offsets depend on PDF.js producing the same text for the same file. Each annotation also
  stores its text, and is found again by search if the offsets no longer match.
- A word broken across lines is two ranges. Code must never assume one range per word.
