---
name: text-detection
description: Use when a PDF is read aloud wrongly - text in the wrong order, a heading read as body text or the reverse, headers or figure labels being read, a sentence split or joined in the wrong place, the wrong language or voice chosen, or a highlight on the wrong words.
---

# Fixing text detection

Text detection is pure code in `src/shared/`. It never needs the app to debug.

## 1. Reproduce with the dump

```
npm run dump -- path/to/file.pdf 3
```

This prints every utterance of page 3 as `[role lang] text`. Find the wrong line. If the dump
looks right but the app does not, the problem is not text detection. Look at
`src/renderer/src/reader.ts` or `pdf.ts` instead.

## 2. Find the stage

| Symptom                                           | File and function                       |
| ------------------------------------------------- | --------------------------------------- |
| Lines joined or split wrongly, hyphens, columns   | `layout.ts`, `toLines` and `appendLine` |
| Paragraph borders, headings, headers and footers  | `layout.ts`, `layoutPage`               |
| Sentence borders, abbreviations                   | `utterances.ts`, `sentenceSpans`        |
| Quote or heading voice                            | `utterances.ts`, `buildUtterances`      |
| Wrong language                                    | `language.ts`                           |
| Citations or other text that should not be spoken | `utterances.ts`, `CITATION`             |
| Highlight on the wrong characters                 | the `raw` arrays in `layout.ts`         |

## 3. Write the failing test first

Add a case to `tests/unit/layout.test.ts` or `tests/unit/utterances.test.ts`. Build the input by
hand with the `line()` or `block()` helper in that file. Copy the real numbers that matter (font
size, y position, font name) from the PDF. To see them, print `items` in `scripts/dump-text.ts`
for the one page.

Do not add the user's PDF to the repository. The test must stand on its own.

## 4. Fix, then check for collateral damage

```
npm run check
npm run dump -- tests/fixtures/sample.pdf
npm run dump -- path/to/file.pdf 3
```

Heuristics here trade one document's error for another's. After the fix, dump one or two other
PDFs you have and compare with the output from before the change.

## Rules

- Every character in a block's `text` needs an entry in `raw`: its offset in the page's raw
  string, or -1 if layout invented it. A fix that changes `text` without `raw` breaks highlights.
- When unsure, join rather than split. A sentence that runs a little long sounds better than one
  cut in the middle.
- A threshold gets a named constant and one line saying what it separates.
