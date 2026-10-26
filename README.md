# Quin Desktop Gallery

**English** · [Tiếng Việt](README.vi.md) · Download the latest build: [Releases](https://github.com/quindn/quin-desktop-gallery/releases/latest)

A Windows app for a **local photo and video library**. It also includes:

- a video player and video editor;
- a **CapCut-style Studio**;
- **AI frame interpolation and sharpening**;
- an ad-blocking browser that finds and downloads the videos on a page;
- a link player for YouTube, TikTok, m3u8 and more;
- LAN sharing.

It is built with **Tauri 2 (Rust) + React/TypeScript + SQLite**. A release is **one exe**: FFmpeg, FFprobe, yt-dlp and uBlock Origin are packed inside it and unpacked on first launch. **All data lives in the `data\` folder next to the exe**, so copying that folder moves the whole app.

> This document is for people (and later AI sessions) who need to **change or extend** the app. Working rules for AI assistants are in [`AGENTS.md`](AGENTS.md); Claude Code loads it through [`CLAUDE.md`](CLAUDE.md).

At run time the app is called **Quin Gallery** (`productName` in `tauri.conf.json`). The project and repo are called **Quin Desktop Gallery**.

---

## Contents

1. [Features](#1-features)
2. [Tech stack](#2-tech-stack)
3. [Setup and running](#3-setup-and-running)
4. [Release builds](#4-release-builds)
5. [Folder layout](#5-folder-layout)
6. [Architecture](#6-architecture)
7. [The `data\` folder](#7-the-data-folder)
8. [Testing](#8-testing)
9. [How to add and change things](#9-how-to-add-and-change-things)
10. [Gotchas already paid for](#10-gotchas-already-paid-for)
11. [Other design documents](#11-other-design-documents)
12. [Third-party software and licences](#12-third-party-software-and-licences)

---

## 1. Features

### Library

- **One library folder.** You pick a folder (the Gallery Root) and only what is inside it gets indexed.
- **Browsing:**
  - virtualised Grid / Dense / List / Timeline views;
  - paging with jump-to-page;
  - a folder tree with its own search;
  - tags, favourites, star ratings and a duplicate finder.
- **Sorting** by name, dates, size, duration, and *Similar Names* (files named alike sit together, in natural number order).
- **Keeps your place.** Changing the folder, a filter, Favorites, the sort or the page size, or closing the viewer, lands on the page that holds the selected file. If that file dropped out, it lands on its nearest neighbour instead of going back to page 1.
- **Live folder watching:**
  - Adds, renames, moves and deletes show up within about 0.3–0.5 s.
  - Only the changed file is read.
  - Files still being copied are indexed once complete.
  - Changes made while the app was closed are caught by a catch-up walk.
- **Files out:** drag files out of the app (onto the web, chats, Explorer), Ctrl+C copies the files themselves, Ctrl+A selects the page.
- **Fast start.** On a 102k-file library the main page shows about 0.6 s after unlocking.
- **Crash recovery:**
  - After a crash the app reopens the last library from `data\roots\`.
  - A corrupt database is rebuilt; the broken file is kept as `*.corrupt-<time>`.
- **Lock screen** with a password the owner chooses:
  - It is set on first launch and changed in Settings → Lock password.
  - Only a salted PBKDF2-SHA256 hash is stored, in `data\lock.json`. **No password is in the code.**
  - Deleting `lock.json` resets it to "choose a password".
  - The app locks on launch and whenever it is hidden to the tray.

### Windows 11 Explorer–style search

The logic is in `src-tauri/src/db/search.rs` and the UI in `src/components/SearchBox.tsx`.

- **Words** match in any order, in file names and folder names, and **accents are optional** (`dang` finds "Đặng").
- **Operators:** `"exact words"`, `-exclude`, `a OR b`, and the wildcards `*` and `?` (`IMG_*.jpg`, `*.mov`).
- **Filters:**

  | Group | Syntax |
  |---|---|
  | Kind, extension | `kind:video`, `ext:mp4,mov` |
  | Size | `size:>100mb`, `size:1gb..4gb`, `size:large` |
  | Dates | `date:thisweek`, `date:2024-05`, `date:17/5/2025`, `created:`, `taken:` |
  | Video | `duration:>10m`, `duration:long`, `res:4k`, `res:>=1080p`, `width:` / `height:` |
  | Marks | `is:fav`, `is:portrait`, `rating:>=3`, `tag:` |
  | Scope | `name:`, `folder:` |

- **Drop-down:**
  - chips showing how the text was understood, plus the total number of results;
  - matching files with thumbnails and highlighted matches (click, or ↓ + Enter, opens one);
  - matching folders;
  - Tab completes a filter;
  - recent searches and quick filters; `?` opens the cheat sheet.
- **Folder scope:** while a folder is open the search stays inside it (an "in <folder> ✕" pill).
- **Keys:** Ctrl+F, Ctrl+E or F3 jump to the box. Esc closes the drop-down, then clears the search.
- **Speed:** a stored `media.search_key` column holds the folded path, so a search over 100k files takes about 20–40 ms.

### Viewer

- **Playback:** videos stream from a built-in HTTP server with byte ranges, so seeking is quick and file size doesn't matter. The custom player has a seek bar with buffered ranges and a hover time, speed, loop, PiP and full screen.
- **Keys:**
  - ← / → **only ever seek**, even while the video is loading;
  - ↑ / ↓ / PageUp / PageDown change file, continuing onto the next or previous page.
- **Quick favourite key:** Enter by default; change it in Settings → Playback.
- **Resuming:** Settings → "Reopening a video" chooses between resuming where you left off and always starting from the beginning.
- **This folder** shows only the files from the current file's folder.
- **AI ✦** opens AI Enhance.

### Video editor (inside the viewer)

- **Timeline:** a frame strip, and typed times everywhere ("1:23.5", "83.5", "1m23s").
- **Parts:** keep several parts (Split, Delete, Add part), cut out or keep only a range (`[` `]` `X`), and export the parts as separate files.
- **Cut mode:** Fast Cut (no re-encode) or Accurate Cut (frame-exact).
- **Adjustments:** free crop, rotate/flip, resize, speed, colour, mute, watermark removal and ping-pong. All of it sits in one panel with one Export.

### Studio — CapCut-style editor

The UI is `src/components/Studio.tsx` and the renderer `src-tauri/src/editor/studio.rs`.

- **Opening it:** sidebar → "Studio (video editor)", or right-click a file → "Add to Studio".
- **Timeline:** tracks for video/photo, text and music. Drag to reorder, drag edges to trim, type times, Split (S), Delete, Duplicate (Ctrl+D), Undo/Redo (Ctrl+Z / Ctrl+Y).
- **Per clip:** speed, volume, mute, Fit/Fill, brightness, contrast and saturation. There are 14 transitions (xfade).
- **Text and music:**
  - Text is placed by dragging it on the preview, with size, colour and a dark box.
  - Music has a start, a length, a volume and fade in/out.
- **Output settings:** 16:9, 9:16, 1:1, 4:3 and 3:4; 720p to 4K; 24–60 fps.
- **Saving and export:** projects auto-save as JSON in `data\projects\`. Export writes `<library>\Quin Studio\<name>.mp4` (H.264 + AAC).

### AI Enhance

The code is in `src-tauri/src/ai.rs`.

- **Smoother motion:** RIFE 4.26 (Best) or 4.6 (Faster) makes real in-between frames, at ×2, ×3 or ×4 fps.
- **Sharper picture:** Real-ESRGAN, with the General x4 v3 model for real footage or animevideov3 x2 for anime. Same size or 2× bigger (up to 4K).
- **Downloads:** the tools are ncnn/Vulkan GPU builds, **downloaded on first use** into `data\bin\ai\`. Only the needed files are pulled out of the release zips, with HTTP range requests.
- **Processing:**
  - The video goes through in chunks of PNG frames in a temp folder, so disk use stays small.
  - Then one FFmpeg encode keeps the original sound.
  - The result is a new file next to the original: `<name> (60 fps).mp4`, `<name> (AI 2x).mp4`.

### Online

- **Open a Link:**
  - direct files, HLS `.m3u8`, DASH `.mpd`, RTMP/RTSP, and about 1800 sites through yt-dlp;
  - quality picker and audio-only;
  - downloads with progress and verification.
- **Browser** (WebView2 / Chromium engine):
  - tabs, bookmarks, history, separate profiles (Profile Manager) and private tabs;
  - uBlock Origin built in, plus Chrome Web Store extensions;
  - video capture: a network sniffer plus an agent in every frame, a media pop-up to download what a page offers, and a "Quin Player" overlay on the site's own player.
- **LAN Sharing:** a local web server with a QR code, to browse the library from a phone.

> There is no Google Photos integration. It was decided **not** to use Google Photos' private or unofficial web APIs (session cookies). If it is ever added, it must use the official **Google Photos Picker API** with the owner's own OAuth Client ID.

---

## 2. Tech stack

| Part | Technology |
|---|---|
| Desktop shell | Tauri **2.11.5** (WebView2), Rust stable (1.98 in use), MSVC toolchain |
| UI | React 19, TypeScript 6, Vite 8, Tailwind CSS 4, zustand 5, @tanstack/react-virtual |
| Database | SQLite via `rusqlite` (bundled, custom `qg_fold` SQL function), `r2d2` pool, WAL |
| Folder watching | `notify` 7 + `notify-debouncer-full` |
| Local server | `axum` 0.7 on 127.0.0.1 (file streaming `/f/<token>`, proxy `/p`, FFmpeg pipe `/s`) |
| Media | FFmpeg / FFprobe n9.0 (BtbN GPL build), yt-dlp, the `image` crate |
| AI | rife-ncnn-vulkan (TNTwise fork, 2025-01-12), realesrgan-ncnn-vulkan v0.2.5.0 |
| Lock | PBKDF2-HMAC-SHA256 (`pbkdf2` + `sha2`) |
| Drag / clipboard | the `drag` crate (OLE DoDragDrop), Win32 CF_HDROP (`windows` 0.61) |

---

## 3. Setup and running

### Requirements

- Windows 10 or 11 with the **WebView2 Runtime** (preinstalled almost everywhere).
- **Node.js 18+** (24 in use), **Rust stable** with the MSVC toolchain, and the **Visual Studio Build Tools** with the *Desktop development with C++* workload. See [Tauri's prerequisites](https://tauri.app/start/prerequisites/).
- Git. GitHub Desktop is optional.

### Steps

```powershell
git clone https://github.com/quindn/quin-desktop-gallery.git
cd quin-desktop-gallery
npm install

# FFmpeg, FFprobe and yt-dlp into src-tauri\bin\ (~350 MB, not in git)
powershell -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1
#   (or in Git Bash: bash scripts/fetch-ffmpeg.sh)

npm run tauri dev          # dev build with hot reload for the UI
```

- uBlock Origin (`src-tauri/resources/ublock-origin.zip`) **is in git**.
- Without the files in `src-tauri\bin\` the app still builds, but at run time it looks for the tools on PATH.
- The first build takes a few minutes because `build.rs` compresses ~350 MB of tools. The result is cached in `src-tauri/.packed/`.
- On first launch the app asks for a new lock-screen password, which is stored hashed in `data\lock.json`.

---

## 4. Release builds

```powershell
npx tauri build                # exe + NSIS installer + MSI
#   src-tauri\target\release\quin-gallery.exe                                     ← portable (one file)
#   src-tauri\target\release\bundle\nsis\Quin Gallery_1.0.0_x64-setup.exe          ← installer
npx tauri build --no-bundle    # just the exe (faster)
powershell -File scripts/make-portable.ps1   # copies the exe as "Quin Gallery.exe"
```

A release build takes about 10–15 minutes; optimising the main crate is the slow part.

**Publishing to GitHub Releases** (needs `gh` signed in):

```powershell
Copy-Item src-tauri\target\release\quin-gallery.exe "$env:TEMP\Quin-Gallery-<version>-portable.exe"
gh release create v<version> "$env:TEMP\Quin-Gallery-<version>-portable.exe" "src-tauri\target\release\bundle\nsis\Quin Gallery_<version>_x64-setup.exe" --title "Quin Desktop Gallery <version>" --notes "…"
```

The version is in three places that must change together: `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.

**On the owner's machine** the build is also copied over `Desktop\Quin Gallery\Quin Gallery.exe` (keeping that folder's `data\`), and the installer goes to `Desktop\Quin-Gallery-1.0.0-setup.exe`.

---

## 5. Folder layout

```
quin-desktop-gallery/
├─ README.md (English), README.vi.md (Tiếng Việt)
├─ AGENTS.md, CLAUDE.md              ← rules for AI assistants (CLAUDE.md imports AGENTS.md)
├─ ARCHITECTURE.md, DATABASE_SCHEMA.md, MEDIA_PIPELINE.md, VIDEO_PLAYBACK.md,
│  LAN_SERVER.md, UI_SPEC.md, ROADMAP.md   ← original design docs (code refers to their § sections)
├─ index.html, vite.config.ts, tsconfig*.json, package.json
├─ public/logo.png
├─ scripts/
│  ├─ fetch-tools.ps1 / fetch-ffmpeg.sh   ← download FFmpeg / FFprobe / yt-dlp into src-tauri/bin
│  ├─ make-portable.ps1                   ← copy the exe as "Quin Gallery.exe"
│  └─ make-backdrops.py                   ← window backdrop images
├─ src/                                 ← FRONT END (React)
│  ├─ App.tsx                            ← app shell: lock screen, onboarding, view routing
│  ├─ components/
│  │  ├─ Sidebar.tsx, Toolbar.tsx, SearchBox.tsx, FilterPanel.tsx, SettingsPanel.tsx
│  │  ├─ GalleryGrid.tsx                 ← grid / paging / keeping your place / opening the viewer / keys
│  │  ├─ MediaCard.tsx, ListRow.tsx, ListHeader.tsx, ContextMenu.tsx
│  │  ├─ Viewer.tsx, VideoPlayer.tsx     ← photo / video viewer
│  │  ├─ EditorPanel.tsx, EditorTimeline.tsx, CropOverlay.tsx   ← video editor
│  │  ├─ Studio.tsx                      ← Studio (CapCut-style)
│  │  ├─ EnhanceDialog.tsx               ← AI Enhance
│  │  ├─ BrowserView.tsx, BrowserPanels.tsx, ProfileManager.tsx, NewTabPage.tsx
│  │  ├─ OnlineView.tsx, DownloadsView.tsx, LanPanel.tsx, DuplicateFinderPanel.tsx
│  │  └─ Dashboard.tsx, LockScreen.tsx, Onboarding.tsx, TitleBar.tsx, RainOverlay.tsx
│  ├─ lib/
│  │  ├─ api.ts                          ← invoke() wrappers for Rust commands + shared types
│  │  ├─ studio.ts, ai.ts, online.ts     ← Studio / AI / Online types + wrappers
│  │  └─ timecode.ts, format.ts, seek.ts, fileDrag.ts, clipboard.ts
│  └─ stores/                            ← zustand: galleryStore (view, folder, filters, query),
│                                          settingsStore (localStorage "qpg.*"), thumbnailStore, rootStore,
│                                          lockStore, themeStore, webStores (browser / downloads)
├─ src-tauri/                           ← BACK END (Rust)
│  ├─ Cargo.toml, tauri.conf.json, build.rs (packs + embeds the tools), icons/, resources/ublock-origin.zip
│  ├─ bin/        (NOT in git)           ← ffmpeg / ffprobe / yt-dlp as "<tool>-x86_64-pc-windows-msvc.exe"
│  └─ src/
│     ├─ lib.rs                          ← app setup, state, tray, REGISTERS EVERY COMMAND (generate_handler!)
│     ├─ paths.rs                        ← the data\ folder (QG_DATA_DIR overrides it)
│     ├─ tools.rs                        ← unpacks the embedded FFmpeg / yt-dlp into data\bin\<build-id>\
│     ├─ state.rs, startup.rs            ← AppState; crash marker (.running), temp cleanup
│     ├─ commands/                       ← Tauri commands the UI calls, by area:
│     │   root, media, actions, files_out, editor, studio, ai, playback, settings, tags,
│     │   duplicates, lan, online, browser, lock (password → data\lock.json)
│     ├─ db/
│     │   mod.rs (pool, migrations, open_with_repair), library.rs, app.rs,
│     │   queries.rs (MediaQuery → SQL, paging, positions), search.rs (search language),
│     │   name_key.rs (Similar Names), migrations/*.sql
│     ├─ scanner/ (mod.rs scanning, watcher.rs watching), metadata/ (ffprobe, queue),
│     │   thumbnails/ (thumbnail queue), duplicates/, transcode/
│     ├─ editor/  mod.rs, job.rs, pipeline.rs, runner.rs (runs FFmpeg, progress, cancel),
│     │           studio.rs (builds the Studio's FFmpeg command), watermark.rs, inpaint.rs
│     ├─ ai.rs                           ← AI tool download + RIFE / Real-ESRGAN pipeline
│     ├─ online/  server.rs (local HTTP server), resolve.rs (yt-dlp), download.rs
│     ├─ browser/ embedded browser: profiles, extensions, sniffer, agent*.js injected into pages
│     ├─ lan/     LAN server + web page
│     └─ fs_sandbox/  blocks access outside the library root
└─ tests-e2e/                           ← end-to-end tests that drive the real app (section 8)
```

---

## 6. Architecture

```
 Photo/video folder ──► scanner (first scan / catch-up) ──┐
        │                                                ├──► SQLite library.db (data\roots\<id>\)
        └──► watcher (notify, one change at a time) ─────┘          │
                                                                    │  queries.rs / search.rs
 metadata queue (ffprobe) ─► updates columns, emits "metadata://ready" │
 thumbnail queue ─► data\thumbcache\, emits thumbnail events        ▼
                                                    commands/*.rs  (#[tauri::command])
                                                                    │  invoke()
                                                                    ▼
                                         React: stores (zustand) ◄─► components
 Video: axum server on 127.0.0.1 (/f/<token> with Range) ──► <video> in Viewer / Studio
 Editor / Studio / AI: build an FFmpeg command (+ AI tool) ─► background job ─► "edit://progress", "edit://done"
```

- **Commands:** one command is one Rust function with `#[tauri::command]`.
  - It is registered in `src-tauri/src/lib.rs` and called from `src/lib/*.ts` through `invoke("command_name", { args })`.
  - Tauri maps camelCase arguments to snake_case.
  - Returned structs either use `#[serde(rename_all = "camelCase")]` or get mapped in `api.ts` (`mapMediaItem`, `queryToRaw`).
- **Library queries:** the UI builds a `MediaQuery` with `galleryStore.buildQuery()`. In Rust, `queries::build_where()` turns it into SQL, and the search box goes through `search::compile()`.
- **Long jobs** (export, AI):
  - They return a `jobId` straight away and run on a background thread.
  - They emit `edit://progress` / `edit://done`.
  - They stop on `cancel_edit_job` (the `AppState.edit_jobs` registry).
- **Local video** does not use `asset://`, which fails on large files. Use `get_media_stream_url(id)`, which returns `http://127.0.0.1:<port>/f/<token>`.

---

## 7. The `data\` folder

Everything sits next to the exe (`paths.rs`). The app only falls back to `%LOCALAPPDATA%` when that folder isn't writable. The `QG_DATA_DIR` environment variable moves it; the tests rely on this.

| Path | Contents |
|---|---|
| `data\app.db` | recent libraries, global settings |
| `data\lock.json` | lock-screen password hash (PBKDF2-SHA256, salt, 100k iterations) |
| `data\roots\<id>\library.db` | one index per library. Each records its own root path, so the app can recover even without `app.db` |
| `data\thumbcache\`, `data\playcache\` | thumbnails, transcoded playback copies |
| `data\bin\<build-id>\` | FFmpeg / FFprobe / yt-dlp / extensions unpacked from the exe. Old builds are removed automatically |
| `data\bin\ai\` | RIFE / Real-ESRGAN, downloaded on first use (**kept** across app updates) |
| `data\projects\` | Studio projects (`<id>.json`) |
| `data\exports\`, `data\edit_temp\` | exports when no library is open; editor / AI temp files |
| `data\webview\` | the main window's WebView data |
| `data\browser\` | browser profiles, extensions, bookmarks, history |
| `data\crash.log` | log of panics |

UI preferences (seek step, favourite key, resume, page size, rain effect…) live in the WebView's `localStorage` under `qpg.*` keys (`src/stores/settingsStore.ts`).

---

## 8. Testing

### Rust (unit + integration)

```powershell
cd src-tauri
cargo test --lib                                   # ~135 tests, about a minute
cargo test --lib db::search                        # the search language (includes a 100k-row speed test)
cargo test --release --lib db::search::tests::fast -- --nocapture
cargo test --lib ai::tests::real -- --ignored --nocapture   # downloads the real AI tools and runs every mode (needs internet + a Vulkan GPU)
```

The editor tests use the real FFmpeg in `src-tauri/bin` and skip themselves when it is missing.

### End-to-end (drives the real app over the DevTools Protocol)

Details are in [`tests-e2e/README.md`](tests-e2e/README.md). Every suite uses its own temporary data folder and never touches your real `data\`.

```powershell
npx tauri build --debug --no-bundle               # or use the release build
powershell -File tests-e2e/run_all.ps1            # release build
powershell -File tests-e2e/run_all.ps1 src-tauri\target\debug\quin-gallery.exe
node tests-e2e/e2e_search.mjs <exe> <screenshotDir>   # one suite
```

| Suite | What it covers |
|---|---|
| `e2e_lock` (11) | choosing the first password, hash-only storage, wrong passwords refused, changing it in Settings |
| `e2e_features` (26) | dragging files out, Ctrl+C/A, keeping your place, video streaming / seeking / resume, range cuts |
| `e2e_timeline` (25) | editor timeline, typed times, parts, preview, export |
| `e2e_watch` (17) | folder watching, restoring a broken database, rebuilding after a crash |
| `e2e_viewer_studio` (39) | favourite key, resume on/off, Next across pages, "This folder", Studio, AI Enhance |
| `e2e_search` (29) | the whole search box |

- The drag test **moves the real mouse** (`os_input.ps1`), so leave the machine alone while it runs. It reports SKIP when the desktop is locked.
- `qg_harness.mjs` provides:
  - `spawnApp`, which sets or types the test password `TEST_PASSWORD = "qg-e2e-pass"` on the temporary data folder;
  - `openRoot`, `waitScanned`, `clickText`;
  - `main.key` / `click` / `drag` / `typeText` / `shot`;
  - `invoke`, `probe`, `makeVideo`.

---

## 9. How to add and change things

### A new backend command

1. Write the function in `src-tauri/src/commands/<area>.rs`:
   ```rust
   #[tauri::command(async)]
   pub fn my_command(state: State<AppState>, id: i64) -> Result<MyResult, String> { ... }
   ```
   Use `(async)` for slow synchronous work; `async fn` commands take `State<'_, AppState>`.
2. For a new area, add `pub mod <area>;` to `commands/mod.rs`.
3. **Register** it in `src-tauri/src/lib.rs` → `tauri::generate_handler![ ..., commands::<area>::my_command ]`.
4. Add a wrapper in `src/lib/api.ts` (or its own lib file): `export const myCommand = (id: number) => invoke<MyResult>("my_command", { id });`
5. Check with `npx tsc --noEmit` and `cd src-tauri && cargo build`.

### A column or table in the library database

- **Adding a column:** add `("column_name", "TYPE")` to the `required` list in `db/library.rs::repair_legacy_media_columns`. This is safe for old databases and needs no migration.
- **Bigger changes** (tables, indexes): create `db/migrations/library_000N_<name>.sql` and append it to `LIBRARY_MIGRATIONS` in `db/mod.rs`. **Only append; never edit an old file.**
- **Watch out:** a brand-new database creates `media` from `library_0001_init.sql` *after* the column repair. Anything that must exist immediately goes in the init file too, or is checked with `pragma_table_info` the way `search::prepare_schema` does it.
- Update `DATABASE_SCHEMA.md`.

### A search filter or syntax

1. In `src-tauri/src/db/search.rs` → `field_cond()`, add a branch `"field" => ...` that returns `Cond { sql, params, label, kind }`. Add the name to `KNOWN` so bad values are reported as "not understood".
2. Add a case to the `explorer_filters` test (it has an in-memory database), then run `cargo test --lib db::search`.
3. Add suggestions to `FIELDS` (and `HELP` / `QUICK` if useful) in `src/components/SearchBox.tsx`.
4. Add a step to `tests-e2e/e2e_search.mjs`.

### A setting

In `src/stores/settingsStore.ts`, add a `qpg.<name>` key, a value loaded with `loadBool` / `loadNumber` / `loadString`, and a setter that writes `localStorage`. Put the control in `src/components/SettingsPanel.tsx` with a `data-testid` for the tests.

### A new sidebar view

1. Add the value to `MainView` in `src/stores/galleryStore.ts`.
2. Add a `<Row>` in `src/components/Sidebar.tsx`.
3. Add the branch in `src/App.tsx`.

### A context-menu item

Edit `src/components/ContextMenu.tsx`. Grid-related actions come in as props from `GalleryGrid.tsx`, for example `onShowFolder` and `onCopyFiles`.

### Studio

- **Types must match on both sides:** `src-tauri/src/editor/studio.rs` (serde camelCase) and `src/lib/studio.ts`.
- So must the length rules (`clipLen`, `transitionMs`, `layout`) and the renderer's `build()`.
- A new effect is an FFmpeg filter in `build()` plus a matching CSS preview in `Studio.tsx`.

### AI

- Models and download sources are in `files_for()` in `ai.rs`.
- The pipeline is `run()`: decode to RGB, then PNG chunks, the tool, read back the PNGs, and the encoder.
- The real test is `ai::tests::real` (section 8).

### The workflow for every change

1. Write a checklist of what needs doing.
2. Fix everything on it.
3. Run `npx tsc --noEmit` and `cargo test --lib`.
4. Build debug and run the relevant e2e suites. Add an e2e check for anything new.
5. Repeat only what failed.
6. Build release and run `run_all.ps1` against it.
7. Deliver or publish (section 4).

---

## 10. Gotchas already paid for

- **Remote machine:** the owner's machine is used over Parsec (~32 Hz). **Measure** "lag" before optimising; last time it was the rain effect, not the exe size.
- **`tools.rs` cleanup:** it removes old build folders in `data\bin\`, but **only folders named with 12 hex characters**, so `data\bin\ai` survives.
- **FFmpeg n9:**
  - `-vsync` is **gone**; use `-fps_mode`.
  - `drawtext` needs `expansion=none` (text containing `%` breaks otherwise), and `textfile=` for Unicode text.
- **RIFE:**
  - **Don't rename model folders**; the exe infers the architecture from the name.
  - Exit codes are unreliable, so **always count the output frames**.
  - Input frame j comes out exactly as output frame (j−1)·m+1, which is how chunks join seamlessly.
- **Real-ESRGAN:** `-s` must match the model's native scale. There is no CPU mode.
- **GitHub downloads:** GitHub's file servers **reject suffix ranges** (`bytes=-N`). Ask for `bytes=0-0` first to learn the size.
- **Query field names:** `MediaQuery` fields from the UI go through `queryToRaw()` (snake_case). When a test calls `invoke("get_media_page")` directly, use snake_case.
- **Virtual grid:** the grid is a **virtual list**, so off-screen cards aren't in the DOM. Tests must scroll to them.
- **Timing in tests:**
  - When a test presses Play and then reads the time, note the playhead **before** pressing.
  - The viewer's `usePlaybackMemory` applies its own start position, so tests seek only after the video is ready plus ~1.5 s.

---

## 11. Other design documents

- [`ARCHITECTURE.md`](ARCHITECTURE.md): the original overall architecture.
- [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md): tables, columns, indexes.
- [`MEDIA_PIPELINE.md`](MEDIA_PIPELINE.md): scanning, metadata, thumbnails, queues.
- [`VIDEO_PLAYBACK.md`](VIDEO_PLAYBACK.md): playback and the transcoding fallback.
- [`LAN_SERVER.md`](LAN_SERVER.md): LAN sharing.
- [`UI_SPEC.md`](UI_SPEC.md): UI specification (the code refers to its § sections).
- [`ROADMAP.md`](ROADMAP.md): roadmap.
- [`tests-e2e/README.md`](tests-e2e/README.md): end-to-end tests.
- [`AGENTS.md`](AGENTS.md): rules for AI assistants.

## 12. Third-party software and licences

| Component | Licence | Notes |
|---|---|---|
| FFmpeg (GPL build with libx264) | GPL | embedded in the exe |
| yt-dlp | Unlicense | needs updating now and then (Downloads → Update yt-dlp) |
| uBlock Origin | GPLv3 | embedded in the exe |
| rife-ncnn-vulkan | MIT | downloaded on first use, with its LICENSE |
| Real-ESRGAN | BSD-3-Clause | downloaded on first use, with its LICENSE |
| Window backdrops | Pexels licence | Pexels 10615070 / 1477537 |

Check these licences before redistributing.
