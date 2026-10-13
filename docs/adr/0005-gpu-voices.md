# 5. GPU voices

Date: 2026-10-13

Status: **Accepted for XTTS-v2.** The other three models were measured and not built. The quality
of every voice was left to listening ([docs/samples/gpu/](../samples/gpu/)); XTTS-v2 was chosen by
ear, for both languages, by the project's owner. See Decision below.

**Correction, same day.** The first XTTS-v2 clips and speeds were wrong. The library reported the
model's training rate (22050 Hz) as the output rate, while the decoder emits 24000 Hz. The clips
were written with the wrong rate, so they played 8 % slow and low, and the seconds of audio were
overstated by the same factor. The XTTS-v2 rows, clips and figures in this document are the
corrected ones (speed 0.47 instead of 0.46, load 22 s instead of 27 s). The other three models take
their rate from the model itself and were not affected.

## Decision

XTTS-v2 is added as a voice beside the CPU voices, not in place of them, with one speaker
("Claribel Dervla", the one the samples used). It is the one model here that is faster than real
time, so it can read live. Because the owner also wants to read with the fast CPU voices while a
document is being prepared, the app has both designs below in one: a helper process, a cache on
disk keyed by text, voice, language and speed, and a **Pre-render** button that fills the cache
for the open document in the background.

What was built, and where:

- `helper/xtts_helper.py`: loads the model once, then renders one sentence per request. The audio
  goes to a file, the pipe carries only JSON lines. It exits when its input closes.
- `src/main/xtts.ts`: starts and supervises the helper, one request at a time, a sentence being
  waited for before one being prepared, a cache folder trimmed to 2 GiB least recently used
  first, and a stop after ten idle minutes to free the GPU memory.
- `src/main/tts.ts`: lists the voice when the environment is installed; `synthesize` reads the
  cached file and runs the existing recogniser pass on it, so highlighting is unchanged.
- `src/shared/render-cache.ts`, `prerender.ts`, `requests.ts`: the key, the job, and the
  validation of requests from the renderer, with unit tests.
- `scripts/setup-gpu-voice.mjs` (`npm run gpu-voice`) and `helper/xtts-requirements.txt`: the
  environment, pinned to the versions the benchmark ran with. It asks for the licence to be
  accepted with a flag.
- Verified by `tests/e2e/gpu-voice.spec.ts`: the real app, helper and GPU. It renders the
  fixture while a CPU voice reads, then switches to XTTS and checks that every sentence came from
  the cache.

Differences from the plan above: the Pre-render button renders with XTTS whatever voice is chosen
for reading, which is what makes "read with another voice meanwhile" possible; speed is part of
the key and is taken when the job starts. The helper's sample rate is read from the model's
decoder, see the correction above. The wait before gap-free playback does not apply: at 0.47 live
reading keeps ahead of the voice on its own, and pre-rendering only removes the per-sentence wait.

## Context

The voices in ADR 2 run on the CPU through `sherpa-onnx-node` and are fast (0.27 to 0.32 seconds of
computing per second of audio). The question here is whether a larger model on the RTX 2070 (8 GB)
gives clearly better German and English voices, and what it would cost the app.

Requirements for a candidate: speaks German and English, runs fully offline after download, fits in
8 GB of VRAM, and its licence allows personal use.

## What was measured

Machine: Windows 11, RTX 2070 8 GB (driver 596.36, about 1.3 GB already used by the desktop),
Ryzen 7 3700X, Python 3.12.10 (64-bit), PyTorch 2.6.0+cu124, one virtual environment per model.
The same two sentences as `docs/samples/*.wav`, about 7 to 12 seconds of speech each. Three warm
runs per sentence after one cold run. Models loaded from a local folder with the Hugging Face hub
forced offline. Nothing was tuned: no FlashAttention, no `torch.compile`, no quantisation.

"Time per second of audio" is wall-clock seconds of computing divided by seconds of audio, the same
figure as in ADR 2. Below 1.0 is faster than real time.

| Model                                      | Precision | Load | Time per second of audio, warm (EN / DE) | First call, cold | VRAM used | Recogniser, word error (EN / DE) |
| ------------------------------------------ | --------- | ---- | ---------------------------------------- | ---------------- | --------- | -------------------------------- |
| XTTS-v2                                    | fp32      | 22 s | **0.47 / 0.47**                          | 4.4 s (0.55)     | 2.2 GB    | 0.00 / 0.00                      |
| Chatterbox Multilingual V3                 | fp32      | 20 s | 1.16 / 1.16                              | 10.2 s (1.32)    | 3.3 GB    | 0.25 / 0.05                      |
| Fun-CosyVoice3-0.5B                        | fp16      | 21 s | 1.12 / 1.59 (1.28 to 1.78)               | 11.5 s (1.16)    | 5.7 GB    | 0.05 / 0.05                      |
| Qwen3-TTS 1.7B CustomVoice                 | fp16      | 10 s | 3.26 / 3.27                              | 26.2 s (3.34)    | 4.8 GB    | 0.00 / 0.05                      |
| _For comparison, from ADR 2:_              |           |      |                                          |                  |           |                                  |
| Piper Thorsten, Kokoro, Supertonic 3 (CPU) |           |      | 0.27 to 0.32                             |                  |           | 0.00 / 0.00 (measured here)      |

How to read the columns:

- **VRAM used** is the rise in the device's used memory, sampled every 20 ms during load and
  synthesis, minus the level before loading. It includes the CUDA context. PyTorch's own peak
  allocation was lower: 2.0, 3.3, 4.3 and 4.3 GB in table order, 2.4 to 5.3 GB reserved. The whole
  card, with the desktop's 1.3 GB, peaked at 3.5, 4.6, 7.0 and 6.1 GB. CosyVoice3 leaves about 1 GB
  free. Another GPU program running at the same time will not fit beside it.
- **Recogniser** is the word error rate of the app's own recogniser (the NeMo FastConformer CTC
  model of `src/main/tts.ts`, same file, CPU) against the sentence that was synthesised, after
  lower-casing and removing punctuation. The five existing CPU clips scored 0.00 in the same
  check, so the check itself is clean. The score cannot tell a mispronounced word from a word the
  recogniser missed. Where it is not 0.00, listen at that spot:
  - Chatterbox EN heard "proposed methodignificantly outperforms preous approach".
  - Chatterbox DE heard "Bruchtteil" for "Bruchteil". Qwen3-TTS DE heard "nur ein Bruchteil" for
    "nur einen Bruchteil".
  - CosyVoice3 EN heard "benchmarked data sets" for "benchmark data sets". CosyVoice3 DE heard
    "Bruchtheil".
- **Cold** is the first call after load. It includes kernel set-up and allocator growth. The figure
  in brackets is the same call as time per second of audio.
- **Load** was measured with the model files already in the operating system's cache. A first load
  after boot will be slower. Not measured.
- The variation between runs is real: the models sample, so the same sentence differs in length from
  run to run (CosyVoice3 German ranged from 7.9 to 9.6 seconds of audio and from 1.28 to 1.78 in
  speed).

Per-model setup, so a number can be reproduced. Scratch folder `C:\Users\Work Tilly\tts-bench`,
scripts in `scripts/` there (`bench.py`, `asr_check.py`, not in the repository):

```
py -3.12 -m venv envs\<name>
envs\<name>\Scripts\python -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124

# Chatterbox
pip install chatterbox-tts==0.1.7
python -I -X utf8 bench.py chatterbox out

# Qwen3-TTS
pip install qwen-tts==0.1.1 soundfile
python -I -X utf8 bench.py qwen3tts out <local snapshot of Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice> Ryan

# XTTS-v2
pip install coqui-tts soundfile ; pip install transformers==4.57.3
python -I -X utf8 bench.py xtts out <local snapshot of coqui/XTTS-v2> "Claribel Dervla"

# Fun-CosyVoice3
git clone --recurse-submodules https://github.com/FunAudioLLM/CosyVoice   (commit 074ca6d)
pip install numpy==1.26.4 transformers==4.51.3 hyperpyyaml omegaconf hydra-core conformer==0.3.2 \
  diffusers==0.29.0 librosa lightning inflect wetext x-transformers==2.11.24 onnxruntime onnx \
  modelscope gdown soundfile pyarrow==18.1.0 rich matplotlib protobuf pydantic wget openai-whisper pyworld
python -X utf8 bench.py cosyvoice3 out <CosyVoice clone> <local snapshot of FunAudioLLM/Fun-CosyVoice3-0.5B-2512> <clone>\asset\zero_shot_prompt.wav

# Recogniser check, in a CPU-only environment with sherpa-onnx 1.13.8
python -I -X utf8 asr_check.py models\sherpa-onnx-nemo-fast-conformer-ctc-en-de-es-fr-14288-int8 out\<name>\manifest.json
```

Environment variables for every benchmark run: `HF_HOME` pointing into the scratch folder,
`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`.

## The models, and where each fact comes from

All four were evaluated; all four ran. Licence terms are quoted from files that came with the
download where there was one.

| Model                               | Languages (source)                                                                                                                                        | Licence                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **XTTS-v2** (Coqui, 2023)           | 17 languages incl. English and German ([model card](https://huggingface.co/coqui/XTTS-v2))                                                                | Coqui Public Model License 1.0.0, from `LICENSE.txt` in the model repo: "allows only non-commercial use of a machine learning model and its outputs". Personal use is listed: "personal study, private entertainment, hobby projects". Anyone who gets a copy of the model _or its output_ must get the terms or <https://coqui.ai/cpml.txt>. coqui.ai/cpml itself returned 404 on 2026-10-13 (Coqui has closed). |
| **Chatterbox Multilingual V3**      | 23 languages incl. German, English ([model card](https://huggingface.co/ResembleAI/chatterbox))                                                           | MIT, "Licensed under MIT" on the card; `LICENSE` in the wheel is the standard MIT text, "Copyright (c) 2025 Resemble AI". Every output carries a Perth watermark, per the card.                                                                                                                                                                                                                                   |
| **Fun-CosyVoice3-0.5B-2512**        | 9 languages: "Chinese, English, Japanese, Korean, German, Spanish, French, Italian, Russian" ([README](https://github.com/FunAudioLLM/CosyVoice))         | Apache-2.0: the model card metadata says `license: apache-2.0`, and `LICENSE` in the repo is Apache 2.0.                                                                                                                                                                                                                                                                                                          |
| **Qwen3-TTS 12Hz 1.7B CustomVoice** | 10 languages: "Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian" ([README](https://github.com/QwenLM/Qwen3-TTS)) | Apache-2.0: `license: apache-2.0` in the model's own README, and the wheel's `LICENSE` is the Apache 2.0 text.                                                                                                                                                                                                                                                                                                    |

Facts found while installing, each of which would be a maintenance cost:

- **Chatterbox** pins `torch==2.6.0` and `transformers==5.2.0`, and downloads a 35 MB `spacy-pkuseg`
  model into the user's home folder (`~/.pkuseg`) on first load, from GitHub. After that it runs
  offline. 0.1.7 imports and runs on Python 3.12 without a C compiler.
- **Qwen3-TTS**: with a Hub id, `transformers` 4.57.3 still calls the network from the tokeniser even
  with `HF_HUB_OFFLINE=1` and fails. Loading from the local snapshot folder is required. Only
  English, Chinese, Japanese and Korean speakers exist as presets. There is no German native
  speaker, so the German clip is an English speaker. The card's example uses FlashAttention 2 and
  bfloat16. FlashAttention was not installed (it is optional per the README) and `sdpa` attention
  was used. fp16 was used instead of bfloat16 because this GPU generation does not accelerate
  bfloat16 (general knowledge, not verified here).
- **XTTS-v2**: `pip install coqui-tts` resolved `transformers` 5.19, which broke the import
  (`isin_mps_friendly`). Pinning 4.57.3 fixed it. Loading by model name asks the user to accept the
  licence; loading from a local folder does not, and that is what was benchmarked.
- **Fun-CosyVoice3**: the README says Python 3.10 with conda and lists only Ubuntu and CentOS. Its
  `requirements.txt` targets that Python and pins `torch==2.3.1`, `numpy==1.26.4` and others.
  It was not installed as written: the benchmark used relaxed pins (list above) and the PyTorch
  2.6.0 build shared with the other models, so whether the original pins work on Windows is
  **unknown**. It ran with the relaxed set. `pyarrow` 26 needs NumPy 2 and CosyVoice needs NumPy
  1.26, so `pyarrow==18.1.0`. The weights are 9.75 GB in full; 5.1 GB was downloaded after
  skipping the RL checkpoint, the batch tokeniser and the TensorRT-oriented ONNX file. Nothing
  needed the skipped files.
- **Speed control.** The app passes a speed to the engine. In the code of the downloaded packages:
  CosyVoice has `speed=1.0` on every inference call and XTTS has `speed` on `inference`
  (as `length_scale`). Chatterbox's `generate` and Qwen3-TTS have no speed argument. Whether the
  parameter sounds right was **not tested**.

## Considered and not evaluated

| Model                               | Why not                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5-TTS                              | The README does not name German. Weights are "licensed under the CC-BY-NC license due to the training data Emilia". German through a community finetune is **unverified**. ([README](https://github.com/SWivid/F5-TTS))                                                                                                                                                                                               |
| Voxtral TTS (Mistral)               | German is supported and the weights are reported as CC BY-NC (secondary sources, not the model card). 4 billion parameters is about 7.5 GiB of weights at 16 bits, which leaves nothing on this card for activations after the desktop's 1.3 GB. Computed, not run. ([report](https://the-decoder.com/mistrals-first-open-weight-tts-model-voxtral-clones-voices-from-three-seconds-of-audio-across-nine-languages/)) |
| NVIDIA Magpie TTS Multilingual 357M | Lists German, NVIDIA Open Model License ([card](https://huggingface.co/nvidia/magpie_tts_multilingual_357m)). Needs the NeMo toolkit; no documented Windows route was found, which is **unverified** and not tried. A community C++ port exists (magpie-tts.cpp). A reasonable fifth candidate.                                                                                                                       |
| CosyVoice 2                         | Superseded in the same repository by Fun-CosyVoice3, which the README recommends.                                                                                                                                                                                                                                                                                                                                     |

## Consequences of the speed measurements

The reader keeps two sentences prepared ahead of the voice (`prefetch` in `reader.ts`). That keeps up
only if a sentence is rendered faster than it is spoken.

- Above 1.0, every sentence adds silence. An 8-second sentence rendered at 1.16 adds about 1.3
  seconds of waiting, at 3.3 about 18 seconds. A two-sentence lookahead cannot absorb that.
- Only **XTTS-v2** is faster than real time here, with a margin of about two.
- Chatterbox and CosyVoice3 are close to real time. A lookahead of the rest of the document, not two
  sentences, is what makes them playable, with a delay before starting. To play without a gap the
  voice must start (rate − 1) × (audio still to be rendered) after rendering begins. For 30 minutes
  of audio:

  | Model               | Render time for 30 min of audio | Wait before gap-free playback |
  | ------------------- | ------------------------------- | ----------------------------- |
  | XTTS-v2             | 14 min                          | none, just the first sentence |
  | Chatterbox          | 35 min                          | 4.7 min                       |
  | CosyVoice3, English | 34 min                          | 3.7 min                       |
  | CosyVoice3, German  | 48 min                          | 17.6 min                      |
  | Qwen3-TTS 1.7B      | 98 min                          | 68 min                        |

  This is arithmetic on the warm speeds above. It assumes the speed holds for a long run, which was
  not measured (the GPU may throttle; Electron's own rendering shares the card).

- Time to the first sentence after pressing play or seeking, for an 8-second sentence, warm speed
  times 8: XTTS-v2 about 4 seconds (4.4 on a cold first call), against 2.2 to 2.6 for the CPU voices
  now. Chatterbox about 9, CosyVoice3 9 (English) to 13 (German), Qwen3-TTS about 26.
- Cache size: 16-bit mono at 24 kHz is 48 KB per second, 86 MB for 30 minutes uncompressed.
  Compressed size was not measured.

## Two designs

Both need the same helper, because none of these models runs in the app's runtime (ADR 1 and 2): a
Python process in its own virtual environment, started by the main process and spoken to over
standard input and output, with no network port. The recogniser pass stays where it is, in the main
process, and still aligns the audio (above), so `align.ts` does not change.

**A. Helper renders just ahead of the voice.** Same behaviour as today: a short lookahead,
volatile, in memory. The only change is where the engine runs.

- Works with: XTTS-v2 only (0.47). The other three fall behind within a few sentences.
- Cost: the helper and its lifecycle; no persistent state; a seek costs the first sentence again.
- Limit: bound to a model at least about twice as fast as real time. If the preferred voice turns
  out to be one of the other three, this design has to be thrown away.

**B. Render from the cursor forward into a cache keyed by text, voice and speed.** The helper keeps
rendering to the end of the document into a cache on disk, and playback starts when the wait in the
table above has passed. Seeking inside rendered text is instant and so is re-reading. Cache
hits survive a restart.

- Works with: every model that ran, with a wait that grows with its speed.
- Cost: everything A costs, plus a cache store, a key, eviction by size, a "preparing" state in the
  interface, and a decision on speed (below).
- It contains A: when the model is faster than real time, the cache is just a long lookahead.

**Speed is the awkward part of B.** Speed is in the key, so changing it from 1.0 to 1.2 invalidates a
whole document. Either the model's own speed parameter is used (exists for XTTS-v2 and CosyVoice
in code, **not heard**), or audio is rendered once at 1.0 and stretched on playback with a
pitch-preserving time-stretch, which does not exist in Web Audio's `playbackRate` (it changes
pitch). Then the key does not need speed and word times are divided by the speed.

## Recommendation

**If a GPU voice is built, build B.** This GPU's speed supports B for all four models and A for
one of them:

1. **A works only with XTTS-v2** (0.47, a margin of about two). It is the smaller build.
   Its licence names personal use, which fits a personal app. Its company has closed; whether the
   model or the `coqui-tts` fork is still maintained is **unverified**. It is also the oldest of
   the four.
2. **Chatterbox and CosyVoice3** are only just slower than real time (1.1 to 1.6). Under B they
   need a wait of a few minutes up to about 18 minutes per half hour of text before gap-free
   playback, which is workable for a paper read in one sitting.
3. **Qwen3-TTS 1.7B** needs 68 minutes of waiting per half hour of text at 3.3. B makes it
   possible and not usable. On this GPU, as shipped, it is out unless a faster setting is found.

Nothing here says which voice is best. The decision has to wait for your ears:

- If none of the eight clips is clearly better than Piper Thorsten, Kokoro and Supertonic 3,
  build nothing. The GPU would add a 5 GB environment and a wait for no gain.
- If XTTS-v2 is the one you prefer, build A first and stop there.
- If Chatterbox or CosyVoice3 is the one you prefer, build B.

I did not rank the voices by sound and this section does not either.

## What it would cost to build B

An estimate of size, not a measurement.

| Piece                                                                                        | Where                          | Size                            |
| -------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------- |
| Helper: load model, read requests, write audio, report duration. One script per model family | new, outside `src/`            | about 150 lines of Python       |
| Main-side client: spawn, health, restart, one queue, cancel                                  | `src/main/`, next to `tts.ts`  | about 200 lines                 |
| Catalog entries for helper voices; voices dialog lists them                                  | `models.json`, `voices.ts`     | small                           |
| Cache: key (model and version, speaker, language, speed, normalised text), store, size cap   | `src/shared/` key, `src/main/` | about 150 lines plus tests      |
| Reader: look ahead to the end of the document, "preparing" state with progress               | `reader.ts`, `main.ts`         | moderate; the loop exists       |
| Environment set-up: `npm run gpu-voice` creating the venv with the tested versions           | `scripts/`                     | about 100 lines; the risky part |
| Tests: cache key and scheduling in `src/shared/`; one end-to-end case that needs the GPU     | `tests/`                       | small; e2e must be opt-in       |

Costs that are not code:

- **Disk**: a Python environment with PyTorch is 5.1 to 5.4 GB for each of these models (21.1 GB
  for the four here, each holding its own copy of PyTorch and CUDA), plus weights of 2 to 5 GB. The
  installer cannot carry it. It is an optional download.
- **Fragility**: the working versions found above (PyTorch 2.6.0, `transformers` 4.57.3 or 4.51.3,
  NumPy 1.26.4) were found by trial. Each library will move on. The set-up script has to pin them.
- **Hardware**: Windows with an NVIDIA GPU of 8 GB or more. The app has to keep working without it.
- **Not decided here**: Windows packaging of the helper, how to update the model, and what happens
  to a half-rendered document when the app closes.

## What was not verified

- Quality, in every sense. No claim is made.
- Whether any model's speed parameter sounds acceptable, and whether a time-stretch does.
- Speed over a long run (more than a paragraph), thermal behaviour and speed with the app open.
- Cold-boot load times.
- fp16 or bfloat16 or INT8 variants of Chatterbox and XTTS-v2, FlashAttention, `torch.compile`,
  or streaming output. Any of them might change the speeds; none was tried. The speeds here are
  for the models as the packages ship them.
- Whether the CosyVoice repository's bundled reference clip may be used to make samples.
- The German hyphen in the benchmark sentence, see the samples README.
- Whether the 0.6B Qwen3-TTS is fast enough. It was not run, so it is not counted as a fifth model.

## Disk and downloads used (outside the repository)

Scratch folder `C:\Users\Work Tilly\tts-bench`: weights 14.2 GB and wheels 2.9 GB were downloaded,
17.1 GB in total (under the 20 GB limit). Expanded on disk, with four environments, it is 38 GB.
One more folder was written outside it: `C:\Users\Work Tilly\.pkuseg` (0.1 GB, by Chatterbox). The
whole scratch folder can be deleted.
