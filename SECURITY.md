# Security

How the desktop app protects the user's documents, and what was checked. The phone app has its own
`SECURITY.md` in `../pdfreader_flutter`; the two talk to each other, so a change to pairing or sync is
read against both.

## Reporting a problem

Open a private security advisory on the repository (Security, Report a vulnerability), or write to the
owner. Please do not post a vulnerability in a public issue.

## What the app holds and where it goes

PDFs stay where they are; notes are written next to them; the phone library, the voices' audio and the
settings are in the user's data folder. Nothing is sent anywhere except to phones the user paired, on the
local network, and to the user's own Nextcloud as encrypted files. No analytics, no cloud voices, no
downloaded code. Only the main process uses the network.

## What guards it

| Where                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The window                  | `sandbox`, `contextIsolation`, no Node, no `<webview>`, no insecure content (`createWindow`). It never navigates (`will-navigate` is refused); links open in the system browser, `http` and `https` only.                                                                                                                                                                                                                                       |
| The page's own files        | Served by the `app:` scheme, with a path check that keeps every request inside the renderer's folder; every response carries a policy: `default-src 'self'`, no objects, frames, forms or base address.                                                                                                                                                                                                                                         |
| Calls into the main process | The preload offers a fixed list of calls. Every handler checks that the call comes from the app's own page (`isTrustedOrigin`), then checks its arguments (`parseSynthRequest`, `parseDictation`, `parseMarks`, the library's own checks). Paths are never taken from the page, except a dropped file's, which only the preload can name.                                                                                                       |
| Permissions                 | The window may ask for the microphone, to speak a comment, and for nothing else (`mayUseDevice`). Electron would grant anything otherwise.                                                                                                                                                                                                                                                                                                      |
| Phones on the network       | Off until switched on. HTTPS with a certificate made on this computer, its key encrypted by the system; a phone must be paired, by the QR code (one-time secret, 128 bits) or by the user's yes, and then holds a 256-bit token of which only the hash is kept. Requests are matched against fixed patterns; a document id is 64 hexadecimal characters; bodies are capped; slow requests are cut off after 30 seconds; at most 64 connections. |
| Nextcloud                   | The sign-in is the browser's Login Flow v2, so the app never sees the password; the addresses the server names must stay on the server the user typed; HTTPS only (HTTP for a private address). The app password is kept with the system's secret storage.                                                                                                                                                                                      |
| Files in the store          | AES-256-GCM, a fresh IV each time, the file's path signed in.                                                                                                                                                                                                                                                                                                                                                                                   |
| Speech recording            | The microphone is used only while the user has pressed the button on a card; the recording stays in memory, is sent to the local recogniser and is dropped.                                                                                                                                                                                                                                                                                     |

## Checked on 2026-10-23

A review of the main process, the preload, the phone server, the sync code and the packages
(`npm audit`: no vulnerabilities). Fixed:

1. **Every permission a page asked for was granted** (Electron's default). Now the microphone only, from the
   app's own page; the geolocation and notification requests are answered "denied" (`security.spec.ts`).
2. **The main process did not check who was calling.** Every handler now checks the sender's origin.
3. **The policy lacked `object-src`, `frame-src`, `base-uri` and `form-action`.** Added.
4. **The window's safety settings were the defaults, unstated.** Now stated, so that an Electron update
   that changes a default cannot loosen them.
5. **The phone server waited five minutes for a slow request and had no limit on connections.** Cut to 30
   seconds and 64; replies say `nosniff`.

Not a problem, and why: there is no `innerHTML`, `eval` or `document.write` anywhere in the window; the
`app:` handler's path check holds against `..` and encoded forms; the phone server's routes are exact
patterns, so a path cannot leave a document's folder; a token cannot be guessed (256 bits, compared by hash);
an unauthenticated request can learn only the computer's name (`/v1/hello`).

## Open, for the owner

- **Electron fuses.** Turning off `RunAsNode` and `NODE_OPTIONS`, and requiring the app to load only from its
  archive, stops another program from using the installed app as a Node interpreter. It needs the
  `@electron/fuses` package, a new dependency, so it was not added without your word.
- **No purchased signing certificate** (ADR 9): Windows says "unknown publisher", the Mac needs a right click
  the first time, and there is no automatic update, so a fix reaches the user only by a new install.
- **While phone sync is on**, the server listens on every network the computer is on and announces the
  computer's name every two seconds on each. Switch it off on a network you do not trust; it is off by default.
- A pairing request shows the other side's name and waits for the user's yes: the name is not proof of who
  asks. The QR code is the safe way, and the one that needs no click.
- **Switch on, in the repository's settings:** branch protection for `master` (require a pull request and the
  CI's `check` job), secret scanning with push protection, and Dependabot alerts.
