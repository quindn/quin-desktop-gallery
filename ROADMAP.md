# Roadmap

Phases as specified (project brief §34). All six phases now have a working
implementation; remaining gaps within each are called out explicitly below
rather than left implicit.

## Phase 1 — Foundation ✅

Tauri 2 shell, dark title bar, root folder sandbox (`fs_sandbox`, unit-
tested), Recent Roots/Change Root/Rescan/Open in Explorer, SQLite schema,
scanner (initial + incremental + live filesystem watching), virtualized
gallery grid, folder tree with recursive counts (empty folders never shown).

## Phase 2 — Metadata & Query ✅

FFmpeg/FFprobe bundled as Tauri sidecars, layered duration strategy
(format → stream → frame-count deep scan — MediaInfo/raw-pts stages from
the original spec aren't implemented; FFprobe alone covers the vast
majority of real files), background metadata queue with post-scan sweep,
"Needs Deep Scan"/"Metadata Errors" smart collections with retry. Full
filter/search query layer: filename/path search, duration/size/date
ranges with presets, favorites, rating, metadata state, tags — all combine
with AND logic. Photo EXIF (camera, capture date, GPS, orientation) and
dimensions read inline during scan.

## Phase 3 — Viewing ✅

Photo viewer (zoom/pan/fit/100%/rotate, prev/next, EXIF panel). Video
player: native WebView2 playback first, on-demand FFmpeg remux/transcode
fallback for incompatible codecs, cached and served via the asset
protocol. **Note**: converts the whole file up front rather than
streaming a live transcode with Range support — simpler, but a slow
transcode blocks playback start on very large incompatible files.
Thumbnails: background priority queue (on-demand jumps ahead of the
post-scan warm-up sweep), photo + video (FFmpeg frame grab, proportional
seek past black openings), disk-cached, delivered to the frontend via
events rather than blocking IPC.

## Phase 4 — LAN ✅

Axum server (off by default), reusing the same query layer and
`fs_sandbox` guard as the desktop app. Random per-session token auth,
optional IP allowlist, View/Download permission levels, QR code, a
lightweight bespoke web UI (not the full React app — that relies on Tauri
IPC a browser doesn't have) with HTTP Range-based video streaming.
Verified end-to-end: auth rejection, thumbnail serving, full and
range-partial video streaming, download gating, and clean shutdown.
**Not implemented**: Edit-over-LAN (View + Download only) and per-session
idle expiry (a token is valid for the server's whole lifetime; stopping
the server revokes it).

## Phase 5 — Editing ✅

Non-destructive video editor: trim/cut (lossless stream-copy when nothing
else requires re-encoding, forced re-encode via "Accurate Cut"),
rotate/flip, crop via aspect-ratio presets, resize, mute, speed change
(with correct source-timeline trimming even combined with speed — see
below), basic brightness/contrast/saturation, format conversion (MP4/
WebM), quality presets, cancellable job with live progress. Always
exports to a new file by default; "Replace Original" is an explicit
opt-in that still writes to a temp file first and atomically renames over
the original. Extract Frame and Extract Audio as one-shot actions.

Region-based watermark/object removal: static rectangles (drawn on the
video preview) with Blur/Pixelate/Cover modes, optional time range,
multiple regions per export, built as an FFmpeg `filter_complex` graph.
**Not implemented**: moving-region tracking, polygon regions, edge-aware
inpainting, and AI-based removal (the spec itself marks tracking and AI
removal as optional).

A real bug was caught and fixed during manual FFmpeg verification: when
trim was combined with a speed change, `-t` was being interpreted as an
*output*-side duration (post-speed) rather than the intended *source*
range, so a 5-second trim at 1.5× speed silently read closer to 7 seconds
of source. Fixed by moving both `-ss` and `-t` to input-side options.

## Phase 6 — Library maturity & polish — mostly done

- ✅ Dashboard, Settings (cache stats + clear — no General/Playback/
  Performance/Keyboard sections), Grid/Dense/List/Timeline view modes,
  context menu with batch operations, tags (schema + full CRUD UI in the
  viewer's info panel + sidebar tag filtering)
- ✅ Duplicate finder: exact content-hash groups and same-size candidates
  (not perceptual image similarity or approximate video similarity — both
  are "optional" in the spec and need real feature-comparison work this
  pass doesn't cover), side-by-side review, delete-only-on-request
- ✅ Timeline view: groups by day using capture date (falling back to file
  dates), virtualized alongside the regular grid rows
- ⬜ Configurable keyboard shortcuts (the fixed set from spec §29 works;
  no remapping UI), 100k+ file performance validated only by design
  (virtualization, indexes, bounded queues) — not load-tested at that
  scale in this session
- ⬜ Windows installer + portable build — in progress as of this doc's
  last edit; see the session's final summary for the actual artifact
  location once packaging completes

## Ongoing across all phases

- Crash safety (§30): temp-file + atomic rename for every scan/thumbnail/
  playback-cache/edit-job write; startup sweep of abandoned `*.tmp*` files
  across all three cache directories
- Privacy (§31): no telemetry, no analytics, nothing leaves the machine
  unless LAN mode is explicitly on
- Local diagnostic logs (§32): not implemented — errors surface in the UI
  and in the OS-level console/log during development, but there's no
  in-app log file or Open Logs/Clear Logs action yet
- Testing per §35: unit tests (sandbox, thumbnail pipeline, editor command
  construction — 10 total); extensive manual end-to-end verification this
  session covering scan/metadata/thumbnails against real generated media,
  the full LAN HTTP surface via curl (auth, Range, permissions), and the
  editor/watermark-removal FFmpeg command construction against a real
  video file (which is what caught the trim+speed bug above)
