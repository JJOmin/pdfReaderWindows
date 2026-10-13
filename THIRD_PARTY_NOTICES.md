# Third-party notices

PDF Reader itself is under the PolyForm Noncommercial License 1.0.0, see `LICENSE`. The installer
carries the parts below, each under its own terms. Licences are as stated by each package's own
metadata or by `models.json`; each model folder in `resources/models/` also holds the licence or
model card that came with it.

## Speech models (bundled in the installer)

| Part                              | What it does                        | Licence                                             |
| --------------------------------- | ----------------------------------- | --------------------------------------------------- |
| Kokoro (`kokoro-multi-lang-v1_0`) | English voices                      | Apache-2.0                                          |
| Piper Thorsten (`thorsten-high`)  | German voice                        | Voice data CC0; phonemizer data (espeak-ng) GPL-3.0 |
| Supertonic 3 (int8)               | German and English voices           | Code MIT, model OpenRAIL-M (use restrictions apply) |
| NeMo FastConformer CTC (int8)     | Times the spoken words; not a voice | CC-BY-4.0                                           |

- **Piper Thorsten and Kokoro** include the `espeak-ng-data` folder (GPL-3.0 per the catalog's
  note for Piper). It is shipped as separate data files beside the program, not linked into it.
  The source of espeak-ng is at <https://github.com/espeak-ng/espeak-ng>.
- **Supertonic 3** is released under OpenRAIL-M, which carries use restrictions that pass on to
  anyone who receives the model. Its `LICENSE` and `README.md` are in its model folder.
- **The recogniser** is licensed CC-BY-4.0, which requires attribution: it is a NVIDIA NeMo
  FastConformer CTC model (English, German, Spanish, French) exported for sherpa-onnx.

## Libraries

| Package             | Licence    |
| ------------------- | ---------- |
| Electron            | MIT        |
| PDF.js (pdfjs-dist) | Apache-2.0 |
| sherpa-onnx         | Apache-2.0 |
| @cantoo/pdf-lib     | MIT        |
| Lexend font         | OFL-1.1    |
| OpenDyslexic font   | OFL-1.1    |

Electron's own third-party licences are in `LICENSES.chromium.html`, installed beside the program.

## Not included

The optional XTTS-v2 GPU voice is not in the installer. Its model licence (Coqui Public Model
License) allows non-commercial use only and is accepted during `npm run gpu-voice`.

This file is a good-faith summary, not legal advice.
