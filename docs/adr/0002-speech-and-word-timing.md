# 2. Speech engines and word timing

Date: 2026-10-13

## Context

Speech must sound good in German and English, run on this PC without a server, and tell the app
when each word is spoken. The user liked Piper and wants to try newer small models.

## Decision

All speech runs through one runtime, `sherpa-onnx-node`, on the CPU. Word timings come from a
second pass: a small multilingual speech recogniser listens to each synthesised sentence and
returns a time for every word piece. `src/shared/align.ts` matches what it heard to the words on
the page.

## Measurements

One eight-second sentence on this machine (Ryzen 7 3700X). Lower is faster, below 1.0 is faster
than real time.

| Model                           | Language | Time per second of audio |
| ------------------------------- | -------- | ------------------------ |
| Piper Thorsten high             | German   | 0.31                     |
| Kokoro v1.0, full precision     | English  | 0.32                     |
| Supertonic 3                    | both     | 0.27 to 0.32             |
| Pocket TTS                      | English  | 0.56                     |
| Kokoro v1.0, 8-bit quantised    | English  | 1.32, too slow           |
| Recogniser pass for word timing | both     | 0.03                     |

The recogniser transcribed every engine's output without an error, in both languages.

## Why

- No engine available in this runtime reports word timings. Piper and Kokoro compute durations
  internally but do not expose them.
- The recogniser pass works for every engine, present and future, and adds about three percent to
  the cost of a sentence.
- One runtime means one way to load, configure and call a model. Adding an engine is a catalog
  entry and a config mapping.

## Considered

- **Estimating word times from word length.** Kept as the fallback. It drifts in long sentences.
- **Kokoro's timestamped model.** English only, and needs its own phonemizer and runtime.
- **Patching Piper voices to output alignments.** Needs Python tooling per voice.

## What was ruled out

- **Kokoro for German.** The official model has no German voice. Community German voices exist
  but are not in this runtime.
- **Nix-TTS.** English only.
- **CosyVoice2.** Needs a 64-bit Python environment, which this machine lacks.

## Consequences

- Word times have a resolution of 80 milliseconds, the recogniser's frame size.
- A word the recogniser hears differently, such as a number, gets an interpolated time.
- Pocket TTS in this runtime is English only and its export is licensed for non-commercial use.
- The GPU is unused. Larger models such as Chatterbox Multilingual would use it, see ADR 1.
