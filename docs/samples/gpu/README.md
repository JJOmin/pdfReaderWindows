# GPU voice samples

Eight clips, one per model and language, for judging by ear. They speak the same two sentences as
the clips in [docs/samples/](..), and were produced on the RTX 2070 by the benchmark described in
[ADR 5](../../adr/0005-gpu-voices.md).

The two XTTS-v2 clips were replaced the same day: the first versions were saved with the wrong
sample rate (22050 instead of 24000 Hz) and sounded about 8 % slower and lower than the model
speaks. The current files are new takes at the right rate.

| File                                     | Model                             | Voice used                                  | Precision |
| ---------------------------------------- | --------------------------------- | ------------------------------------------- | --------- |
| `en-` / `de-chatterbox-multilingual.wav` | Chatterbox Multilingual V3 (500M) | Built-in default voice                      | fp32      |
| `en-` / `de-qwen3-tts-1.7b.wav`          | Qwen3-TTS 12Hz 1.7B CustomVoice   | Preset speaker "Ryan" (native English)      | fp16      |
| `en-` / `de-xtts-v2.wav`                 | XTTS-v2                           | Built-in speaker "Claribel Dervla"          | fp32      |
| `en-` / `de-cosyvoice3.wav`              | Fun-CosyVoice3-0.5B-2512          | Cloned from the repo's bundled Chinese clip | fp16      |

The sentences:

- en: The proposed method significantly outperforms previous approaches on three benchmark data
  sets, while requiring only a fraction of the compute.
- de: Die vorgeschlagene Methode übertrifft bisherige Ansätze auf drei Benchmark-Datensätzen
  deutlich und benötigt dabei nur einen Bruchteil der Rechenleistung.

The source text of the older clips is not in the repository. It was reconstructed from what the
recogniser heard in them, so the German hyphen in "Benchmark-Datensätzen" is a guess.

The voice is not a fair comparison between models: each model was given the most neutral option it
offers, and they differ (a preset speaker, a built-in default, a cloned reference). Qwen3-TTS has no
native German preset, so its German clip is an English speaker reading German.

## Licences of the audio

- **XTTS-v2 clips**: Coqui Public Model License 1.0.0. It allows non-commercial use of the model
  _and its output_, and requires that anyone who receives a copy of the output also gets these terms
  or <https://coqui.ai/cpml.txt>. Do not publish these two files without this note.
- **Chatterbox clips**: the model is MIT. Every clip carries Resemble AI's inaudible Perth
  watermark (stated on the model card).
- **Qwen3-TTS and CosyVoice3 clips**: Apache-2.0 models. The CosyVoice3 clips are cloned from a
  reference clip that ships with the CosyVoice repository, whose own terms were not checked.
