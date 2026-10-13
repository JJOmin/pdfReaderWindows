---
name: add-voice
description: Use when adding, replacing or trying out a speech model or voice - a new Piper voice, another language, a different TTS engine, or changing the default voices.
---

# Adding a speech model

The app can use any text-to-speech model that `sherpa-onnx` supports. Models are listed at
https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models

## 1. Measure before wiring anything

Download the archive into a scratch folder, not into the project. Run one German or English
sentence through it with a ten-line Node script, as in the examples at
https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples

Record three numbers: load time, synthesis time divided by audio length, and the sample rate.
Anything slower than 0.6 seconds per second of audio will stutter between sentences on this PC.
Prefer full-precision models: the 8-bit Kokoro build ran four times slower here than the full one.

Save a WAV file and ask the user to listen. Speed can be measured. Quality cannot.

## 2. Add it to the catalog

Add an entry to `models.json`: `id`, `label`, `engine`, `dir` (the folder name inside the
archive), `url`, `sizeMb`, `license`, `langs`, `recommended` and `speakers` (speaker id to a name
the user will see). Read the model's licence and write down what it actually says.

## 3. Map the engine, only if it is new

A new Piper voice needs nothing more: the `vits` case in `engineConfig` in `src/main/tts.ts`
derives the file names from the folder name. A new engine type needs a case there, plus any
per-request options in `Tts.run`.

## 4. Verify in the app

```
npm run models -- <id>
npm run check
env -u ELECTRON_RUN_AS_NODE npm run dev
```

Open Voices, pick the new voice, press its preview button. Then read a paragraph and watch the
word highlight. If the highlight lags or jumps, the recogniser may not understand this voice:
check `aligned` in the result of `tts:synthesize`.

To make it a default, change `defaultSettings` in `src/shared/settings.ts` and its test.

## Rules

- Never add a model that calls a server. Everything stays on the PC.
- Record the measurement in `docs/adr/0002-speech-and-word-timing.md`.
