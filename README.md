# Easy Reader

A local PDF reader for paper reviews and note taking. It reads German and English text aloud with
neural voices and marks the sentence and the word being spoken. You can highlight, comment and
export your notes as Markdown. Nothing is sent anywhere.

## Install

Windows 10 or 11, 64-bit. Download `PDF-Reader-<version>-setup.exe` from the
[releases page](https://github.com/JJOmin/pdfReaderWindows/releases) and run it. The speech models
are inside the installer, about 700 MB, so the first start already reads aloud.

- The installer is **not code-signed**. Windows SmartScreen will say it protects your PC: choose
  **More info**, then **Run anyway**.
- The optional GPU voice is not part of the installer. It runs from a source checkout, see below.
- Licence: [PolyForm Noncommercial 1.0.0](LICENSE). Anyone may use, change and share it for
  non-commercial purposes; selling it or using it commercially is not allowed. Parts it carries
  have their own licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Start from source

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
languages. Each sentence is rendered as it is needed, takes a few seconds, and is kept between
sessions, so a sentence read once plays at once the next time.

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

### Build the installer

Needs the recommended models in `models/` (`npm run models`). Then:

```
npm run check
npm run test:e2e
npm run dist       writes dist/PDF-Reader-<version>-setup.exe
npm run pack       the same app unpacked in dist/win-unpacked, quicker to try
```

The models listed as recommended in `models.json` are copied into the installer. To publish: set
the version in `package.json`, tag it (`git tag v0.1.0-alpha.1`), and attach the installer to a
GitHub release marked as a pre-release. [ADR 6](docs/adr/0006-release-packaging.md) has the reasons.
