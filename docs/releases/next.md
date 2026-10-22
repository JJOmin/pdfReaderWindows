## PDF Reader, next release (draft)

The version number is the owner's to choose. Written 2026-10-22, for the first build on a Mac.

### Install on a Mac

1. Download `PDF-Reader-<version>-arm64.dmg`. It needs a Mac with Apple Silicon (M1 or newer).
2. Open it and drag **PDF Reader** into **Applications**.
3. The app is not notarised by Apple, so the first start from a download is blocked: macOS says
   it cannot check the app for malicious software. Click **Done**, open **System Settings**,
   **Privacy & Security**, scroll to "PDF Reader was blocked", and click **Open Anyway**. This is
   needed once.
4. Open a PDF with **Open** or ⌘O, by dropping it on the window, or with Finder's **Open With**.

The speech models (about 700 MB) are inside the app, so no second download is needed. The first
time phone sync is switched on, macOS may ask to let the app find devices on your local network.
Allow it, or phones cannot find this Mac.

### Install on Windows

As for 0.1.0-alpha.1: run `PDF-Reader-<version>-setup.exe`; SmartScreen warns once, **More info**,
**Run anyway**.

### New

- **macOS**, Apple Silicon. Cmd shortcuts, a File menu, and the app stays open when its window
  closes, as Mac apps do. The GPU voice stays Windows-only (it needs an NVIDIA GPU).
- **The window works at any size.** The toolbar keeps one row and puts what does not fit into a
  "⋯" menu; pages stay fitted to the width; in a narrow window the notes lie over the page.
- **Drop a PDF on the window** to open it.
- **Sync button.** "Phone" became a sync icon that shows the state: not set up, not synced,
  syncing, synced. Its tooltip says what is missing.
- **Phone sync** over Wi-Fi and through your own Nextcloud or Dropbox (ADR 7 and 8), with the
  Android app.
- The Phone dialog explains, behind an ⓘ, why a VPN usually stops Wi-Fi sync, and warns while one
  is on.
- An app icon.

### Known limits

- Not notarised (Mac) and not code-signed (Windows): each warns once, as described above.
- No auto-update.
