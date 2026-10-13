# 1. Electron, PDF.js and TypeScript

Date: 2026-10-13

## Context

The app must render PDFs well, run speech models locally, read and write files next to the PDF,
and work on Windows 11. The machine has Node 26, no Rust, and only a 32-bit Python 3.15, which
cannot run any machine learning runtime.

## Decision

An Electron app in TypeScript. PDF.js renders the pages through its ready-made viewer component.
The interface is plain TypeScript and DOM without a UI framework. electron-vite builds it.

## Why

- PDF.js gives rendering, lazy page loading, zoom, links and a selectable text layer. That text
  layer is what makes word highlighting possible at all.
- Electron's main process is Node, so the speech runtime loads as a native module in the same
  app. No second process, no local server, no Python.
- The interface is one toolbar, one sidebar and one dialog. A framework would add more code than
  it saves at this size.

## Considered

- **Tauri.** Smaller app, but needs Rust installed and the speech runtime would have to be wired
  through Rust.
- **A local web app with a Python server.** Opens the door to more speech models, but needs a
  64-bit Python and a second process to manage.

## Consequences

- The installer will be large, around 150 MB before models.
- Revisit the framework choice if the interface grows beyond a few panels.
- Speech models that only exist for Python, such as Chatterbox, need a separate helper process.
