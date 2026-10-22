# 9. macOS as the second desktop platform

Date: 2026-10-22

Status: **Accepted** by the owner on 2026-10-22, with all four recommendations under "The owner's
choices": ad-hoc signing, Apple Silicon only, the app keeps running when its last window closes,
and the models bundled. The steps are MAC1 to MAC5 in SPEC.md.

## Context

The owner moved from the Windows PC to a MacBook Air M1 (Apple Silicon, arm64). The phone has no
voice of its own (Flutter ADR 2): it plays only what a desktop prepared. Without the desktop app
on the Mac, the phone gets nothing new while the PC is not at hand. So the Mac build comes
before any further phone work.

The code was written for Windows but stayed mostly portable:

- `sherpa-onnx-node` ships prebuilt `darwin-arm64` and `darwin-x64` binaries, already in
  `package-lock.json`.
- `safeStorage`, which keeps the Nextcloud and Dropbox tokens (ADR 8), uses the Keychain on macOS.
- The GPU voice already looks for `bin/python` outside Windows.
- Paths go through `node:path`, and the user's files are under `app.getPath('userData')`.
- The fonts the reading view offers (Verdana, Georgia, Arial, Comic Sans MS) come with macOS.

What does not carry over is listed below.

## Decision

### 1. One code base, one repository

The Mac is a build target of this repository, not a fork. `src/shared/` and the renderer stay
free of platform checks. A difference between the platforms lives in `src/main/` or the build
config. Each one is a single `process.platform === 'darwin'` branch with a comment saying why.
The folder name `pdfReaderWindows` is only a name. Renaming it is the owner's choice and changes
nothing in the code.

### 2. Packaging: an arm64 `.dmg`, ad-hoc signed

- electron-builder gets a `mac` target: `dmg`, `arm64`. Like ADR 6, it bundles the recommended
  models (about 700 MB), so a fresh install reads aloud at once.
- `asarUnpack` adds `node_modules/sherpa-onnx-darwin-arm64/**`. The addon loads its `.dylib`
  files from disk, as on Windows it loads `onnxruntime.dll`.
- **Ad-hoc signed, not notarised.** Apple Silicon runs no unsigned code, so the app and its
  `.dylib` files must at least be ad-hoc signed. electron-builder does that with `identity: '-'`.
  A Developer ID certificate and notarisation need a paid Apple Developer account (99 USD a
  year).
  - A `.dmg` built and installed on the same Mac opens normally, because it carries no
    quarantine flag.
  - A downloaded copy is blocked once. The user allows it in System Settings, Privacy &
    Security, "Open Anyway". The release notes say so, as ADR 6's notes do for SmartScreen.
- Intel Macs are not built. The `darwin-x64` binaries exist, so a universal or x64 build is a
  later config change, not a code change.

### 3. The GPU voice is not offered on the Mac

XTTS-v2 runs on CUDA (ADR 5), and a Mac has no NVIDIA GPU. The Voices dialog already lists the
GPU voice only when its Python environment exists. `npm run gpu-voice` stops on macOS with a
message, instead of building a 5 GB environment that cannot use a GPU. Apple's own GPU (MPS) is
not evaluated. That would be a new ADR 5 measurement.

### 4. The Mac's conventions

- **Opening a PDF from Finder.** On macOS a file opened with "Open With", by a double click or
  dropped on the Dock icon arrives as the `open-file` event, often before the window exists, and
  never in `process.argv`. The main process keeps that path and hands it to `pdf:initial`, or
  opens it in the window that is already there.
- **The menu.** `autoHideMenuBar` does nothing on macOS, where the menu bar is always shown. The
  app menu gets File, Open… (Cmd+O), the standard Edit items (Cmd+C for copying text) and
  Window. The zoom items stay off, for the reason given in `createWindow`.
- **Closing the last window keeps the app running.** That is how Mac apps behave. Clicking the
  Dock icon opens a window again (`activate`). Cmd+Q quits. The place is written when the window
  closes, as now.

### 5. Phone sync on the Mac (ADR 7 and 8)

- The phone server listens on TCP 47613 and announces itself by UDP multicast, as on Windows.
  macOS needs no firewall rule for that, because its application firewall is off by default.
  When the owner has turned it on, macOS asks once whether the app may accept incoming
  connections.
- **macOS 15 and later ask for "Local Network" access** before an app may send multicast or
  reach devices on the local network. The packaged app declares `NSLocalNetworkUsageDescription`
  in its `Info.plist` with a sentence saying why. In development the app runs as Electron's own
  binary, so the prompt names "Electron".
- The Mac is a new desktop to the phone. It has a new certificate, a new `deviceId` and its own
  pairing. Nothing is copied from the Windows PC. A library prepared there is prepared again
  here, or reaches the Mac through the store (ADR 8).
- An ad-hoc signature changes with every build. The Keychain may then ask again before the app
  can read its stored tokens, and the macOS firewall may forget its permission. Both are a click
  each, and both go away with a Developer ID.

## Consequences

- The Windows build is unchanged. Each Mac branch in `src/main/` is covered by the e2e run on
  the Mac (MAC2, MAC3). The Windows e2e can only be run when the owner is at the PC again.
- `docs/WORKFLOW.md` lists the Mac's setup next to the Windows one.
- The installed app's data lives in `~/Library/Application Support/<productName>/`. It holds the
  settings, progress, phone library, paired phones and sync settings.
- No auto-update and no CI, as on Windows (ADR 6).

## The owner's choices

Recommended first:

1. **Signing:** ad-hoc (free, one "Open Anyway" for a downloaded copy), or a Developer ID with
   notarisation (99 USD a year, no warning). _Recommended: ad-hoc._ It is enough for the owner's
   own Mac and a few testers.
2. **Architectures:** arm64 only, or universal (arm64 and Intel, about twice the app's code but
   the same models). _Recommended: arm64 only_ until someone with an Intel Mac asks.
3. **Closing the last window:** the app keeps running (the Mac's convention), or it quits as on
   Windows. _Recommended: keeps running._
4. **Models in the `.dmg`:** bundled, about 700 MB as on Windows, or a small `.dmg` with the
   models fetched from the command line. _Recommended: bundled._ It keeps ADR 6's rule that a
   fresh install reads aloud at once and makes no download.

## Measured on the M1 (MAC2, 2026-10-22)

The MacBook Air M1 (4 fast and 4 efficiency cores, 16 GB), **in Low Power Mode**, on mains power.
One eight-second sentence per model, with the app's own settings. Each was run four times; the
first run is shown separately from the mean of the other three. ADR 2 measured the same thing on
the Ryzen 7 3700X.

| Model                 | Load   | Time per second of audio, first / then | Ryzen (ADR 2) |
| --------------------- | ------ | -------------------------------------- | ------------- |
| Kokoro v1.0 (English) | 1.1 s  | 0.77 / 0.70                            | 0.32          |
| Piper Thorsten high   | 0.75 s | 0.51 / 0.53                            | 0.31          |
| Supertonic 3 (German) | 0.6 s  | 0.54 / 0.56                            | 0.27 to 0.32  |

- All three are faster than real time, so reading keeps up. Kokoro is the closest to the limit,
  with less margin than on the PC.
- Kokoro by thread count: 2 threads 0.82, 3 threads 0.70, **4 threads 0.64**, 6 threads 0.64,
  8 threads 0.66. The app's rule (half the cores, at least 2 and at most 8) gives 4 here, which is
  the best, so it stays.
- The e2e suite passes: 27 tests, the GPU voice's test skipped. Preparing the fixture for the
  phone (17 sentences) takes 53 s, against about 25 s on the PC.
- Two tests depended on the PC's 1920 x 1080 screen. The window of a 1440 x 900 Mac is 75 px
  shorter, so focus mode's first check now zooms the page out. PDF.js caps a page canvas at three
  times the screen's area, so whole-page ink at double zoom cannot be measured on this screen.
  The alignment test then checks the first zoom only and says so; there every word was within
  0.083 of the font height. `reader.spec.ts` runs at one pixel per point
  (`--force-device-scale-factor=1`), as on the PC.
- `tests/fixtures/sample.pdf` is now committed. Made on the Mac, it breaks "Sprachsyn-these" over
  two lines, and the phone's golden files need the Windows bytes.

## Not verified

- The speeds without Low Power Mode, which should be faster.
- That the multicast announcement reaches the phone from the Mac on the owner's Wi-Fi, and when
  macOS shows the Local Network prompt. Checked in MAC4.
- That electron-builder's ad-hoc signature covers the unpacked `.dylib` files so that the
  packaged app loads them. Checked in MAC5.
