# 7. Phone sync over the local network

Date: 2026-10-21

Status: **Accepted** by the owner on 2026-10-21, with the rule change below and these choices: the
certificate is made by our own code (section 6), and for now the phone has no voice of its own and
plays only prepared audio (section 3). Nothing is built yet. The phone's side is in the Flutter
repository's ADR 2.

## Context

The phone app (`../pdfreader_flutter`) runs Piper fast enough to read live. Kokoro does not: it needs
0.84 to 0.91 seconds per second of audio on the owner's Galaxy S20 FE (Flutter ADR 1), and the
phone gets slower as it warms. The desktop renders Kokoro at 0.32 (ADR 2) and XTTS-v2 at 0.47 on the
GPU (ADR 5), and it can do so for a whole document in the background.

The owner wants three things. The desktop prepares a document's audio. The phone fetches it together
with the PDF. Both devices know where the reader stopped, so reading continues on the other one.

The owner chose how: phone and desktop on the same network, accepting each other once. Wi-Fi Direct
and Bluetooth were brainstorming and are dropped. A server on the owner's TrueNAS may come later,
so the files below are plain files a server could hold unchanged.

**The offline rule.** "No network calls at runtime" existed to keep speech local: no cloud voices,
no external models or LLMs. Talking to the user's own paired phone on the local network does not
touch that, so the rule in `CLAUDE.md` now says so.

## Decision

### 1. What is synced

For each document: the PDF, the audio of every sentence, its word timings, and each device's place.

Notes are not synced yet. The phone has no marks until its M2. When it does, `notes.json` joins the
library with a merge rule decided then.

_Decided by the owner on 2026-10-21:_ notes are merged **per mark**. Marks from both devices are
kept by their id. When both edited the same mark, the newer edit wins. A deleted mark stays
deleted, so a deletion is kept as a tombstone until both sides have it. The general notes take the
newer text. Built as step S9 here and step 5.7 on the phone, after the phone's marks (its M2).

### 2. The phone library

The desktop keeps the documents it prepared in `userData/phone-library/`, one folder per document:

```
<docId>/
  document.pdf         a copy, so the library does not depend on where the file was
  manifest.json        name, page count, voices, render version, sentence count, total bytes
  pages/<page>.json    the page's sentences: key, audio file, language, duration, word timings
  audio/<key>.opus     one file per distinct sentence
  state/<device>.json  where that device stopped
```

`docId` is the SHA-256 of the PDF's bytes, in hex. The same file has the same id on both devices,
wherever it lies and whatever the path or URI is.

`pages/<page>.json` describes the page's words and its sentences in reading order:

```json
{
  "wordCount": 728,
  "wordsHash": "9c1e…",
  "sentences": [
    {
      "key": "3f9a…",
      "lang": "en",
      "ms": 4210,
      "from": 120,
      "words": [
        [0, 310],
        [310, 720]
      ]
    }
  ]
}
```

A page's **words** are the word-like segments (`isWordLike` in the segmenter) of all its spoken
sentences, in order, after NFKC. `wordsHash` is their SHA-256, joined by single spaces. A sentence
covers the words from `from` onwards, one for each entry of `words`. Each entry is that word's start
and end time in milliseconds.

### 3. The phone takes the desktop's sentence breaks, by word index

The phone's raw string comes from PDFium and the desktop's from PDF.js. Offsets from the desktop
would be a second coordinate system on the phone, so they are never sent.

The first idea was to match each phone sentence to a desktop sentence by its text. The spike
(Flutter ADR 2, "Measured") found that only 92.6 % of a real paper's sentences match that way. The
cause: the two engines detect headings differently, so sentences break in different places near
headings, captions, tables and lists. The words themselves were identical, all 4,953 of them, page
for page. So the shared ground is the page's word sequence, not its sentences.

- **When a page's words agree.** The phone computes its own words for the page, as above, from its
  own raw string. If their count and hash equal the index's, the phone reads the page with the
  desktop's sentences: sentence _n_ is the phone's words `from` to `from + words.length - 1`. Its
  raw range runs from the first word's start to the last word's end in the phone's own raw string.
  Highlights, marks and search stay in the phone's coordinates; the word index only links the two.
  The audio and the word timings fit exactly, because they are the desktop's own sentence.
- **When they do not agree**, which the spike never saw, that page falls back to matching sentences
  by text. The **sync key** is the sentence text after NFKC with runs of whitespace collapsed to one
  space, hashed with SHA-256, first 40 hex digits. A phone sentence with no match is skipped. The
  owner turned the phone's own voice off for now, so nothing could speak it, and the document shows
  how many sentences it skips.
- The word segmentation, the normalisation and the hash are the same in `src/shared/` and
  `lib/shared/`, with the same test cases.

The place carries the sentence's key beside its index for the same reason (section 8).

### 4. Audio

- Rendered at speed 1.0. The phone changes the speed when it plays, keeping the pitch, so changing
  the speed does not need new audio. That also means speed is not part of what is prepared.
- **Ogg Opus**, mono, about 24 kbit/s: roughly 11 MB per hour of speech. Raw 16-bit audio would be
  about 170 MB per hour.
- The prepare job runs in the renderer, like the pre-render, because it needs PDF.js for the
  sentences, so the samples are already there. They are resampled to 48 kHz with an
  `OfflineAudioContext` (Opus accepts no 22.05 kHz input, Piper's rate), encoded with WebCodecs'
  `AudioEncoder` (Chromium in Electron 44), and packed into Ogg pages by `src/shared/ogg.ts`
  (headers, granule positions, CRC). No new dependency.
- `// shortcut: iOS's player does not play Ogg. When the iOS port starts, choose CAF/Opus or AAC.`

### 5. Finding each other

The desktop listens only while **Phone sync** is switched on. It is off by default.

- While on, the desktop announces itself every two seconds by UDP multicast on the local network:
  app name, protocol version, computer name, port. The phone lists what it hears. LocalSend works
  the same way.
- The address can also be typed, for networks that block multicast (guest Wi-Fi, some mesh routers).
- Node's `dgram` and `https`, Dart's `RawDatagramSocket` and `HttpClient`. No packages for this.
- The first time, Windows asks whether to let the app through the firewall. Allow it for private
  networks only.

### 6. Pairing and trust

The desktop makes a self-signed TLS certificate once and keeps it in `userData`. Its SHA-256
fingerprint is the desktop's identity, as a Syncthing device ID is.

1. The Phone sync dialog shows a 12-character code: the first 60 bits of the fingerprint in
   Crockford base32, for example `K7QD-3MXA-9PWR`.
2. On the phone, the user picks the desktop from the list and types the code. The phone connects and
   checks that the certificate's fingerprint starts with that code. If it does not, the phone stops.
   If it does, the phone knows it is talking to that desktop and pins the whole fingerprint.
3. The phone sends its name and a random device id. The desktop asks "Pair with Galaxy S20 FE?".
   On Accept it returns a random 32-byte token and keeps only the token's hash. Pairing requests are
   answered only while the dialog is open, one at a time.
4. Every later request needs both the pinned certificate and the token. The dialog lists the paired
   phones, each with a Remove button.

Why 60 bits: to pass as the desktop, an attacker on the network needs a certificate whose fingerprint
shares those 60 bits, about 10^18 key generations. A 6-digit code compared on both screens would be
cheap to beat by generating keys. A QR code that carries the whole fingerprint can come later. It
needs a camera package on the phone.

**Making the certificate.** Node can read X.509 certificates but cannot create them. So a small DER
writer of our own builds an ECDSA P-256 certificate and signs it with `node:crypto`. The DER encoding
is pure logic in `src/shared/`, and the signing is passed in. That is about 80 lines, and a unit test
checks the result with Node's `X509Certificate` and `checkPrivateKey`. The owner chose this over the
`selfsigned` package (MIT, which pulls in `node-forge`), so there is no new dependency.

### 7. Protocol

HTTP/1.1 over TLS, JSON for data and plain bytes for files. The phone always asks and the desktop
answers. The desktop never connects to the phone. That is simpler, because Android stops background
apps.

| Request                           | Token | Answer                                                      |
| --------------------------------- | ----- | ----------------------------------------------------------- |
| `GET /v1/hello`                   | no    | name, protocol version                                      |
| `POST /v1/pair`                   | no    | the token, after Accept; refused when the dialog is shut    |
| `GET /v1/library`                 | yes   | every document: id, name, pages, prepared share, updated    |
| `GET /v1/doc/<id>/<file>`         | yes   | a file of section 2: the PDF, the manifest, an index, audio |
| `GET /v1/doc/<id>/state`          | yes   | every device's state for that document                      |
| `PUT /v1/doc/<id>/state/<device>` | yes   | stores the asking device's own state                        |

The main process validates every request, as it does with the renderer's.

- Ids and keys must match fixed hex patterns. File paths are built from them only, never taken
  from the request.
- A state body may be at most 4 KB and is parsed the same way `normalizeProgress` parses progress.
- A device may write only its own state file.
- Anything else is answered with 404.

The phone downloads only what it lacks: it compares the manifest and the indexes, then fetches the
missing audio over one kept-alive connection.

### 8. The place

Each device writes only its own `state/<device>.json`, so two devices never write the same file and
nothing has to be merged:

```json
{
  "device": "…",
  "name": "Galaxy S20 FE",
  "updated": 1792500000000,
  "page": 34,
  "offset": 0.2,
  "sentence": { "page": 34, "index": 5, "key": "3f9a…" }
}
```

When a document opens, the newest state wins, whichever device wrote it. If that state comes from
another device, the app offers "Continue where you stopped on Galaxy S20 FE, page 34?". The sentence
is found by its key first and by its index second.

On the desktop, opening a file hashes it, so the desktop knows the `docId` and whether the library
holds it.

`// shortcut: "newest" compares the two devices' clocks. Upgrade if a wrong pick is ever seen.`

## Consequences

- The main process has a network listener for the first time. It is off by default, local only, and
  serves paired phones only.
- `userData` grows by about 11 MB per hour of prepared audio. The dialog can remove a document from
  the library.
- On a prepared page the phone reads and tints sentences where the desktop breaks them, which can
  differ from where its own layout would break them near headings. Only on a page whose words
  differ is a sentence skipped.
- The phone reads only documents the desktop prepared. A PDF opened on the phone alone shows and can
  be marked, but it is not read aloud.
- The phone needs Android's `INTERNET` permission, which covers local sockets too (Flutter ADR 2).

## Not chosen

- **Wi-Fi Direct and Bluetooth.** Brainstorming only, dropped by the owner.
- **The desktop pushing to the phone.** The phone app is often in the background or stopped.
  Letting the phone ask is simpler.
- **Sending the desktop's sentence offsets to the phone.** That would be a second coordinate system.
- **WebDAV, Syncthing or a TrueNAS container.** These are for the later server step. The library is
  plain files, so a WebDAV share can hold the same folder.

## Not verified

- That a real German paper, with hyphens across lines, gives the same words on both engines. The
  spike covered one English paper and the German and English `sample.pdf`, and it compared words
  split at spaces, not the segmenter's word-like segments.
- ~~That the Opus files play on the phone.~~ _Played on the owner's Galaxy S20 FE on 2026-10-21,
  heard by the owner in the system player and by ExoPlayer in the phone app (Flutter PLAN 1.9 to
  1.13)._ _Measured on the desktop in step S3, 2026-10-21_
  (`tests/e2e/opus.spec.ts`): WebCodecs in Electron 44 encodes at about 0.01 seconds per second of
  audio, with a reported pre-skip of 312, at 24.6 to 24.9 kbit/s for the Kokoro and Piper samples.
  Both the 24 kHz and the 22.05 kHz voice were resampled with `OfflineAudioContext`. Chromium's
  decoder and libsndfile 1.2.2 (libogg and libopus) both read the files at the exact length.
- ~~That the owner's router passes multicast between Wi-Fi and the desktop's network port.~~
  _Measured 2026-10-21:_ the S20 FE heard the desktop's announcement 2.2 s after it began listening.
- _Built in S5, 2026-10-21:_ TLS on port 47613, announcements to the administratively scoped group
  239.255.47.13 on the same port. On Windows, one socket that switches its multicast interface sent
  every packet out of one adapter (a Hyper-V adapter beside the Wi-Fi), so the desktop keeps one
  socket bound to each address. A listener must join the group on its interface by address: a
  membership on the default interface heard nothing. The owner's network is marked Public in
  Windows, and the firewall rule Windows made for Electron allows it there; ADR 7 meant private
  networks only.
