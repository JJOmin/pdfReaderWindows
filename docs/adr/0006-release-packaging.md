# 6. Release packaging

Date: 2026-10-13

Status: **Accepted** for the first alpha, `0.1.0-alpha.1`.

## Decision

- **electron-builder, Windows NSIS installer, x64.** Configured in `electron-builder.config.mjs`.
  A per-user install, no admin rights, the folder can be changed.
- **The recommended speech models are bundled in the installer.** The config reads `models.json`
  and copies every entry with `"recommended": true` into `resources/models/`. A new install reads
  aloud without a second download, and the app stays offline (ADR 1). The installer is about
  700 MB; Pocket TTS (not recommended) and the GPU voice are left out.
- **The GPU voice is not shipped.** It needs a 64-bit Python 3.12, 7 GB of downloads and a licence
  step, which today are `npm run gpu-voice` in a checkout. Only the helper script is packaged,
  beside the app, so that a later installer can set it up. Without its Python environment the
  voice is simply not listed.
- **Licence: PolyForm Noncommercial 1.0.0**, the project owner's choice: anyone may use, change
  and share it, nobody may make money from it. This is source-available, not open source in the
  OSI sense, and GitHub shows it as "Other".
- **Not code-signed.** A certificate costs money and the alpha has a handful of users. The release
  notes tell them to expect the SmartScreen warning.

## Consequences

- Packaged paths differ from development: models and the helper are read from `resources/`, next
  to `app.asar`, never from inside it (`src/main/resources.ts`). Python cannot read a script out of
  an archive, and the native addon needs `onnxruntime.dll` on disk (`asarUnpack`).
- A user cannot add models to an installed app: the packaged app reads only its own `resources/models`.
  `PDFREADER_MODELS` still points it elsewhere.
- Bundling puts third-party model licences in the installer: GPL-3.0 phonemizer data, OpenRAIL-M
  use restrictions, CC-BY attribution. `THIRD_PARTY_NOTICES.md` lists them, and each model folder
  keeps the licence file it came with. That list was taken from `models.json` and the packages'
  own metadata and has not been reviewed by a lawyer.
- No auto-update, no CI, no macOS or Linux build. Each is a later decision.
