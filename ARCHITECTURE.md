# Architecture

## Overview

Quin Power Gallery is a Tauri 2 desktop application. Rust owns everything that
touches the filesystem, SQLite, FFmpeg, and the LAN server. The webview
(React + TypeScript) is a pure presentation layer that talks to Rust
exclusively through Tauri commands and events — it never touches the
filesystem or network directly.

```
┌─────────────────────────────────────────────────────────────────┐
│ WebView (React + TS + Tailwind)                                 │
│  - Gallery grid / viewer / editor UI                             │
│  - Zustand stores (root, filters, selection, scan progress)      │
│  - talks to Rust via @tauri-apps/api invoke() + listen()         │
└───────────────▲───────────────────────────────┬─────────────────┘
                 │ events (scan-progress, watch-change, ...)       │ invoke(cmd, args)
                 │                                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Tauri Core (Rust)                                                │
│  commands/      - #[tauri::command] surface, thin, validates args│
│  state.rs       - AppState: db pool, root, scan handle, http     │
│  fs_sandbox/    - path canonicalization + root-containment guard  │
│  db/            - rusqlite pool, migrations, queries              │
│  scanner/       - walkdir scan, incremental diff, fs watcher      │
│  metadata/      - ffprobe/mediainfo layered probing                │
│  thumbnails/    - image + video thumbnail generation, cache        │
│  transcode/     - ffmpeg remux/transcode/edit job runner            │
│  lan/           - Axum server, token auth, range streaming          │
└─────────────────────────────────────────────────────────────────┘
                 │
                 ▼
        Local filesystem (Gallery Root only) + SQLite + on-disk caches
```

## Process & concurrency model

- **Tokio runtime** hosts: the folder scanner, metadata probing queue,
  thumbnail generation queue, transcode/edit job queue, and (optionally) the
  Axum LAN server. Each is a bounded `mpsc` work queue consumed by a fixed
  pool of worker tasks so the UI never blocks and FFmpeg concurrency stays
  capped (see section 23 of the spec / `PERFORMANCE.md` notes in ROADMAP).
- **rusqlite** connections are pooled via `r2d2`. Writers use a single
  serialized writer connection (SQLite is single-writer); readers use the
  pool. All hot paths use prepared statements and batched transactions.
- **State** lives in `AppState` (managed by Tauri, behind `Arc<Mutex<...>>`
  / channels as appropriate), holding: the SQLite pool, the current root
  config, the active scan/watch handles, and the LAN server handle.
- All long-running work reports progress via Tauri **events**
  (`scan://progress`, `thumbnail://progress`, `job://update`, ...) rather
  than blocking command calls, so the UI stays responsive per section 23/30.

## The root folder sandbox

This is the single most security-critical subsystem — see `fs_sandbox`.

Rules enforced in one place (`src-tauri/src/fs_sandbox/mod.rs`), never
duplicated ad hoc in commands:

1. On root selection, the path is canonicalized with `dunce::canonicalize`
   (Windows-safe, avoids `\\?\` prefix surprises) and stored as the
   canonical root.
2. Every path that enters the system (scan results, command arguments,
   LAN request paths) is canonicalized and then checked with
   `Path::starts_with(root)` on the canonical form — never on the raw
   string — which defeats `..` traversal.
3. Symlinks/junctions are resolved (canonicalize follows them) and then
   re-checked against the root boundary; a symlink that resolves outside
   the root is rejected and flagged, not silently followed.
2 and 3 combined mean a symlink *inside* the root that points *outside* the
   root is inert: content is never read through it.
4. The LAN HTTP layer calls the exact same `fs_sandbox::ensure_within_root`
   guard before serving any file or stream — there is no separate,
   divergent path-safety implementation for LAN vs desktop.
5. Every DB row stores a path **relative to the root**, plus the root's own
   canonical path separately in settings. This makes the root portable
   across drive-letter changes impossible to silently mis-scope: relative
   paths only ever resolve underneath the one stored, canonicalized root.

## Directory layout (target)

```
src/                      React + TS frontend
  components/
  routes/ (if needed)
  stores/                 zustand stores
  lib/                    invoke() wrappers, formatting helpers
  styles/
src-tauri/
  src/
    main.rs
    lib.rs                app builder, plugin + state wiring
    state.rs
    fs_sandbox/
    db/
      mod.rs              pool + migrations
      queries/
    scanner/
      mod.rs              walkdir + diff
      watcher.rs           notify-debouncer-full driven fs watch
    metadata/
      probe.rs             ffprobe/mediainfo layered strategy
    thumbnails/
    transcode/
    lan/
      server.rs            axum app
      auth.rs
    commands/
      root.rs
      media.rs
      scan.rs
      ...
  capabilities/            Tauri 2 permission capability files
  icons/
docs/ (this file + siblings)
```

## Data flow: opening the app

1. `lib.rs` builds the app, loads settings (root path, last filter/sort,
   window state) from a small settings table in SQLite (or a settings.json
   next to the DB — see `DATABASE_SCHEMA.md`).
2. If a root is already configured, the frontend requests the last-known
   page of media immediately (DB read, fast) while a background
   `scan::incremental()` reconciles any changes since last exit, and the
   filesystem watcher attaches.
3. If no root is configured, the frontend shows the onboarding screen and
   calls `commands::root::pick_root_folder`.

## Why Tauri 2 over Electron

Smaller binary, no bundled Chromium/Node runtime (uses WebView2, already on
Windows 10/11), a Rust backend well-suited to FFmpeg process orchestration,
SQLite access, and an Axum LAN server sharing the same async runtime — and a
capability-based permission model that helps enforce the sandbox at the IPC
layer, not just in application logic.
