//! Crash safety (spec §30): every cache/job writer in this app writes to a
//! `*.tmp*`-suffixed path and only renames it to its final name on
//! success (see thumbnails, transcode, editing). If the app is killed
//! mid-write, that temp file is orphaned. This sweep removes any such
//! leftovers on the next startup, so a crash never leaves a half-written
//! file lying around indefinitely.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Where the app stores everything — thumbnail/playback caches, per-root
/// databases, the app-level "recent roots" db. Prefers a `data/` folder
/// next to the executable, so the whole install (portable build included)
/// stays self-contained and copies/moves as one unit; falls back to the
/// OS per-user app-data directory when that's not writable (e.g.
/// installed to Program Files, where a standard account can't write next
/// to the exe without elevation).
pub fn resolve_data_dir(_app: &tauri::App) -> anyhow::Result<PathBuf> {
    Ok(crate::paths::data_dir().to_path_buf())
}

static UNCLEAN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Marks the app as running. If the marker from the previous run is still there, that run ended
/// without a proper quit (crash, power loss, killed) and databases deserve a background check.
pub fn mark_running(data_dir: &Path) {
    let marker = data_dir.join(".running");
    UNCLEAN.store(marker.exists(), std::sync::atomic::Ordering::Relaxed);
    let _ = std::fs::write(&marker, b"1");
}

/// A proper quit: the next start doesn't need to check anything.
pub fn mark_clean_exit(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(".running"));
}

pub fn previous_run_was_unclean() -> bool {
    UNCLEAN.load(std::sync::atomic::Ordering::Relaxed)
}

fn sweep_dir(dir: &Path, launched: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        // `DirEntry::file_type` comes straight from the directory listing;
        // `path.is_dir()` cost one extra stat per file — with a six-figure
        // thumbnail cache that alone was seconds of startup delay.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            sweep_dir(&path, launched);
            continue;
        }
        if !entry.file_name().to_string_lossy().contains(".tmp") {
            continue;
        }
        // Only what was left by a previous run: a temp file written since
        // this launch belongs to a job that's still in flight.
        let abandoned = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t <= launched)
            .unwrap_or(false);
        if abandoned {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Runs on a background thread: the window must not wait for a directory
/// walk over the whole cache.
pub fn cleanup_abandoned_temp_files(app_local_data_dir: PathBuf) {
    let launched = SystemTime::now();
    std::thread::spawn(move || {
        for sub in ["thumbcache", "playcache", "edit_temp"] {
            sweep_dir(&app_local_data_dir.join(sub), launched);
        }
    });
}
