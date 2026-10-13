# PDF Reader

A local PDF reader for paper reviews and note taking. It reads German and English text aloud with
neural voices and marks the sentence and the word being spoken. You can highlight, comment and
export your notes as Markdown. Nothing is sent anywhere.

## Start

Needs Node 22.13 or later on Windows 10 or 11.

```
npm install
npm run models
npm run dev
```

`npm run models` downloads about 700 MB of speech models into `models/`: Kokoro for English, Piper
Thorsten for German, Supertonic 3 for both, and the recogniser that times the words.
`npm run models -- --list` shows what is installed, `npm run models -- pocket` adds Pocket TTS.

Open a file with the Open button, or pass it on the command line with two double dashes:
`npm run dev -- -- paper.pdf`.

### GPU voice (optional)

XTTS-v2 is a larger voice that runs on an NVIDIA GPU. It needs a 64-bit Python 3.12 (`py -3.12`),
about 3 GB of free GPU memory and about 7 GB of downloads. Its licence allows non-commercial use
only, so setup asks you to agree:

```
npm run gpu-voice -- --accept-licence
```

After a restart it is listed under **Voices** as "XTTS-v2 · Claribel Dervla (GPU)" for both
languages. **Pre-render** in the toolbar renders the open document with it in the background,
while you keep reading with any other voice. Rendered sentences are kept between sessions.

## Use

- **Space** starts and pauses reading. The arrows in the toolbar skip by sentence.
- **Select text** to highlight, underline or strike it through in a colour, or to start reading
  from that point.
- **Ctrl+F** searches the document. Enter and Shift+Enter step through the matches.
- **Reading view** shows the text alone in a font, size, spacing and colour scheme you choose,
  including OpenDyslexic. Reading aloud, marks and search work there too.
- **Voices** sets a voice for main text, quotes and headings in each language.
- **Notes** holds your comments. They are saved next to the PDF as `paper.pdf.notes.json`.
  **Markdown** writes `paper.pdf.notes.md`. **Save PDF** writes a copy of the PDF that carries
  your marks and comments, for people who use another PDF program.

## Develop

See [CLAUDE.md](CLAUDE.md) for the layout and rules, [docs/SPEC.md](docs/SPEC.md) for what works
and what is next, and [docs/WORKFLOW.md](docs/WORKFLOW.md) for how to work on it with Claude Code.

```
npm run check       type check, lint, format check, unit tests
npm run test:e2e    build and drive the real app
npm run dump -- paper.pdf 3    print what the reader would speak on page 3
```
