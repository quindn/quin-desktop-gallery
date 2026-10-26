# AGENTS.md — rules for AI assistants working on this repo

This file is for any coding assistant (Claude Code, Codex, Cursor, Copilot…). Claude Code loads it through `CLAUDE.md`.

**Quin Desktop Gallery** (the app is called "Quin Gallery") is a Windows media gallery, video editor, CapCut-style Studio, AI video enhancer and ad-blocking browser, built with Tauri 2, Rust, React/TS and SQLite.

**Read [`README.md`](README.md) first** (Vietnamese: [`README.vi.md`](README.vi.md)). It has:
- the features and the folder map;
- the architecture and the `data\` layout;
- the test suites;
- step-by-step recipes for a new command, a DB column, a search filter, a setting, a sidebar view, Studio and AI work.

Keep **both READMEs** in step when you change something they describe.

## The owner

- GitHub: **quindn**. Repo: `quindn/quin-desktop-gallery` (public).
- Writes **Vietnamese**: reply in Vietnamese.
- App UI text, code comments and commit messages are **English**.
- Wants the work built and tested in one go ("làm và test luôn"), then an honest report: what passed, what failed, what was skipped.

## Standing rules

1. **Workflow:** checklist → fix everything → test everything → repeat only what failed.
   - Every change ends with:
     - `npx tsc --noEmit`
     - `cargo test --lib` (in `src-tauri/`)
     - the relevant e2e suites in `tests-e2e/`
   - Every new feature gets an e2e check.
2. **Portable data:** app data, browser profiles and downloaded tools all go in `data\` next to the exe (`src-tauri/src/paths.rs`; `QG_DATA_DIR` overrides it).
   - Never write to `%LOCALAPPDATA%` or `%APPDATA%`.
   - Anything new under `data\bin\` must survive `tools.rs`'s cleanup, which deletes only 12-hex-character build folders.
3. **Measure before optimising.** The owner uses the machine over Parsec (~32 Hz). A past "lag" was the rain animation, not the exe size.
4. **Keep test code in the repo.** e2e suites live in `tests-e2e/`, not in a temporary scratch folder.
5. **No secrets in the repo** (it is public).
   - The lock-screen password is chosen by the user and stored only as a salted PBKDF2 hash in `data\lock.json` (`src-tauri/src/commands/lock.rs`). Never hard-code a password.
   - The e2e harness uses `TEST_PASSWORD = "qg-e2e-pass"` on its own temporary data folder.
   - Don't commit `data\`, tokens, cookies, or screenshots of the owner's screen or library.
6. **Google Photos:** don't build anything on Google Photos' private or unofficial web APIs or session cookies. The only acceptable route is the official Picker API with the owner's own OAuth Client ID.
7. **Large binaries stay out of git.** FFmpeg, FFprobe and yt-dlp live in `src-tauri/bin/` and are fetched with `scripts/fetch-tools.ps1`. GitHub rejects files over 100 MB.

## Delivering a build

1. Make sure the app isn't running.
2. Run `npx tauri build` (≈ 10–15 min; run it in the background).
3. Run `powershell -File tests-e2e/run_all.ps1` against the release exe. All suites must pass; report a drag-test SKIP as such.
4. **Owner's machine:**
   - copy `src-tauri\target\release\quin-gallery.exe` → `C:\Users\M71\Desktop\Quin Gallery\Quin Gallery.exe` (**keep that folder's `data\`**);
   - copy `bundle\nsis\Quin Gallery_<ver>_x64-setup.exe` → `C:\Users\M71\Desktop\Quin-Gallery-<ver>-setup.exe`;
   - delete `%TEMP%\qg-*`.
5. **GitHub:**
   - commit and push to `main`;
   - for a release, bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`;
   - run `gh release create v<ver>` with the portable exe (named `Quin-Gallery-<ver>-portable.exe`) and the NSIS setup (see README §4).

## Commands

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1   # ffmpeg/ffprobe/yt-dlp → src-tauri/bin (not in git)
npm run tauri dev
npx tsc --noEmit
cd src-tauri; cargo test --lib                                     # ~135 tests
npx tauri build --debug --no-bundle                                # fast build for e2e
npx tauri build                                                    # release exe + NSIS
powershell -File tests-e2e/run_all.ps1 [exe]                       # all e2e suites (default: release exe)
node tests-e2e/<suite>.mjs <exe> <screenshotDir>                   # one suite
```

The drag-out e2e check moves the **real mouse**. It reports SKIP when the desktop is locked.

## Where things are

- **Tauri commands:** `src-tauri/src/commands/*.rs`, registered in `src-tauri/src/lib.rs` (`generate_handler!`), called from `src/lib/api.ts`, `studio.ts`, `ai.ts` and `online.ts`.
- **Library queries:** `db/queries.rs` (`MediaQuery` → SQL).
  - Search language: `db/search.rs` (`compile()`, the `qg_fold` SQL function, the stored `media.search_key` column + backfill).
  - UI: `src/components/SearchBox.tsx`.
- **Grid:** `src/components/GalleryGrid.tsx` handles paging, keeping your place (`anchorRef`, `getMediaPositionFirst`), the viewer, keys, and `revealFile` from search.
- **Viewer and player:** `Viewer.tsx`, `VideoPlayer.tsx`.
  - Local video streams from the axum server in `online/server.rs` (`/f/<token>`, with Range).
  - Don't use `asset://` for video.
- **Editor:**
  - Front end: `EditorPanel.tsx`, `EditorTimeline.tsx`.
  - Back end: `editor/` (`runner.rs` runs FFmpeg, reports progress and handles cancel).
  - Studio: `Studio.tsx` + `src/lib/studio.ts` ⇄ `editor/studio.rs`. Types and length rules must match on both sides.
- **AI:** `src-tauri/src/ai.rs`.
  - Range-downloads RIFE / Real-ESRGAN into `data\bin\ai`.
  - Chunked PNG pipeline.
  - Real test: `cargo test --lib ai::tests::real -- --ignored --nocapture`.
- **Lock:** `commands/lock.rs` (`lock_status`, `verify_password`, `set_password`), `LockScreen.tsx` (create / unlock modes), and the Settings → Lock password form.
- **Long jobs:** return a `jobId`, emit `edit://progress` / `edit://done`, and stop on `cancel_edit_job`.

## Gotchas already paid for

- **FFmpeg n9:** no `-vsync` (use `-fps_mode`). `drawtext` needs `expansion=none` and `textfile=`.
- **RIFE:**
  - Keep model folder names as shipped.
  - Exit codes lie, so count the output frames.
  - Input frame j comes out exactly as output frame (j−1)·m+1, which is how chunks join seamlessly.
- **Real-ESRGAN:** `-s` must equal the model's native scale. No CPU mode.
- **GitHub release downloads** reject suffix ranges (`bytes=-N`). Ask for `bytes=0-0` to get the size first.
- **New library DBs** get the `media` table from `library_0001_init.sql` *after* the column-repair step. Columns that must exist immediately need a `pragma_table_info` check (see `search::prepare_schema`).
- **e2e:**
  - The grid is virtualised, so scroll before you look for a card.
  - `invoke("get_media_page")` from tests takes snake_case query fields.
  - The viewer applies its own resume position, so seek only after the video is ready plus ~1.5 s.
- **Windows tooling:**
  - Electron apps (GitHub Desktop) launched from a VS Code terminal inherit `ELECTRON_RUN_AS_NODE` and exit at once. Remove that variable before starting them.
  - Python heredocs in bash mangle `\\`. For text with backslashes, write the script to a file or use an editor tool.
