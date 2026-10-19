# Third-party notices

Maverick is MIT licensed (see LICENSE). The release builds include or are built from the following third-party software.
Each keeps its own license; the full texts ship with the packages named here.

## Electron and Chromium

- Electron, https://github.com/electron/electron, MIT License, Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.
- Chromium, which Electron embeds, is under a BSD-style license, and includes other open-source components under their own
  licenses. The full list ships with every build as `LICENSES.chromium.html` next to `Maverick.exe`.
- Node.js, which Electron embeds, MIT License, Copyright Node.js contributors.

## PDF.js

- pdfjs-dist (PDF.js), https://github.com/mozilla/pdf.js, Apache License 2.0, Copyright Mozilla Foundation.
  Maverick ships `pdf.min.mjs` and `pdf.worker.min.mjs` from it to read PDFs in the Library. License text:
  https://www.apache.org/licenses/LICENSE-2.0

## Rust `windows` crates (desktop/app-audio.exe)

- windows, windows-core and their companion crates (windows-implement, windows-interface, windows-link, windows-result,
  windows-strings, windows-collections, windows-future, windows-numerics), https://github.com/microsoft/windows-rs,
  dual licensed MIT OR Apache-2.0, Copyright (c) Microsoft Corporation. Compiled into `app-audio.exe`, the helper that
  records one app's sound.
