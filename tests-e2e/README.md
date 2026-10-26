# End-to-end tests

They launch the real app (its own temporary data folder, never your `data/`) and drive it through
the DevTools protocol, plus real OS mouse input where a test needs it (dragging files out).

```
powershell -File tests-e2e/run_all.ps1            # against the release build
powershell -File tests-e2e/run_all.ps1 <exe>      # any build
```

- `e2e_lock.mjs` — the lock screen: choosing a password on a fresh install, hash-only storage,
  wrong passwords refused, changing it in Settings.
- `e2e_features.mjs` — drag files out, Ctrl+C / Ctrl+A, keeping the place across filters and the
  viewer, video streaming / seeking / resume, cutting ranges and one file per part.
- `e2e_timeline.mjs` — the editor's timeline, typed times, parts, preview, export.
- `e2e_watch.mjs` — live folder watching, restoring after a broken app db, rebuilding after a crash.
- `e2e_viewer_studio.mjs` — the viewer's favorite key, resume on / off, Next / Previous across pages,
  "This folder"; the Studio (clips, split, reorder, undo, typed trim, transition, text, music,
  export); AI Enhance from the viewer (downloads RIFE / Real-ESRGAN, needs internet and a Vulkan GPU).
- `e2e_search.mjs` — the search box: words in any order, no accents, -exclude, OR, wildcards,
  Explorer filters (kind:, size:, duration:, res:, date:, folder:), completions, folder
  suggestions, searching inside a folder, opening a suggested file, recents, Ctrl+F / Esc.
- `bench_seek.mjs` — seek latency of a big 1080p file.

The AI pipeline also has a Rust test that downloads the tools and checks every mode frame by frame:
`cargo test --lib ai::tests::real -- --ignored --nocapture` (in `src-tauri/`).

The drag test moves the real mouse: leave the computer alone while it runs.

Every run uses its own temporary data folder; the harness chooses (and later types) the lock
password `TEST_PASSWORD` from `qg_harness.mjs` there — the real password is never in the repo.
