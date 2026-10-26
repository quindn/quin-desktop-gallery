//! Live filesystem watching, applied change by change.
//!
//! A change under the root (a file added, replaced, renamed, deleted, a folder moved in or out)
//! updates just the rows it concerns — the file itself, or the one folder's subtree — within a
//! fraction of a second, instead of re-walking the whole library (which on a six-figure library,
//! or a slow disk, took seconds to minutes per change). Only when the OS reports that it lost
//! track of events (buffer overflow) does it fall back to a full `run_full_scan`.
//!
//! Events are funnelled to one worker thread, so changes are applied in order and a burst (a
//! folder of thousands of files being copied in) is handled in a few batches, not one thread per
//! event. A file that is still being written is looked at again once it has settled.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime};

use notify::EventKind;
use notify_debouncer_full::{new_debouncer_opt, DebouncedEvent, NoCache};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::db::{queries, Pool};
use crate::fs_sandbox::GalleryRoot;

use super::{feed_new_folder, index_entry, media_type_for_extension, run_full_scan, to_unix_ms, ScanProgress};

/// Holds the debouncer alive for as long as watching should continue;
/// dropping it stops the watch (e.g. on root change) and, with it, the worker.
pub struct WatchHandle {
    _debouncer: notify_debouncer_full::Debouncer<notify::RecommendedWatcher, NoCache>,
}

/// What the worker is told.
enum Msg {
    Events(Vec<DebouncedEvent>),
    /// The OS dropped events: only a full walk can be trusted now.
    Rescan,
}

/// How long a file must go unmodified before it is indexed (a copy still in progress would
/// otherwise be probed half-written and again for every chunk).
const SETTLE: Duration = Duration::from_millis(1200);

pub fn start_watching(app: AppHandle, root: GalleryRoot, pool: Pool) -> anyhow::Result<WatchHandle> {
    let watch_root = root.canonical_path().to_path_buf();
    let (tx, rx) = mpsc::channel::<Msg>();

    // `NoCache`: the default cache remembers the file id of EVERY file under the root (it opens each
    // one) to pair up renames — 4-5 s for 80 000 files here, minutes on a slow or busy disk, and the
    // app waited for it before showing anything. Renames are handled from the paths alone below.
    let mut debouncer = new_debouncer_opt::<_, notify::RecommendedWatcher, NoCache>(
        Duration::from_millis(250),
        None,
        move |result: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
            let msg = match result {
                Ok(events) if events.iter().any(|e| e.event.need_rescan()) => {
                    log("the OS lost track of changes: full rescan");
                    Msg::Rescan
                }
                Ok(events) if events.is_empty() => return,
                Ok(events) => {
                    for e in &events {
                        log(&format!("event {:?} {:?}", e.event.kind, e.event.paths));
                    }
                    Msg::Events(events)
                }
                Err(errs) => {
                    log(&format!("watch errors {errs:?}: full rescan"));
                    Msg::Rescan
                }
            };
            let _ = tx.send(msg);
        },
        NoCache::new(),
        notify::Config::default(),
    )?;
    debouncer.watch(&watch_root as &PathBuf, notify::RecursiveMode::Recursive)?;

    std::thread::Builder::new().name("qg-watch".into()).spawn(move || worker(app, root, pool, rx))?;

    Ok(WatchHandle { _debouncer: debouncer })
}

/// Paths an event is about, split into "look at this" and "this is gone". What is decided finally
/// depends on what exists on disk when the batch is applied, so an add+delete in one burst is fine.
fn paths_of(ev: &DebouncedEvent) -> Vec<PathBuf> {
    match ev.event.kind {
        EventKind::Access(_) => vec![],
        _ => ev.event.paths.clone(),
    }
}

fn worker(app: AppHandle, root: GalleryRoot, pool: Pool, rx: mpsc::Receiver<Msg>) {
    // path -> earliest time it may be applied (files still being written wait until they settle)
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    loop {
        let wait = pending.values().min().map(|t| t.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(3600));
        match rx.recv_timeout(wait) {
            Ok(Msg::Rescan) => {
                pending.clear();
                while rx.try_recv().is_ok() {}
                let _ = run_full_scan(&app, &root, &pool);
                continue;
            }
            Ok(Msg::Events(events)) => {
                let now = Instant::now();
                // (a rename reports both names: the old one no longer exists, the new one does —
                // `apply` decides by what is on disk, so every kind of event is handled the same way)
                for ev in &events {
                    for p in paths_of(ev) {
                        pending.entry(p).or_insert(now);
                    }
                }
                // more events may already be queued: take them into the same batch
                while let Ok(m) = rx.try_recv() {
                    match m {
                        Msg::Rescan => {
                            pending.clear();
                            let _ = run_full_scan(&app, &root, &pool);
                        }
                        Msg::Events(evs) => {
                            for ev in &evs {
                                for p in paths_of(ev) {
                                    pending.entry(p).or_insert(now);
                                }
                            }
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return, // the root was closed
        }

        // everything due now: settled files and folders, and whatever is gone
        let now = Instant::now();
        let due: Vec<PathBuf> = pending.iter().filter(|(_, t)| **t <= now).map(|(p, _)| p.clone()).collect();
        if due.is_empty() {
            continue;
        }
        let mut ready = vec![];
        for p in due {
            pending.remove(&p);
            match still_being_written(&p) {
                Some(left) => {
                    pending.insert(p, Instant::now() + left);
                }
                None => ready.push(p),
            }
        }
        if ready.is_empty() {
            continue;
        }
        let t0 = Instant::now();
        let summary = apply(&root, &pool, &ready);
        let t_apply = t0.elapsed();
        if !summary.changed {
            log(&format!("{} path(s): nothing to change ({:?}) {:?}", ready.len(), t_apply, ready));
        }
        if summary.changed {
            // the grid first (the rows are already in), then the folder tree's counts
            let progress = |done| ScanProgress { scanned: summary.indexed as u64, touched: summary.indexed as u64, current_folder: String::new(), done, phase: "watch" };
            let _ = app.emit("scan://progress", progress(true));
            let _ = queries::rebuild_folder_counts(&pool);
            log(&format!("{} path(s): applied in {:?}, folder counts {:?}; {:?}", ready.len(), t_apply, t0.elapsed() - t_apply, summary));
            for folder in &summary.touched_folders {
                tauri::async_runtime::block_on(feed_new_folder(&app, &root, &pool, folder));
            }
            let _ = app.emit("scan://progress", progress(true));
        }
    }
}

/// A regular file modified less than `SETTLE` ago: how much longer to wait.
fn still_being_written(p: &Path) -> Option<Duration> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() {
        return None;
    }
    let age = SystemTime::now().duration_since(meta.modified().ok()?).unwrap_or_default();
    (age < SETTLE).then(|| SETTLE - age + Duration::from_millis(50))
}

/// What one batch did.
#[derive(Debug, Default)]
pub(crate) struct Applied {
    pub changed: bool,
    pub indexed: usize,
    pub removed: usize,
    /// Folders (root-relative) whose new media should be queued for thumbnails / metadata.
    pub touched_folders: BTreeSet<String>,
}

/// Applies a batch of changed paths to the library: each path that exists is indexed (a folder:
/// everything inside it), each that doesn't is marked deleted (a folder: everything under it).
/// Pure database work — no events, no queues — so it can be tested on its own.
pub(crate) fn apply(root: &GalleryRoot, pool: &Pool, paths: &[PathBuf]) -> Applied {
    let mut out = Applied::default();
    let now_ms = to_unix_ms(Ok(SystemTime::now()));
    let mut gone: Vec<String> = vec![];

    for p in paths {
        let Some(rel) = root.relativize(p) else { continue };
        if rel.is_empty() {
            continue;
        }
        let meta = std::fs::symlink_metadata(p);
        match meta {
            Err(_) => gone.push(rel),
            Ok(m) if m.is_dir() => {
                // A folder the library already has only "changed" because an entry in it did, and
                // that entry has its own event — re-reading the whole folder would be wasted work.
                if queries::folder_is_known(pool, &rel).unwrap_or(false) {
                    continue;
                }
                // a folder appeared (created, moved or renamed in): index what is inside it
                let known = HashMap::new();
                for entry in WalkDir::new(p).into_iter().filter_map(|e| e.ok()) {
                    if let Some(f) = index_entry(&entry, root, pool, now_ms, &known) {
                        out.indexed += usize::from(f.upserted);
                    }
                }
                out.touched_folders.insert(rel);
                out.changed = true;
            }
            Ok(_) => {
                let is_media = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| media_type_for_extension(&e.to_ascii_lowercase()).is_some())
                    .unwrap_or(false);
                if !is_media {
                    continue;
                }
                // the row as the library knows it: an unchanged file is left alone
                let known = queries::file_stats_for(pool, std::slice::from_ref(&rel)).unwrap_or_default();
                for entry in WalkDir::new(p).max_depth(0).into_iter().filter_map(|e| e.ok()) {
                    if let Some(f) = index_entry(&entry, root, pool, now_ms, &known) {
                        if f.upserted {
                            out.indexed += 1;
                            out.changed = true;
                            out.touched_folders.insert(f.folder_rel_path);
                        }
                    }
                }
            }
        }
    }
    if !gone.is_empty() {
        if let Ok(n) = queries::mark_deleted_paths(pool, &gone) {
            out.removed = n;
            out.changed |= n > 0;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::library;

    fn setup(tag: &str) -> (PathBuf, GalleryRoot, Pool) {
        let tmp = std::env::temp_dir().join(format!("qpg-watch-{tag}-{}", uuid::Uuid::new_v4()));
        let root_dir = tmp.join("root");
        std::fs::create_dir_all(&root_dir).unwrap();
        let root_dir = dunce::canonicalize(&root_dir).unwrap();
        let (_, pool, _) = library::open_library(&tmp.join("appdata"), &root_dir).unwrap();
        (root_dir.clone(), GalleryRoot::new(&root_dir).unwrap(), pool)
    }

    fn live(pool: &Pool) -> Vec<String> {
        pool.get()
            .unwrap()
            .prepare("SELECT rel_path FROM media WHERE is_deleted = 0 ORDER BY rel_path")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    #[test]
    fn files_and_folders_are_added_changed_renamed_and_removed_one_by_one() {
        let (dir, root, pool) = setup("a");
        std::fs::create_dir_all(dir.join("old")).unwrap();
        std::fs::write(dir.join("old/a.mp4"), b"0123456789").unwrap();
        std::fs::write(dir.join("old/notes.txt"), b"not media").unwrap();

        // one new file
        let r = apply(&root, &pool, &[dir.join("old/a.mp4"), dir.join("old/notes.txt")]);
        assert!(r.changed && r.indexed == 1, "{r:?}");
        assert_eq!(live(&pool), vec!["old/a.mp4"]);

        // the same file again, unchanged: nothing to do
        let r = apply(&root, &pool, &[dir.join("old/a.mp4")]);
        assert!(!r.changed, "an unchanged file is not rewritten: {r:?}");

        // a folder moved in with files and a sub-folder
        std::fs::create_dir_all(dir.join("new/sub")).unwrap();
        std::fs::write(dir.join("new/b.jpg"), b"x").unwrap();
        std::fs::write(dir.join("new/sub/c.mp4"), b"yy").unwrap();
        let r = apply(&root, &pool, &[dir.join("new")]);
        assert!(r.changed && r.touched_folders.contains("new"), "{r:?}");
        assert_eq!(live(&pool), vec!["new/b.jpg", "new/sub/c.mp4", "old/a.mp4"]);

        // a rename: old name gone, new name there
        std::fs::rename(dir.join("old/a.mp4"), dir.join("old/renamed.mp4")).unwrap();
        apply(&root, &pool, &[dir.join("old/a.mp4"), dir.join("old/renamed.mp4")]);
        assert_eq!(live(&pool), vec!["new/b.jpg", "new/sub/c.mp4", "old/renamed.mp4"]);

        // a whole folder deleted: everything under it goes, a folder with a similar name stays
        std::fs::create_dir_all(dir.join("newer")).unwrap();
        std::fs::write(dir.join("newer/d.mp4"), b"z").unwrap();
        apply(&root, &pool, &[dir.join("newer")]);
        std::fs::remove_dir_all(dir.join("new")).unwrap();
        let r = apply(&root, &pool, &[dir.join("new")]);
        assert_eq!(r.removed, 2);
        assert_eq!(live(&pool), vec!["newer/d.mp4", "old/renamed.mp4"]);

        // a file whose content changed is indexed again
        std::fs::write(dir.join("old/renamed.mp4"), b"0123456789-longer").unwrap();
        let r = apply(&root, &pool, &[dir.join("old/renamed.mp4")]);
        assert!(r.changed && r.indexed == 1);
        std::fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    #[test]
    fn a_file_still_being_written_waits() {
        let tmp = std::env::temp_dir().join(format!("qpg-settle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("x.mp4");
        std::fs::write(&f, b"1").unwrap();
        assert!(still_being_written(&f).is_some(), "just written");
        assert!(still_being_written(&tmp).is_none(), "folders never wait");
        assert!(still_being_written(&tmp.join("missing.mp4")).is_none(), "gone files never wait");
        std::fs::remove_dir_all(&tmp).ok();
    }
}

/// Timings, written into the data folder when QG_DEBUG_WATCH is set.
fn log(line: &str) {
    if std::env::var_os("QG_DEBUG_WATCH").is_none() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(crate::paths::tmp_dir().join("qg-watch.log")) {
        let _ = writeln!(f, "{} {line}", chrono::Local::now().format("%H:%M:%S%.3f"));
    }
}
