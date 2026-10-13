# PDF Reader

A local Electron app that shows PDFs, lets the user highlight and comment, and reads the text
aloud while highlighting the spoken sentence and word. German and English. Nothing leaves the PC.

How we work is in [docs/WORKFLOW.md](docs/WORKFLOW.md). What is built and what is next is in
[docs/SPEC.md](docs/SPEC.md). Why the big decisions were made is in [docs/adr/](docs/adr/).

## Commands

| Command                        | Use                                                              |
| ------------------------------ | ---------------------------------------------------------------- |
| `npm run check`                | Type check, lint, format check, unit tests. Run before "done".   |
| `npm run test:e2e`             | Builds and drives the real app. Run after UI or speech changes.  |
| `npm run dump -- file.pdf [n]` | Prints what the reader would speak. The tool for text detection. |
| `npm run dev`                  | Starts the app with hot reload.                                  |
| `npm run models`               | Downloads the recommended speech models into `models/`.          |
| `npm run fixtures`             | Regenerates `tests/fixtures/sample.pdf`.                         |

Inside VS Code's Claude extension `ELECTRON_RUN_AS_NODE=1` is set, which makes Electron start as
plain Node. Prefix anything that launches Electron: `env -u ELECTRON_RUN_AS_NODE npm run dev`.
The e2e tests already strip it.

## Layout

- `src/shared/` Pure logic with no DOM or Node APIs. Everything hard lives here and is unit tested.
  Files import each other with the `.ts` extension so Node can run them directly.
  - `layout.ts` text runs to paragraphs and headings. `utterances.ts` paragraphs to sentences,
    words, language and voice role. `align.ts` word timings. `notes.ts` annotations.
- `src/main/` Electron main process: file access, settings, and `tts.ts`, which runs the speech
  models through `sherpa-onnx-node`.
- `src/preload/` The only bridge. The renderer gets the `Api` interface from `shared/types.ts`.
- `src/renderer/` The window: `pdf.ts` (PDF.js view and text-to-screen mapping), `reader.ts`
  (playback), `notes-panel.ts` (highlights), `voices.ts` (voice settings).
- `models.json` The speech model catalog, read by the app and by `scripts/fetch-models.mjs`.

## The one idea to keep intact

A page's **raw string** is every PDF.js text run concatenated in stream order. The text layer in
the DOM holds exactly the same string. A `RawRange` is a span of offsets into it. Speech
highlights, user highlights and saved annotations all use raw ranges, so one mapping
(`Pdf.domRanges` and `Pdf.rawSpan`) serves all three. Do not introduce a second coordinate system.

## Rules

- Smallest change that fully solves the task. Use the platform first: `Intl.Segmenter`, the CSS
  Custom Highlight API, `<dialog>`, Web Audio. Ask before adding a dependency.
- New logic goes in `src/shared/` with a unit test. A bug gets a failing test before the fix.
- The renderer is sandboxed. It never gets file paths or Node. New capabilities go through
  `Api`, and the main process validates everything it receives.
- Everything runs offline. No network calls at runtime.
- Comments explain why, not what. A known limit is marked `// shortcut: <limit>, <when to upgrade>`.
- Do not claim something works without running it. For speech and highlighting that means e2e.
- Shell heredocs halve backslashes here. Edit files that contain regular expressions with the
  Edit or Write tool, not through a script.
