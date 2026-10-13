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
