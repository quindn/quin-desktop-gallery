# Media Pipeline

Covers scanning, metadata extraction (with emphasis on duration, §3 of the
spec), and thumbnail generation.

## 1. Scanning

- **Initial scan**: `walkdir` over the canonical root, skipping anything
  that canonicalizes outside the root (junction/symlink escape, §1).
  Runs on a Tokio blocking task; streams batches of rows into SQLite via
  chunked transactions (e.g. 500 rows/txn) so progress can be reported
  incrementally without a single giant transaction blocking readers.
  Emits `scan://progress {scanned, total_estimate, current_folder}`.
- **Incremental scan** (on next launch, or "Rescan Root"): compares the
  walk against `media.rel_path` + `modified_time`/`file_size`; only
  changed/new files are re-probed. Missing rows are marked and then
  garbage-collected once confirmed gone (not on first miss, to tolerate
  transient removable-media hiccups).
- **Live watching**: `notify` + `notify-debouncer-full` watches the root
  recursively; debounced events map to create/modify/rename/delete,
  updating single rows without a full rescan. Renames are matched via
  `notify`'s rename-tracking where the OS provides it, falling back to a
  size+mtime heuristic against recently-removed rows.
- UI stays interactive throughout: all scan work is background tasks;
  the gallery grid queries the DB directly and just reflects new rows as
  they land (a lightweight "N added" or progress pill, not a modal).

## 2. Metadata extraction — layered strategy (spec §3, non-negotiable)

For every media file, run this ladder until one stage yields a confirmed,
valid duration (and the rest of the metadata fields); each stage's failure
falls through to the next rather than giving up:

```
1. ffprobe -v error -print_format json -show_format -show_streams <file>
   -> parse format.duration, and the video stream's duration/nb_frames
2. If format.duration missing/invalid: inspect container-specific fields
   (per-stream duration, tags like com.apple.quicktime.duration, MKV
   SegmentDuration, etc. as exposed by ffprobe's stream/tags output)
3. MediaInfo CLI fallback (`mediainfo --Output=JSON`) if ffprobe's result
   is missing or looks implausible (e.g. 0, negative, or wildly exceeds
   file-size-implied bitrate bounds)
4. Deeper ffprobe pass: `-count_frames -count_packets` (slower, decodes)
   to get an authoritative frame count when the header lies (common with
   VFR footage, streamed/concatenated files, some MKV/TS files)
5. Final fallback: decode-and-count via `ffmpeg -i <file> -f null -` and
   derive duration from packet timestamps (last pts - first pts), used
   only when 1-4 all fail — this is the slow path and runs in the deep
   scan queue, never inline on first index
```

- Stages 1-2 run inline during the normal scan (fast, header-only).
- If stage 2 doesn't produce a valid, positive `duration_ms`, the row is
  written with `duration_ms = NULL`, `metadata_state = 'needs_deep_scan'`
  — **never `0`**. It is queued for stages 3-5 on the deep-scan worker
  queue (bounded concurrency, low priority relative to thumbnailing so
  browsing stays snappy).
- Deep scan results update the row in place and flip `metadata_state` to
  `ok` or, if every stage fails, `failed` (surfaced via the "Metadata
  Errors" smart collection, with **Retry metadata** / **Deep scan** /
  **Rebuild metadata** actions per file or in bulk).
- Variable-frame-rate handling: prefer stream duration over
  `nb_frames / avg_frame_rate` (which is wrong for VFR); when only frame
  count is available, use `duration = last_pts * time_base` rather than
  an average-fps multiplication.
- All five stages are implemented behind a single `metadata::probe::probe(path) -> ProbeResult`
  function with an internal stage enum, so the ladder logic lives in one
  place and is unit-testable against fixture files per container type.

### Container coverage

FFmpeg (bundled, see PACKAGING) covers the full list in spec §3 (MP4, MOV,
MKV, AVI, WEBM, M4V, MPEG/MPG, TS, MTS/M2TS, 3GP, FLV, WMV/ASF, OGV, VOB,
MXF, ...) out of the box; MediaInfo is a fallback only, not the primary
source, since FFprobe/FFmpeg's coverage is broader for exotic containers.

## 3. Photo metadata

EXIF/XMP read via a Rust image-metadata crate (e.g. `kamadak-exif` /
`little_exif`) for JPEG/TIFF/PNG/WEBP, plus HEIC/HEIF where the platform
codec is available. RAW formats decoded via a dedicated RAW crate where
feasible; unsupported RAW variants are still indexed (size/dates) with
metadata_state reflecting the gap rather than being excluded from the
library. Original EXIF is read-only unless the user explicitly invokes an
EXIF-editing action — no implicit rewrites.

## 4. Thumbnails

- **Photos**: decode + high-quality Lanczos downscale (`image` crate /
  libvips-equivalent) to a capped long edge (e.g. 512px grid, larger for
  filmstrip/hover), encoded as WebP in the cache.
- **Videos**: `ffmpeg -ss <t> -frames:v 1 ...` seeking past the first few
  seconds and sampling a small number of candidate frames, picking the one
  with the highest luma variance (cheap heuristic to skip near-black
  intro/fade frames) rather than always grabbing frame 0.
- **Cache key**: `blake3(rel_path + modified_time + file_size)` — cheap,
  collision-resistant, regenerates automatically on file modification
  without a full content hash. Stored under
  `%LOCALAPPDATA%/QuinPowerGallery/thumbcache/<root-id>/<key>.webp`.
- Generation runs on a bounded worker pool (configurable concurrency,
  default tied to CPU core count) so it never starves FFmpeg transcode
  jobs or the UI thread.
- Cache size is capped (Settings > Cache) with LRU eviction by last-access
  time; "Clear thumbnail cache" is a manual action too.

## 5. Deep scan / thumbnail queues

Both are bounded Tokio `mpsc` queues with a small fixed worker pool (default
`min(4, num_cpus)` for thumbnails, `min(2, num_cpus/2)` for deep-scan/FFmpeg
since those are heavier processes) — this is the concurrency cap referenced
in spec §23. Jobs are resumable: `scan_jobs.cursor` lets a queue pick back
up after a crash/restart (§30) instead of re-walking from the start.
