# Database Schema (SQLite)

One SQLite database per Gallery Root, stored in the app data directory
(`%APPDATA%/QuinPowerGallery/roots/<root-id>/library.db`), **not** inside
the gallery root itself (keeps the sandboxed folder untouched by app
internals, survives root removal, and multiple past roots can be recalled
under "Recent Root Folders" without collision).

`PRAGMA journal_mode=WAL;` `PRAGMA synchronous=NORMAL;` `PRAGMA foreign_keys=ON;`

## `media`

The core index. One row per file under the root.

| column | type | notes |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| rel_path | TEXT NOT NULL UNIQUE | POSIX-style, relative to canonical root |
| filename | TEXT NOT NULL | |
| extension | TEXT NOT NULL | lowercase, no dot |
| folder_rel_path | TEXT NOT NULL | immediate parent, relative to root |
| media_type | TEXT NOT NULL | `photo` \| `video` \| `animated` \| `other` |
| file_size | INTEGER NOT NULL | bytes |
| created_time | INTEGER NOT NULL | unix ms, filesystem |
| modified_time | INTEGER NOT NULL | unix ms, filesystem |
| indexed_time | INTEGER NOT NULL | unix ms, when row last (re)written |
| width | INTEGER | nullable until probed |
| height | INTEGER | |
| orientation | INTEGER | EXIF orientation 1-8 |
| rotation | INTEGER | video rotation degrees, 0/90/180/270 |
| duration_ms | INTEGER | **NULL, never 0, until confirmed.** See below. |
| fps | REAL | |
| video_codec | TEXT | |
| audio_codec | TEXT | |
| bitrate | INTEGER | |
| sample_rate | INTEGER | |
| channels | INTEGER | |
| container | TEXT | |
| pixel_format | TEXT | |
| has_audio | INTEGER | 0/1 |
| date_taken | INTEGER | unix ms, EXIF/QuickTime creation date if present |
| gps_lat | REAL | |
| gps_lon | REAL | |
| camera_make | TEXT | |
| camera_model | TEXT | |
| thumbnail_key | TEXT | cache key, see Thumbnails |
| thumbnail_state | TEXT | `pending` \| `ready` \| `failed` |
| metadata_state | TEXT NOT NULL DEFAULT 'pending' | `pending` \| `ok` \| `needs_deep_scan` \| `failed` |
| metadata_attempts | INTEGER NOT NULL DEFAULT 0 | |
| fingerprint | TEXT | optional content hash (xxhash/blake3), for dedupe |
| favorite | INTEGER NOT NULL DEFAULT 0 | |
| rating | INTEGER NOT NULL DEFAULT 0 | 0-5 |
| color_label | TEXT | |
| notes | TEXT | |
| playback_position_ms | INTEGER NOT NULL DEFAULT 0 | resume position |
| last_viewed | INTEGER | unix ms |
| is_deleted | INTEGER NOT NULL DEFAULT 0 | soft flag; watcher marks then GC sweeps |

Indexes: `folder_rel_path`, `media_type`, `duration_ms`, `file_size`,
`modified_time`, `created_time`, `date_taken`, `favorite`, `rating`,
`metadata_state`, and a `rel_path` UNIQUE index (also the rename/move
matching key). Composite index on `(media_type, duration_ms)` for the
duration filters in section 9/10, since that combination is the hottest
query in the app.

**Duration is never recorded as `0` to mean "unknown."** Unknown duration
is SQL `NULL` and the row's `metadata_state` is `needs_deep_scan`. Sorting
by duration always uses `ORDER BY duration_ms` on this integer millisecond
column, with `NULL`s sorted last regardless of direction, and the UI shows
a distinct "Needs deep scan" badge instead of `0:00`.

## `tags` / `media_tags`

```
tags(id INTEGER PK, name TEXT UNIQUE NOT NULL)
media_tags(media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
           tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
           PRIMARY KEY (media_id, tag_id))
```

## `folders`

Materialized folder tree for fast sidebar rendering + counts, rebuilt
incrementally by the scanner rather than recomputed from `media` on every
render.

```
folders(rel_path TEXT PRIMARY KEY, parent_rel_path TEXT, name TEXT,
        media_count INTEGER NOT NULL DEFAULT 0,
        depth INTEGER NOT NULL)
```

## `smart_collections`

```
smart_collections(id INTEGER PK, name TEXT NOT NULL,
                   filter_json TEXT NOT NULL,   -- serialized filter tree, §9
                   is_builtin INTEGER NOT NULL DEFAULT 0,
                   sort_order INTEGER)
```

## `scan_jobs`

Recovery bookkeeping for crash safety (§30) — one row per in-flight or
last-completed scan/deep-scan/thumbnail sweep so the app can resume rather
than restart from zero after an unclean exit.

```
scan_jobs(id INTEGER PK, kind TEXT NOT NULL, -- 'full_scan'|'deep_scan'|'thumbnail_sweep'
          state TEXT NOT NULL,               -- 'running'|'completed'|'interrupted'
          started_at INTEGER, completed_at INTEGER,
          cursor TEXT)                        -- opaque resume cursor (last rel_path)
```

## `duplicates` (cache of the duplicate finder's last run, §18)

```
duplicate_groups(id INTEGER PK, method TEXT NOT NULL, created_at INTEGER)
duplicate_members(group_id INTEGER REFERENCES duplicate_groups(id) ON DELETE CASCADE,
                   media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
                   score REAL)
```

## `settings`

Simple key/value table (root path, recent roots, window bounds, LAN config,
last filter/sort/view state, cache size limits, keyboard shortcut overrides).

```
settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)  -- value is JSON
```

`recent_roots` is its own small table rather than a JSON blob, since it's
queried and pruned independently:

```
recent_roots(canonical_path TEXT PRIMARY KEY, display_name TEXT,
             last_opened INTEGER NOT NULL, db_path TEXT NOT NULL)
```

This table lives in a small **global** `app.db` (not per-root), since it
must be readable before any root's per-root DB is opened.

## Migrations

Plain numbered SQL files embedded via `rust_embed` / `include_str!`,
applied in a `user_version` pragma-tracked loop at startup — no ORM.
