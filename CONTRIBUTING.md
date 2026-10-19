# Contributing to Maverick

Thanks for helping. This file covers running Maverick from source, how it is put together, and the tests. Bug reports and pull requests are welcome on GitHub.

## Run from source

You need Windows 10 2004 or later (Windows 11 for the Mica window), Node.js 22 or later, and for local models [Ollama](https://ollama.com).

```
npm install                 # installs Electron and PDF.js
npm start                   # the desktop app: main window, the bar, global hotkeys, tray
node serve.mjs              # browser version: then open http://localhost:5174 in Chrome or Edge
node test/selfcheck.mjs     # offline checks, no network
```

For the default local setup, pull the models first:

```
ollama pull gemma4:12b        # live answers, vision and transcription
ollama pull embeddinggemma    # Library search
ollama pull qwen3.8:27b       # optional: the Reasoning role (Think harder, the notes)
```

Any other connection works too: add it in Settings, Connections, and pick it per role in Settings, Models.

Page and bar warnings and errors print in the terminal that ran `npm start`.

## Build the installers

```
npm run dist
```

electron-builder writes `release/Maverick-Setup-<version>.exe` (NSIS, per user), `release/Maverick-<version>-portable.exe` and the unpacked app in `release/win-unpacked/`. Only the files listed under `build.files` in package.json are packed; `desktop/app-audio.exe` is unpacked from the asar archive so Windows can run it.

publik API self-test of a built app (see https://publikhq.com/skills/setup.md):

```
PUBLIK_SELF_TEST=1 release/win-unpacked/Maverick.exe
```

It prints one line, `publik self-test: ok ...` or `publik self-test: failed: <why>`, and exits. A build without `publik-app-token.txt` fails with "This build has no publik API app token", which is expected for forks.

## Architecture

```
desktop/main.cjs       Electron: runs serve.mjs in-process, main window, the bar, hotkeys, tray, capture without a picker
desktop/preload.cjs    the page's only bridge to the shell (window.maverick)
desktop/publik.cjs     publik API: disclosure, provisioning, credential file, self-test (port of publikhq.com/sdk/publik.ts.md)
desktop/app-audio/     Rust source of app-audio.exe: one app's sound by its window (Windows process loopback)
desktop/icon.*         app and tray icon
serve.mjs              static allowlist, token, CSP, /bridge/claude, /bridge/cli, /bridge/allowed, /bridge/publik/v1/*
maverick.config.json   CLI bridge commands and their arguments (edit by hand)
index.html, styles.css layout, dialogs, the bar and pop-out template, icons
bar.css                the desktop bar window only
src/app.mjs            UI, capture, endpointing, transcription queue, actions, bar and pop-out, history, settings
src/audio.mjs          pure: RMS, silence gate, voice-activity endpointing, downsampler, WAV, base64
src/prompts.mjs        pure: prompts, clock, transcript cleaner, echo check, long-meeting split, subtitles
src/canary.mjs         pure: the pattern in the bar and the pixel test behind the share-protection badge
src/providers.mjs      one streamChat() for every provider; request builders and stream parsers; server allowlists
src/meetings.mjs       pure: history search, Markdown export, action items, history cap, storage migration
src/library.mjs        pure: Sources; chunks, keyword and meaning search, grounded prompt, citation check, .docx reader
src/libstore.mjs       the Library: IndexedDB, reading files (PDF.js, the Vision role for pictures), embeddings
src/homework.mjs       Homework: worksheet split, prompts, export; src/formfill.mjs reads and fills a form window
src/memory.mjs         Memory: Markdown notes with [[links]], the graph
src/recording.mjs      session recording: file names, folder, WebM duration
extension/             optional Chrome extension for the browser version's global shortcuts
```

Audio path: screen and system audio or mic, then an AudioWorklet (mono PCM), voice-activity endpointing, the silence gate, 16 kHz WAV chunks, one serial queue, the transcription role, the cleaner and echo check, and a labeled transcript line.

### Model roles and connections

Each task has a role in Settings, Models: Live answers, Reasoning, Vision, Transcription and Web. A role picks one connection and a model. Settings refuse a role its connection cannot do: Vision needs images, Transcription needs audio, and only Claude Code searches the web.

| Type | Audio | Where it runs | Needs |
|---|---|---|---|
| Ollama | yes | this PC | Ollama running and the models pulled |
| OpenAI-compatible | yes, if the model takes `input_audio` | OpenAI, OpenRouter, Groq, LM Studio, vLLM, llama.cpp and other presets | base URL, key (blank for local servers), models |
| Anthropic API | no | api.anthropic.com, straight from the page | API key |
| Google Gemini | yes | generativelanguage.googleapis.com | API key |
| publik API | yes, through `/audio/transcriptions` | publikhq.com, through the local server's proxy | the user's yes to the disclosure on first run (or in its Settings card) |
| Local CLI agent (Claude Code) | no | the `claude` CLI on this PC, through the local server | the CLI installed and signed in |
| CLI agent | no | an allowed agent CLI on PATH, through the local server | a command listed in `maverick.config.json` |

### publik API

`desktop/publik.cjs` follows the publik contract (https://publikhq.com/developers, https://publikhq.com/skills/api.md, AGENTS.md):

- The user's own connections are never changed. publik is used only when the user picks it, or says yes to the first-run offer, which appears only when Ollama is unreachable and no other connection was added.
- `provision()` runs in the main process after the yes (`POST /installs`) and writes the `pk_` key to `%LOCALAPPDATA%\publik\apps\maverick.json`. The page gets only the card: balance line, cost sentence, sign-in or add-credit link.
- The page calls `/bridge/publik/v1/<endpoint>` on the local server, which adds the key (from `PUBLIK_API_KEY` or the credential file) and forwards to the publik base URL. Only `chat/completions`, `audio/transcriptions`, `embeddings`, `models` and `wallet` are forwarded, only to https://publikhq.com, and the usual bridge token is required. Responses, SSE included, stream back with their status and `x-publik-*` headers.
- The credential file is untrusted: a key that is not a `pk_` string is ignored, and URLs other than https on publikhq.com are dropped.
- A 402 shows `error.message` and one link, `error.top_up_url`.
- The app token is read from `PUBLIK_APP_TOKEN` or a `publik-app-token.txt` next to the module or in a parent folder; packaged builds ship it in `resources/` when it exists at build time.
- `PUBLIK_TEST_BASE_URL` points every publik call at a local mock for `test/publik-proof.mjs`. It is ignored unless its host is 127.0.0.1.

## Security of the local server

`serve.mjs` can start CLI programs and holds the publik key, so it is locked down. It listens on 127.0.0.1 only and rejects other Host headers (DNS rebinding) and other Origins. `/bridge/*` needs a random token created on each start and embedded only in the page it serves. Only index.html, styles.css, bar.css, icon.svg, src/ and the two PDF.js files are served; paths with backslashes, `..`, colons or dot segments are 404. The CLI bridge runs only commands from `maverick.config.json` with their configured arguments, refuses any `args` from the page, and never passes prompt text through a shell. The Claude Code bridge runs read-only in a temporary folder that is deleted after each request. Stop, a closed page or the 3 minute limit kill the whole process tree by PID. Pages get a Content Security Policy, and all model output is HTML-escaped.

The desktop app loads the same page from the same server, in-process, on a random 127.0.0.1 port. The page reaches the shell only through `desktop/preload.cjs` (context isolated, sandboxed), and the shell checks every message.

## Screen-share protection

The main window, the bar and the tray menu use Windows content protection (`WDA_EXCLUDEFROMCAPTURE`, Windows 10 2004 or later), on by default, with a switch in Settings, Desktop app. A badge reports whether a real capture of the screen contains the bar, so the setting is verified rather than assumed. On older Windows a protected window shows as a black box.

## Environment variables

| Variable | Effect |
|---|---|
| `MAVERICK_USER_DATA=<folder>` | run the desktop app on a separate profile (settings, meetings, bar position) |
| `MAVERICK_CAPTURE_VISIBLE=1` | let screen captures see the windows for one run, without changing the saved setting |
| `MAVERICK_TEST_HOOKS=1` | test hooks used by the proofs |
| `MAVERICK_BAR=acrylic` | the acrylic bar material instead of the capsule |
| `PUBLIK_API_KEY`, `PUBLIK_API_BASE_URL` | publik key and base URL override (the base URL must be https on publikhq.com) |
| `PUBLIK_APP_TOKEN` | publik app token override |
| `PUBLIK_SELF_TEST=1` | print the publik self-test line and exit |

## Tests

Run them one at a time; the desktop proofs start the real app on a temporary profile and leave the real profile untouched. Screenshots and logs go to `shots/` (git-ignored, created on demand).

```
node test/selfcheck.mjs            # offline, no network, no model
node test/publik-proof.mjs         # no network: a mock publik API; proxy, key, SSE, 402, transcription, credential file, self-test
node test/bridge-kill.mjs          # Windows; a real server on port 5199: CLI arguments refused, Stop and timeout kill the tree
node test/fit-proof.mjs            # Windows 11, no model: the header and the bar fit at 100, 125 and 150 % scaling
node test/memory-proof.mjs         # needs Ollama, gemma4:12b and embeddinggemma; Memory notes and graph in the desktop app
node test/live-transcribe.mjs      # needs Ollama; Windows speech to WAV to the live model
node test/live-providers.mjs       # needs Ollama and a signed-in claude CLI
node test/models-proof.mjs         # needs Ollama with gemma4:12b; per-task models in the desktop app
node test/feature-proof.mjs        # needs Ollama with gemma4:12b; subtitles, Solve and the share-protection badge
node test/sources-proof.mjs        # needs Ollama, gemma4:12b and embeddinggemma; the Library and Sources; Web needs the claude CLI
node test/glass-proof.mjs --quick  # Windows 11; screenshots and measurements of the glass design
node test/wer.mjs                  # needs Ollama; word error rate on generated speech, written to shots/transcription-wer.md
```

The other proofs in `test/` (screen reads, copilot, homework, acceptance, accuracy, stt-gate) need Ollama with `gemma4:12b`, and some `embeddinggemma`; `test/recording-proof.mjs` needs `ffprobe` on PATH. Each file's first lines say what it needs. `test/desktop-proof.mjs` sends one real key chord with SendKeys to a harness window, so leave the keyboard alone while it runs.

## Style

Plain JavaScript modules, no build step, no framework. Pure logic lives in `src/*.mjs` files that `test/selfcheck.mjs` imports directly; keep new logic there with a check next to it. UI copy is short, plain English.
