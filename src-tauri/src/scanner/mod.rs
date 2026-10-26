pub mod watcher;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::db::{library, queries, Pool};
use crate::fs_sandbox::GalleryRoot;
use crate::metadata::queue::MetadataJob;
use crate::state::AppState;
use crate::thumbnails::{self, queue::ThumbJob};

#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub scanned: u64,
    pub touched: u64,
    pub current_folder: String,
    pub done: bool,
    /// "new-folders" while brand-new folders are being indexed first,
    /// "full" for the regular pass over everything else.
    pub phase: &'static str,
}

/// Classifies a file by extension into the coarse categories the grid
/// filters on. Extensions outside this list are indexed as `other` only
/// if they're clearly media-adjacent; anything unrecognized is skipped
/// entirely rather than polluting the library with arbitrary files.
pub fn media_type_for_extension(ext: &str) -> Option<&'static str> {
    match ext {
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tiff" | "tif" | "avif" | "heic" | "heif"
        | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "orf" | "rw2" => Some("photo"),
        "gif" => Some("animated"),
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "m4v" | "mpeg" | "mpg" | "ts" | "mts"
        | "m2ts" | "3gp" | "flv" | "wmv" | "asf" | "ogv" | "vob" | "mxf" => Some("video"),
        _ => None,
    }
}

fn to_unix_ms(t: std::io::Result<SystemTime>) -> i64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct ScanCounters {
    scanned: u64,
    touched: u64,
}

struct IndexedFile {
    rel_path: String,
    folder_rel_path: String,
    upserted: bool,
}

/// Indexes one directory entry if it is a recognized media file inside the
/// root. `None` for anything skipped (directories, other file types,
/// unreadable entries, paths that escape the root).
fn index_entry(
    entry: &walkdir::DirEntry,
    root: &GalleryRoot,
    pool: &Pool,
    now_ms: i64,
    known: &HashMap<String, (i64, i64, bool)>,
) -> Option<IndexedFile> {
    if entry.file_type().is_dir() {
        return None;
    }
    let path = entry.path();

    // Cheap checks first, before touching the file at all.
    let ext = path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase())?;
    let media_type = media_type_for_extension(&ext)?;

    // Authoritative containment check, but only where it can matter: WalkDir
    // doesn't follow links, so a regular file reached by walking the root is
    // inside the root by construction. Canonicalizing every file (a couple
    // of syscalls each, milliseconds on network drives) was the bulk of a
    // rescan's cost; do it for symlinked files only.
    let canonical: PathBuf = if entry.path_is_symlink() {
        let c = dunce::canonicalize(path).ok()?;
        if !c.starts_with(root.canonical_path()) {
            return None;
        }
        c
    } else {
        path.to_path_buf()
    };

    let rel_path = root.relativize(&canonical)?;
    let meta = entry.metadata().ok()?;
    let file_size = meta.len() as i64;
    let modified_time = to_unix_ms(meta.modified());

    let folder_rel_path = rel_path
        .rsplit_once('/')
        .map(|(f, _)| f.to_string())
        .unwrap_or_default();

    // Unchanged since the last scan: nothing to read or write. (The upsert
    // would be a no-op anyway; this just avoids re-reading every photo's
    // EXIF on every launch.)
    if let Some(&(size, mtime, deleted)) = known.get(&rel_path) {
        if !deleted && size == file_size && mtime == modified_time {
            return Some(IndexedFile {
                rel_path,
                folder_rel_path,
                upserted: false,
            });
        }
    }

    let filename = canonical
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let (width, height, exif) = if media_type == "photo" {
        let (w, h) = crate::metadata::probe::probe_photo_dimensions(&canonical).unzip();
        (w, h, crate::metadata::probe::probe_photo_exif(&canonical))
    } else {
        (None, None, crate::metadata::probe::PhotoExif::default())
    };

    let scanned_file = queries::ScannedFile {
        rel_path: rel_path.clone(),
        filename,
        extension: ext,
        folder_rel_path: folder_rel_path.clone(),
        media_type: media_type.to_string(),
        file_size,
        created_time: to_unix_ms(meta.created()),
        modified_time,
        width,
        height,
        date_taken: exif.date_taken,
        gps_lat: exif.gps_lat,
        gps_lon: exif.gps_lon,
        camera_make: exif.camera_make,
        camera_model: exif.camera_model,
        orientation: exif.orientation,
    };

    let upserted = queries::upsert_scanned_file(pool, &scanned_file, now_ms).is_ok();
    Some(IndexedFile {
        rel_path,
        folder_rel_path,
        upserted,
    })
}

/// Walks `start` (skipping any subtree in `skip`), indexing every media
/// file and recording its rel_path in `seen`.
#[allow(clippy::too_many_arguments)]
fn walk_and_index(
    app: &AppHandle,
    root: &GalleryRoot,
    pool: &Pool,
    start: &Path,
    skip: &HashSet<PathBuf>,
    now_ms: i64,
    phase: &'static str,
    seen: &mut Vec<String>,
    counters: &mut ScanCounters,
    known: &HashMap<String, (i64, i64, bool)>,
) {
    let walker = WalkDir::new(start)
        .into_iter()
        .filter_entry(|e| !(e.file_type().is_dir() && skip.contains(e.path())));
    for entry in walker.filter_map(|e| e.ok()) {
        let Some(file) = index_entry(&entry, root, pool, now_ms, known) else {
            continue;
        };
        if file.upserted {
            counters.touched += 1;
        }
        seen.push(file.rel_path);
        counters.scanned += 1;

        if counters.scanned.is_multiple_of(200) {
            let _ = app.emit(
                "scan://progress",
                ScanProgress {
                    scanned: counters.scanned,
                    touched: counters.touched,
                    current_folder: file.folder_rel_path,
                    done: false,
                    phase,
                },
            );
        }
    }
}

/// Directories that exist on disk but that the library has never seen —
/// outermost ones only (a new folder's sub-folders are covered by walking
/// it). Cheap: directory entries only, no per-file work. A brand-new
/// library (nothing known yet) reports none: everything would be "new",
/// which is just the ordinary full scan.
fn find_new_folders(root: &GalleryRoot, pool: &Pool) -> Vec<(PathBuf, String)> {
    let Ok(known) = queries::known_folder_paths(pool) else {
        return vec![];
    };
    if known.len() <= 1 {
        return vec![];
    }
    let mut found = vec![];
    let mut it = WalkDir::new(root.canonical_path()).min_depth(1).into_iter();
    while let Some(entry) = it.next() {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_dir() {
            continue;
        }
        let Some(rel) = root.relativize(entry.path()) else {
            continue;
        };
        if known.contains(&rel) {
            continue;
        }
        found.push((entry.path().to_path_buf(), rel));
        it.skip_current_dir();
    }
    found
}

/// Queues thumbnail + metadata work for one freshly indexed folder subtree.
/// Runs before the general backlog is resumed, so — the queues being FIFO —
/// the new folder's media is processed ahead of everything older.
async fn feed_new_folder(app: &AppHandle, root: &GalleryRoot, pool: &Pool, folder: &str) {
    let state = app.state::<AppState>();
    let cache_dir = state.thumbcache_dir(&library::root_id(root.canonical_path()));

    if let Ok(candidates) = queries::list_thumbnail_candidates_in_folder(pool, folder) {
        for c in candidates {
            let Ok(abs_path) = root.resolve(&c.rel_path) else {
                let _ = queries::mark_unprocessable(pool, c.id);
                continue;
            };
            let key = thumbnails::cache_key(&c.rel_path, c.modified_time, c.file_size);
            state
                .thumbnail_queue
                .sweep_wait(ThumbJob {
                    media_id: c.id,
                    abs_path,
                    media_type: c.media_type,
                    cache_dir: cache_dir.clone(),
                    key,
                    duration_ms: c.duration_ms,
                    pool: pool.clone(),
                })
                .await;
        }
    }
    if let Ok(candidates) = queries::list_metadata_candidates_in_folder(pool, folder) {
        for c in candidates {
            let Ok(abs_path) = root.resolve(&c.rel_path) else {
                let _ = queries::mark_unprocessable(pool, c.id);
                continue;
            };
            state
                .metadata_queue
                .enqueue_wait(MetadataJob {
                    media_id: c.id,
                    abs_path,
                    pool: pool.clone(),
                    deep_only: c.metadata_state == "needs_deep_scan",
                })
                .await;
        }
    }
}

/// Finds folders new since the last scan, indexes them and queues their media ahead of the
/// backlog — the shared first phase of `run_full_scan` and `scan_new_folders` (see each for how
/// they differ afterwards).
fn index_new_folders(
    app: &AppHandle,
    root: &GalleryRoot,
    pool: &Pool,
    now_ms: i64,
    known: &HashMap<String, (i64, i64, bool)>,
) -> (Vec<(PathBuf, String)>, ScanCounters, Vec<String>) {
    let new_folders = find_new_folders(root, pool);
    let no_skip = HashSet::new();
    let mut counters = ScanCounters { scanned: 0, touched: 0 };
    let mut seen_rel_paths: Vec<String> = Vec::new();
    for (dir, rel) in &new_folders {
        walk_and_index(app, root, pool, dir, &no_skip, now_ms, "new-folders", &mut seen_rel_paths, &mut counters, known);
        // Sidebar counts + a UI refresh right away, then queue its media.
        let _ = queries::rebuild_folder_counts(pool);
        let _ = app.emit(
            "scan://progress",
            ScanProgress {
                scanned: counters.scanned,
                touched: counters.touched,
                current_folder: rel.clone(),
                done: false,
                phase: "new-folders",
            },
        );
        tauri::async_runtime::block_on(feed_new_folder(app, root, pool, rel));
    }
    (new_folders, counters, seen_rel_paths)
}

/// Walks the entire root and upserts every recognized media file, then
/// marks anything no longer present as deleted and rebuilds folder
/// counts. Runs synchronously on whatever thread calls it — callers
/// dispatch this onto a blocking task so it never runs on the async
/// runtime's worker threads or the UI.
///
/// Order of work: (1) check for folders the library has never seen and
/// index + queue those first, so new media shows up and gets thumbnails
/// before anything else; (2) resume the older unfinished backlog; (3) the
/// regular full pass over everything else, as before.
pub fn run_full_scan(app: &AppHandle, root: &GalleryRoot, pool: &Pool) -> anyhow::Result<()> {
    let now_ms = to_unix_ms(Ok(SystemTime::now()));
    let known = queries::known_file_stats(pool).unwrap_or_default();
    let known_folders = queries::known_folder_paths(pool).unwrap_or_default();
    let fresh_library = known_folders.len() <= 1;
    let mut counters = ScanCounters { scanned: 0, touched: 0 };
    let mut seen_rel_paths: Vec<String> = Vec::new();
    let mut new_folders: Vec<String> = Vec::new();

    // One walk over everything (it used to be two: a folders-only pass to find new folders first,
    // then the full pass — reading every directory of the library twice on each start). Folders the
    // library has never seen are noted on the way and their media queued ahead of the backlog.
    let walker = WalkDir::new(root.canonical_path()).into_iter();
    for entry in walker.filter_map(|e| e.ok()) {
        if entry.file_type().is_dir() {
            if !fresh_library && entry.depth() > 0 {
                if let Some(rel) = root.relativize(entry.path()) {
                    let inside_new = new_folders.last().is_some_and(|n| rel.starts_with(&format!("{n}/")));
                    if !inside_new && !known_folders.contains(&rel) {
                        new_folders.push(rel);
                    }
                }
            }
            continue;
        }
        let Some(file) = index_entry(&entry, root, pool, now_ms, &known) else { continue };
        if file.upserted {
            counters.touched += 1;
        }
        seen_rel_paths.push(file.rel_path);
        counters.scanned += 1;
        if counters.scanned.is_multiple_of(200) {
            let _ = app.emit(
                "scan://progress",
                ScanProgress { scanned: counters.scanned, touched: counters.touched, current_folder: file.folder_rel_path, done: false, phase: "full" },
            );
        }
    }
    if !new_folders.is_empty() {
        let _ = queries::rebuild_folder_counts(pool);
        for rel in &new_folders {
            tauri::async_runtime::block_on(feed_new_folder(app, root, pool, rel));
        }
    }

    // Whatever happens to the bookkeeping below, the UI must always get the
    // final `done` event — otherwise the "Scanning…" pill spins forever
    // after a DB hiccup, and pending rows never get scheduled.
    let bookkeeping = queries::mark_missing_as_deleted(pool, &seen_rel_paths)
        .map(|_| ())
        .and_then(|_| queries::rebuild_folder_counts(pool));

    resume_background_work(app, root, pool);

    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            scanned: counters.scanned,
            touched: counters.touched,
            current_folder: String::new(),
            done: true,
            phase: "full",
        },
    );
    crate::db::checkpoint(pool);

    bookkeeping
}

/// Looks only for folders under the root that the library has never indexed, and scans and
/// queues just those, leaving the rest of an already-indexed library untouched: no full
/// directory re-walk, no re-`stat`ing of every existing file, no full `media`-table comparison
/// (`mark_missing_as_deleted`). For a big library this is far cheaper than `run_full_scan` when
/// all that changed is a new folder being added.
///
/// This does not notice files removed, renamed or modified elsewhere in the library — the live
/// file watcher already reacts to those as they happen, and the regular "Rescan" (`run_full_scan`)
/// still catches anything it misses (e.g. changes made while the app was closed, or on a network
/// drive the watcher can't follow reliably). Returns how many new top-level folders were found.
pub fn scan_new_folders(app: &AppHandle, root: &GalleryRoot, pool: &Pool) -> anyhow::Result<usize> {
    let now_ms = to_unix_ms(Ok(SystemTime::now()));
    // A folder reported as "new" cannot contain any row this map would match anyway, so there is
    // no need to load the whole library's file stats just to scan a couple of new folders.
    let known = HashMap::new();
    let (new_folders, counters, _seen) = index_new_folders(app, root, pool, now_ms, &known);
    resume_background_work(app, root, pool);
    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            scanned: counters.scanned,
            touched: counters.touched,
            current_folder: String::new(),
            done: true,
            phase: "new-folders",
        },
    );
    Ok(new_folders.len())
}

/// Resume all unfinished work from persisted DB state. The feeder pages
/// by media id and awaits bounded queue capacity, so it keeps going until
/// the whole library has been scheduled instead of silently dropping work
/// after the first large batch.
const SWEEP_BATCH: i64 = 1000;

/// A transient DB error (busy/locked, pool timeout) must not silently end a
/// sweep — everything after that point would stay `pending` until restart.
async fn fetch_with_retry<T>(mut f: impl FnMut() -> anyhow::Result<T>) -> Option<T> {
    for attempt in 0..8u64 {
        match f() {
            Ok(v) => return Some(v),
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(250 * (attempt + 1))).await,
        }
    }
    None
}

pub fn resume_background_work(app: &AppHandle, root: &GalleryRoot, pool: &Pool) {
    let state = app.state::<AppState>();
    let root_id = library::root_id(root.canonical_path());
    let cache_dir = state.thumbcache_dir(&root_id);
    let thumbnail_queue = state.thumbnail_queue.clone();
    let metadata_queue = state.metadata_queue.clone();

    let thumb_root = root.clone();
    let thumb_pool = pool.clone();
    tauri::async_runtime::spawn(async move {
        let mut cursor = 0_i64;
        loop {
            let Some(candidates) = fetch_with_retry(|| {
                queries::list_thumbnail_candidates_after(&thumb_pool, cursor, SWEEP_BATCH)
            })
            .await
            else {
                break;
            };
            if candidates.is_empty() {
                break;
            }
            for c in candidates {
                cursor = c.id;
                let Ok(abs_path) = thumb_root.resolve(&c.rel_path) else {
                    let _ = queries::mark_unprocessable(&thumb_pool, c.id);
                    continue;
                };
                let key = thumbnails::cache_key(&c.rel_path, c.modified_time, c.file_size);
                thumbnail_queue
                    .sweep_wait(ThumbJob {
                        media_id: c.id,
                        abs_path,
                        media_type: c.media_type,
                        cache_dir: cache_dir.clone(),
                        key,
                        duration_ms: c.duration_ms,
                        pool: thumb_pool.clone(),
                    })
                    .await;
            }
        }
    });

    let metadata_root = root.clone();
    let metadata_pool = pool.clone();
    tauri::async_runtime::spawn(async move {
        let mut cursor = 0_i64;
        loop {
            let Some(candidates) = fetch_with_retry(|| {
                queries::list_metadata_candidates_after(&metadata_pool, cursor, SWEEP_BATCH)
            })
            .await
            else {
                break;
            };
            if candidates.is_empty() {
                break;
            }
            for c in candidates {
                cursor = c.id;
                let Ok(abs_path) = metadata_root.resolve(&c.rel_path) else {
                    let _ = queries::mark_unprocessable(&metadata_pool, c.id);
                    continue;
                };
                metadata_queue
                    .enqueue_wait(MetadataJob {
                        media_id: c.id,
                        abs_path,
                        pool: metadata_pool.clone(),
                        deep_only: c.metadata_state == "needs_deep_scan",
                    })
                    .await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(tag: &str) -> (PathBuf, Pool) {
        let tmp = std::env::temp_dir().join(format!("qpg-newfolder-test-{tag}-{}", uuid::Uuid::new_v4()));
        let root_dir = tmp.join("root");
        std::fs::create_dir_all(&root_dir).unwrap();
        let root_dir = dunce::canonicalize(&root_dir).unwrap();
        // App data lives beside the root, not inside it.
        let (_, pool, _) = library::open_library(&tmp.join("appdata"), &root_dir).unwrap();
        (root_dir, pool)
    }

    fn add(pool: &Pool, rel: &str) {
        let folder = rel.rsplit_once('/').map(|(f, _)| f).unwrap_or("").to_string();
        let f = queries::ScannedFile {
            rel_path: rel.to_string(),
            filename: rel.rsplit('/').next().unwrap().to_string(),
            extension: "mp4".into(),
            folder_rel_path: folder,
            media_type: "video".into(),
            file_size: 1,
            created_time: 1,
            modified_time: 1,
            width: None,
            height: None,
            date_taken: None,
            gps_lat: None,
            gps_lon: None,
            camera_make: None,
            camera_model: None,
            orientation: None,
        };
        queries::upsert_scanned_file(pool, &f, 1).unwrap();
    }

    #[test]
    fn only_unknown_outermost_folders_are_reported() {
        let (root_dir, pool) = library("a");
        std::fs::create_dir_all(root_dir.join("known/deep")).unwrap();
        std::fs::create_dir_all(root_dir.join("wrapper/inner")).unwrap();
        std::fs::create_dir_all(root_dir.join("fresh/sub/sub2")).unwrap();
        add(&pool, "top.mp4");
        add(&pool, "known/deep/a.mp4");
        add(&pool, "wrapper/inner/b.mp4");

        let root = GalleryRoot::new(&root_dir).unwrap();
        let found: Vec<String> = find_new_folders(&root, &pool).into_iter().map(|(_, rel)| rel).collect();
        // "known", "known/deep", "wrapper" and "wrapper/inner" are known
        // (ancestors count); "fresh" is new and its sub-folders are covered
        // by it rather than listed separately.
        assert_eq!(found, vec!["fresh".to_string()]);
        std::fs::remove_dir_all(&root_dir).ok();
    }

    #[test]
    fn empty_library_reports_no_new_folders() {
        let (root_dir, pool) = library("b");
        std::fs::create_dir_all(root_dir.join("anything")).unwrap();
        let root = GalleryRoot::new(&root_dir).unwrap();
        assert!(find_new_folders(&root, &pool).is_empty());
        std::fs::remove_dir_all(&root_dir).ok();
    }

    #[test]
    fn folder_scoped_candidate_query_matches_subtree_only() {
        let (root_dir, pool) = library("c");
        add(&pool, "new/a.mp4");
        add(&pool, "new/sub/b.mp4");
        add(&pool, "newer/c.mp4"); // shares a prefix but isn't inside "new"
        let ids: Vec<String> = queries::list_metadata_candidates_in_folder(&pool, "new")
            .unwrap()
            .into_iter()
            .map(|c| c.rel_path)
            .collect();
        assert_eq!(ids, vec!["new/a.mp4".to_string(), "new/sub/b.mp4".to_string()]);
        std::fs::remove_dir_all(&root_dir).ok();
    }

    #[test]
    fn unchanged_files_are_skipped_on_rescan_but_changes_are_picked_up() {
        let (root_dir, pool) = library("d");
        std::fs::create_dir_all(root_dir.join("vids")).unwrap();
        let file = root_dir.join("vids").join("clip.mp4");
        std::fs::write(&file, b"0123456789").unwrap();
        let root = GalleryRoot::new(&root_dir).unwrap();

        let index_all = |known: &HashMap<String, (i64, i64, bool)>| -> Vec<IndexedFile> {
            WalkDir::new(root.canonical_path())
                .into_iter()
                .filter_map(|e| e.ok())
                .filter_map(|e| index_entry(&e, &root, &pool, 1, known))
                .collect()
        };

        // First scan: nothing known, so the file is really indexed.
        let first = index_all(&HashMap::new());
        assert_eq!(first.len(), 1);
        assert!(first[0].upserted);
        assert_eq!(first[0].rel_path, "vids/clip.mp4");
        assert_eq!(first[0].folder_rel_path, "vids");

        // Second scan with the DB's view: unchanged -> reported but not rewritten.
        let known = queries::known_file_stats(&pool).unwrap();
        let second = index_all(&known);
        assert_eq!(second.len(), 1);
        assert!(!second[0].upserted);

        // Size changed on disk -> indexed again.
        std::fs::write(&file, b"0123456789-and-more").unwrap();
        let third = index_all(&known);
        assert!(third[0].upserted);
        std::fs::remove_dir_all(root_dir.parent().unwrap()).ok();
    }

    #[test]
    fn scan_new_folders_only_indexes_the_new_folder_and_leaves_the_rest_alone() {
        // `scan_new_folders` itself needs a live AppHandle (for `scan://progress` events and
        // queueing thumbnail/metadata work), which isn't available in this crate's plain unit
        // tests — the same reason `run_full_scan` isn't exercised end-to-end here either. This
        // instead composes the exact same building blocks it's made of (`find_new_folders`,
        // `index_entry`) the way `index_new_folders` does, and checks the same thing a caller of
        // `scan_new_folders` cares about: only the new folder gets touched.
        let (root_dir, pool) = library("g");
        std::fs::create_dir_all(root_dir.join("old")).unwrap();
        std::fs::write(root_dir.join("old").join("a.mp4"), b"0123456789").unwrap();
        let root = GalleryRoot::new(&root_dir).unwrap();

        // Index "old" the normal way first, as if the app had already scanned it.
        for e in WalkDir::new(root.canonical_path()).into_iter().filter_map(|e| e.ok()) {
            index_entry(&e, &root, &pool, 1, &HashMap::new());
        }
        let before: i64 = pool.get().unwrap().query_row("SELECT COUNT(*) FROM media WHERE is_deleted = 0", [], |r| r.get(0)).unwrap();
        assert_eq!(before, 1);

        // A brand-new folder appears.
        std::fs::create_dir_all(root_dir.join("fresh")).unwrap();
        std::fs::write(root_dir.join("fresh").join("b.mp4"), b"0123456789").unwrap();

        // What `scan_new_folders` does: find the new folders, then index only those (an empty
        // `known` map, exactly as `scan_new_folders` passes — a new folder can't match anything
        // in it anyway).
        let new_folders = find_new_folders(&root, &pool);
        assert_eq!(new_folders.iter().map(|(_, rel)| rel.as_str()).collect::<Vec<_>>(), vec!["fresh"], "exactly the one new top-level folder — 'old' is left alone");
        for (dir, _) in &new_folders {
            for e in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
                index_entry(&e, &root, &pool, 2, &HashMap::new());
            }
        }

        let rows: Vec<String> = pool
            .get()
            .unwrap()
            .prepare("SELECT rel_path FROM media WHERE is_deleted = 0 ORDER BY rel_path")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(rows, vec!["fresh/b.mp4".to_string(), "old/a.mp4".to_string()], "the new folder's file was indexed and the old one is untouched, not re-scanned");
        std::fs::remove_dir_all(root_dir.parent().unwrap()).ok();
    }

    #[test]
    fn similar_name_sort_groups_and_counts_naturally() {
        let (root_dir, pool) = library("e");
        for name in ["zed.mp4", "beach_10.mp4", "IMG_0001.jpg", "Beach (2).jpg", "beach_1.mp4", "20240101_1.mp4"] {
            add(&pool, name);
        }
        let q = queries::MediaQuery { sort_by: "similar_name".into(), sort_desc: false, ..Default::default() };
        let order: Vec<String> = queries::query_media(&pool, &q).unwrap().items.into_iter().map(|i| i.rel_path).collect();
        assert_eq!(
            order,
            vec!["beach_1.mp4", "Beach (2).jpg", "beach_10.mp4", "IMG_0001.jpg", "zed.mp4", "20240101_1.mp4"]
        );

        // Rows that predate the columns are filled in by the backfill.
        pool.get().unwrap().execute("UPDATE media SET name_key = NULL, name_num = NULL", []).unwrap();
        assert_eq!(queries::backfill_name_keys(&pool).unwrap(), 6);
        let again: Vec<String> = queries::query_media(&pool, &q).unwrap().items.into_iter().map(|i| i.rel_path).collect();
        assert_eq!(order, again);
        std::fs::remove_dir_all(root_dir.parent().unwrap()).ok();
    }

    #[test]
    fn media_position_follows_the_sort_order() {
        let (root_dir, pool) = library("f");
        for name in ["a.mp4", "b.mp4", "c.mp4", "d.mp4"] {
            add(&pool, name);
        }
        let mut q = queries::MediaQuery { sort_by: "name".into(), sort_desc: false, ..Default::default() };
        let id_of = |name: &str| -> i64 {
            pool.get()
                .unwrap()
                .query_row("SELECT id FROM media WHERE rel_path = ?1", [name], |r| r.get(0))
                .unwrap()
        };
        let c = id_of("c.mp4");
        assert_eq!(queries::media_position(&pool, &q, c).unwrap(), Some(2));
        q.sort_desc = true;
        assert_eq!(queries::media_position(&pool, &q, c).unwrap(), Some(1));
        // Filtered out -> not in the result at all.
        q.search = Some("zzz".into());
        assert_eq!(queries::media_position(&pool, &q, c).unwrap(), None);
        std::fs::remove_dir_all(root_dir.parent().unwrap()).ok();
    }
}
