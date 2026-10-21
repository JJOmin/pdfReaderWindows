# 8. Sync through the user's own Nextcloud or Dropbox

Date: 2026-10-21

Status: **Accepted** by the owner on 2026-10-21 for Nextcloud and Dropbox. The desktop's side is built
(step S7 in SPEC.md). The phone's side is not: the Flutter repository needs its own ADR and the
reading side of everything below. Nothing here replaces ADR 7; it adds a second way to the same
library.

## Context

ADR 7 syncs only while the phone and the desktop are on the same network. The owner wants it to work
anywhere, free, with no server of the owner's to keep running, and with the user choosing the service.
Syncthing and Tailscale need a second app. A server with accounts is what the owner does not want.

What travels is small state (the place, under 1 KB) and one-time bulk (the PDF and about 11 MB of
audio per hour of speech). A file store holds both, and ADR 7 already made the library plain files.

## Decision

### 1. A store knows files and nothing else

`SyncStore` in `src/shared/sync-store.ts` has three calls: `list(dir)`, `get(path)`, `put(path, bytes)`.
No logic runs on the other side, no connection stays open, and the apps ask only when a document is
prepared or the user presses Sync now. Paths are built from hashes and numbers only and checked by
`assertPath` before they reach any service.

| Service   | How                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nextcloud | WebDAV in the folder `PDF Reader`. Sign-in by Login Flow v2: an app password the user can revoke. Any WebDAV server would also work; only Nextcloud's sign-in is built. |
| Dropbox   | HTTP API v2, in the app's own folder (access type "App folder"). OAuth with PKCE and a refresh token, no secret in the app.                                             |

Not built: OneDrive, iCloud (Apple has no public API an Android phone could use; revisit with an iOS
port), a user-supplied WebDAV login.

### 2. Everything in the store is encrypted

Each file is `PRS1`, a random 12-byte IV and AES-256-GCM, with the file's path as authenticated data,
so the provider can neither read a file nor give it back under another name. The key is 32 random
bytes made on first use and shown as 64 hex digits. The user enters the same key on every device
(a QR code can carry it later). It is kept with the sign-in secrets, encrypted by the operating system
through Electron's `safeStorage`. A file that fails to open counts as "unreadable" in the report, and
a document whose manifest the key cannot open is sent again.

File names are not encrypted: `<docId>` (a hash) and page numbers. The document's name is in the
manifest, which is.

### 3. The library in the store

Same as ADR 7 section 2, except that audio is packed per page, because Dropbox and WebDAV pay a
request for every file and a paper has thousands of sentences:

```
<docId>/document.pdf
<docId>/manifest.json
<docId>/pages/<page>.json       the page index of ADR 7, unchanged
<docId>/audio/<page>.pack       the page's distinct sentences, in index order
<docId>/state/<device>.json     where that device stopped, unchanged
```

All of them sealed as in section 2. A pack is a 4-byte big-endian length, that many bytes of JSON
`[[key, byteLength], ...]`, then the Ogg Opus files one after the other. A sentence that two pages
share is in both packs. The local library keeps its file per sentence; the pack is made on upload.

The manifest is sent last, and a manifest in the store with the same `updated` as the local one means
the document is whole and nothing is sent again.
`// shortcut: an upload that stops halfway starts again from the PDF, upgrade by listing what is there.`

The document's notes are one more file, `<docId>/notes.json`, sealed like the others (added
2026-10-21 with the phone's half, its ADR 3 and step S8b). A sync reads it, merges it per mark with
the library's own (ADR 7 section 1), and writes the merge to whichever side lacks it. No logic runs
in the store, so two devices that write at the same moment can lose one update, which the next sync
merges again. A notes file that this key cannot open counts as "unreadable" and is left alone.

### 4. Places

Unchanged from ADR 7 section 8: each device writes only its own `state/<device>.json`. A sync sends
this computer's file and writes the others' into the local `state/` folder, which S6 reads. A file is
accepted only if its `device` is the name it carries. Nothing is merged, so any store works. Since
S6 (2026-10-21) the desktop writes its own state for prepared documents, under the same `deviceId`.

### 5. Signing in

- **Nextcloud.** `POST <server>/index.php/login/v2`, open the returned `login` address in the system
  browser, poll the returned endpoint until the user approves. Both addresses must be on the server
  the user typed. The server address is https, or plain http for localhost, `.local` and private
  addresses only, because a home server often has no certificate.
- **Dropbox.** Authorization code with PKCE in the system browser, back to a listener on
  `127.0.0.1:53682` that lives for the sign-in only and checks `state`. Dropbox only returns to
  addresses registered in advance, so the port is fixed. The app key is public by design.
  It is read from `PDFREADER_DROPBOX_KEY` at run time; **the owner must register the app** (App
  folder, scopes `files.content.read` and `files.content.write`, redirect `http://127.0.0.1:53682/`)
  and put its key into `DROPBOX_APP_KEY` before a release. Without one the button is disabled.
- Secrets (app password, refresh token, sync key) go into `sync.json` as one string made by
  `safeStorage`. Signing out forgets the sign-in and keeps the key, so signing in again finds the
  same files. The files in the store are not deleted.

### 6. The rules

`CLAUDE.md` said the only network use was phone sync on the local network. It now also allows the
user's own configured Nextcloud or Dropbox, only after the user signed in, and only for these
encrypted files. The renderer has no network access of its own: sign-in and transfer run in the main
process, and the renderer only asks through `Api`.

## Consequences

- Sync works anywhere both devices can reach the service, and neither device has to be on at the
  same time. Nothing of the owner's runs.
- A Dropbox free account has 2 GB; prepared audio is about 11 MB an hour. Nextcloud has whatever the
  server has.
- Dropbox apps start in development status, limited to 50 users until Dropbox approves them.
- Losing the sync key makes the store unreadable. The dialog says so.
- The phone has to implement sections 2, 3 and 5 (and its own Dropbox registration or the same key)
  before this does anything for it. Until then only the desktop's half is tested, against stand-ins
  for the services.

## Not verified

- Against a real Nextcloud and a real Dropbox account. The unit tests run the real adapters against
  in-memory stand-ins written from the services' documentation, so they prove the adapters agree with
  that reading, not with the services. Both sign-ins need one run by hand.
- That Dropbox accepts `127.0.0.1` with a registered port as a redirect address for an App folder app.
- That the owner's Nextcloud allows files this size through its web server's upload limit.
