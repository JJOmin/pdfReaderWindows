# PDF Reader

A local Electron app that shows PDFs, lets the user highlight and comment, and reads the text
aloud while highlighting the spoken sentence and word. German and English. No cloud: the text and
the voices stay on the user's own devices.

How we work is in [docs/WORKFLOW.md](docs/WORKFLOW.md). What is built and what is next is in
[docs/SPEC.md](docs/SPEC.md). Why the big decisions were made is in [docs/adr/](docs/adr/).

## Commands

| Command                        | Use                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                | Type check, lint, format check, unit tests. Run before "done".                                                                                                      |
| `npm run test:e2e`             | Builds and drives the real app. Run after UI or speech changes.                                                                                                     |
| `npm run dump -- file.pdf [n]` | Prints what the reader would speak. The tool for text detection.                                                                                                    |
| `npm run dev`                  | Starts the app with hot reload.                                                                                                                                     |
| `npm run models`               | Downloads the recommended speech models into `models/`.                                                                                                             |
| `npm run gpu-voice`            | Sets up the optional XTTS-v2 GPU voice (Python env, 7 GB).                                                                                                          |
| `npm run dist:mac`             | Builds the Mac's `.dmg` (Apple Silicon, ad-hoc signed; ADR 9).                                                                                                      |
| `npm run fixtures`             | Regenerates `tests/fixtures/sample.pdf`. The committed copy was made on Windows; a Mac breaks its lines differently, and the phone's golden files need these bytes. |

Inside VS Code's Claude extension `ELECTRON_RUN_AS_NODE=1` is set, which makes Electron start as
plain Node. Prefix anything that launches Electron: `env -u ELECTRON_RUN_AS_NODE npm run dev`.
The e2e tests already strip it.

## Layout

- `src/shared/` Pure logic with no DOM or Node APIs. Everything hard lives here and is unit tested.
  Files import each other with the `.ts` extension so Node can run them directly.
  - `layout.ts` text runs to paragraphs and headings. `utterances.ts` paragraphs to sentences,
    words, language and voice role. `align.ts` word timings. `notes.ts` marks and comments.
    `search.ts` finding a phrase. `render-cache.ts` and `prerender.ts` the GPU voice's cache key
    and the pre-render job, `requests.ts` checking a speech request from the renderer.
- `src/main/` Electron main process: file access, settings, `tts.ts`, which runs the speech
  models through `sherpa-onnx-node`, and `annotate.ts`, which writes marks into a PDF copy.
  `sync/` sends the phone library to Nextcloud (ADR 8; Dropbox removed for now, ADR 10): `webdav.ts`,
  `engine.ts`, `manager.ts`; `shared/sync-store.ts` has the store interface, packs and encryption.
  `xtts.ts` drives the GPU voice: a Python helper (`helper/xtts_helper.py`, JSON lines over
  stdin and stdout) that renders sentences into a cache folder. ADR 5 has the reasons.
- `src/preload/` The only bridge. The renderer gets the `Api` interface from `shared/types.ts`.
- `src/renderer/` The window. `view.ts` defines `TextView`, the interface of both ways to show
  the text: `pdf.ts` (the document plus the PDF.js pages) and `reading-view.ts` (plain restyled
  text). `reader.ts` is playback, `notes-panel.ts` marks, `search.ts` search, `voices.ts` voices.
- `models.json` The speech model catalog, read by the app and by `scripts/fetch-models.mjs`.

## The one idea to keep intact

A page's **raw string** is every PDF.js text run concatenated in stream order. The text layer in
the DOM holds exactly the same string. A `RawRange` is a span of offsets into it. The spoken
sentence and word, the user's marks, saved annotations and search matches are all raw ranges.
Each `TextView` maps them to the screen with `domRanges` and back with `rawSpan`, so a feature
written against raw ranges works in the PDF view and the reading view alike. Do not introduce a
second coordinate system, and do not add a feature to one view only.

## Rules

- Smallest change that fully solves the task. Use the platform first: `Intl.Segmenter`, the CSS
  Custom Highlight API, `<dialog>`, Web Audio. Ask before adding a dependency.
- New logic goes in `src/shared/` with a unit test. A bug gets a failing test before the fix.
- The renderer is sandboxed. It never gets file paths or Node. New capabilities go through
  `Api`, and the main process validates everything it receives.
- No internet at runtime: no cloud voices, no external models or LLMs, no downloads. Speech is
  made on the user's own machine. The only network uses are phone sync: on the local network
  (ADR 7) with phones the user paired, and through the user's own Nextcloud (ADR 8)
  after they signed in, as encrypted files. Only the main process talks to the network.
- Comments explain why, not what. A known limit is marked `// shortcut: <limit>, <when to upgrade>`.
- Do not claim something works without running it. For speech and highlighting that means e2e.
- Shell heredocs halve backslashes here. Edit files that contain regular expressions with the
  Edit or Write tool, not through a script.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
