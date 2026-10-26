use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::{app as app_db, library, queries};
use crate::fs_sandbox::GalleryRoot;
use crate::scanner::{run_full_scan, scan_new_folders as scan_new_folders_only, watcher};
use crate::state::{AppState, RootContext};

const SETTING_LAST_ROOT: &str = "last_root_path";

#[derive(Debug, Clone, Serialize)]
pub struct RootInfo {
    pub canonical_path: String,
    pub display_name: String,
    pub id: String,
    /// The library's own index had to be rebuilt from scratch (its database looked corrupt,
    /// most likely from a hard kill) — the media files themselves were never touched, but
    /// favorites/ratings/tags/thumbnails for this root are gone and it needs a rescan.
    pub repaired: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartupInfo {
    pub last_root_path: Option<String>,
    pub recent_roots: Vec<app_db::RecentRoot>,
    /// `last_root_path` did not come from the app's own settings (missing, or pointed at a
    /// folder that isn't there right now) — it was instead recovered by finding a library
    /// database under `data/roots/` whose folder still exists. See `discover_and_recover`.
    pub restored: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn display_name_for(path: &std::path::Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Opens (or switches to) a Gallery Root: validates + canonicalizes the
/// path, opens its per-root SQLite DB, replaces the app's current root
/// context (dropping the old one, which stops its watcher), records it as
/// the most recent root, and kicks off a background full scan. The scan
/// itself streams `scan://progress` events rather than blocking this
/// command, so the UI can start rendering already-indexed rows
/// immediately while new/changed ones stream in.
fn open_root_internal(app: &AppHandle, state: &State<AppState>, path: &str) -> anyhow::Result<RootInfo> {
    let root = GalleryRoot::new(path)?;
    let (id, pool, repaired) = library::open_library(&state.app_local_data_dir, root.canonical_path())?;

    let watch = watcher::start_watching(app.clone(), root.clone(), pool.clone()).ok();

    {
        let mut current = state.current.lock().unwrap();
        // Revoke the previous root's access before granting the new one —
        // the asset protocol (used to serve original photos/videos to the
        // viewer/player) must never keep a closed root reachable.
        if let Some(previous) = current.take() {
            app.asset_protocol_scope()
                .forbid_directory(previous.root.canonical_path(), true)
                .ok();
        }
        app.asset_protocol_scope()
            .allow_directory(root.canonical_path(), true)?;
        *current = Some(RootContext {
            root: root.clone(),
            id: id.clone(),
            pool: pool.clone(),
            watch,
        });
    }

    let canonical_str = root.canonical_path().to_string_lossy().to_string();
    let display_name = display_name_for(root.canonical_path());

    app_db::set_setting(&state.app_db, SETTING_LAST_ROOT, &canonical_str)?;
    app_db::upsert_recent_root(
        &state.app_db,
        &app_db::RecentRoot {
            canonical_path: canonical_str.clone(),
            display_name: display_name.clone(),
            last_opened: now_ms(),
            db_path: library::library_db_path(&state.app_local_data_dir, &id)
                .to_string_lossy()
                .to_string(),
        },
    )?;

    // The scan thread checks for brand-new folders first, then resumes the
    // pending thumbnail/duration backlog from the persisted DB rows (see
    // `run_full_scan`) — no need to resume anything here.
    // Rows indexed before the "similar names" sort existed get their key now,
    // in small batches on a background thread.
    let backfill_pool = pool.clone();
    std::thread::spawn(move || {
        let _ = queries::backfill_name_keys(&backfill_pool);
    });

    let scan_app = app.clone();
    let scan_root = root.clone();
    let scan_pool = pool.clone();
    let db_path = library::library_db_path(&state.app_local_data_dir, &id);
    std::thread::spawn(move || {
        // Let the window show the library first: the first queries and thumbnails get the disk
        // before the catch-up walk (the live watcher already covers changes from now on).
        std::thread::sleep(std::time::Duration::from_millis(1500));
        // After a crash / power cut: the full consistency check, in the background. A damaged
        // database is rebuilt on the next start (it can't be swapped while it's in use).
        if crate::startup::previous_run_was_unclean() && !crate::db::integrity_ok(&scan_pool) {
            let _ = std::fs::write(crate::db::rebuild_flag(&db_path), b"1");
            let _ = scan_app.emit("library://damaged", ());
        }
        if let Err(e) = run_full_scan(&scan_app, &scan_root, &scan_pool) {
            let _ = scan_app.emit("scan://error", e.to_string());
        }
    });

    Ok(RootInfo {
        canonical_path: canonical_str,
        display_name,
        id,
        repaired,
    })
}

/// The recorded last root is unusable (never set, or its folder isn't reachable right now) —
/// look for a library database under `data/roots/` that still knows a folder that exists, and
/// adopt the most recently used one instead of falling back to "choose a folder" (the data is
/// most likely just sitting there beside the exe; see `library::discover_all`). Recovered roots
/// are folded into the app db's own recent-roots list so this only has to happen once.
fn discover_and_recover(state: &State<AppState>) -> anyhow::Result<Option<String>> {
    let discovered = library::discover_all(&state.app_local_data_dir);
    for d in &discovered {
        let _ = app_db::upsert_recent_root(
            &state.app_db,
            &app_db::RecentRoot {
                canonical_path: d.canonical_path.clone(),
                display_name: display_name_for(std::path::Path::new(&d.canonical_path)),
                last_opened: d.last_opened,
                db_path: d.db_path.to_string_lossy().to_string(),
            },
        );
    }
    let Some(top) = discovered.first() else {
        return Ok(None);
    };
    app_db::set_setting(&state.app_db, SETTING_LAST_ROOT, &top.canonical_path)?;
    Ok(Some(top.canonical_path.clone()))
}

#[tauri::command(async)]
pub fn get_startup_info(state: State<AppState>) -> Result<StartupInfo, String> {
    let mut last_root_path = app_db::get_setting(&state.app_db, SETTING_LAST_ROOT).map_err(|e| e.to_string())?;
    let reachable = last_root_path.as_deref().map(|p| std::path::Path::new(p).exists()).unwrap_or(false);
    let mut restored = false;
    if !reachable {
        if let Some(recovered) = discover_and_recover(&state).map_err(|e| e.to_string())? {
            last_root_path = Some(recovered);
            restored = true;
        }
    }
    let recent_roots = app_db::list_recent_roots(&state.app_db).map_err(|e| e.to_string())?;
    Ok(StartupInfo {
        last_root_path,
        recent_roots,
        restored,
    })
}

#[tauri::command(async)]
pub fn open_root(app: AppHandle, state: State<AppState>, path: String) -> Result<RootInfo, String> {
    open_root_internal(&app, &state, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pick_root_folder(app: AppHandle, state: State<AppState>) -> Result<Option<RootInfo>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.to_string();
    open_root_internal(&app, &state, &path)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn remove_recent_root(state: State<AppState>, canonical_path: String) -> Result<(), String> {
    app_db::remove_recent_root(&state.app_db, &canonical_path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn rescan_root(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let current = state.current.lock().unwrap();
    let Some(ctx) = current.as_ref() else {
        return Err("no root open".into());
    };
    let root = ctx.root.clone();
    let pool = ctx.pool.clone();
    drop(current);
    std::thread::spawn(move || {
        let _ = run_full_scan(&app, &root, &pool);
    });
    Ok(())
}

/// Restarts the app (used after a damaged library index was marked for rebuilding).
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// The fast path: only look for folders added since the last scan and index those, instead of
/// re-walking and re-`stat`ing the whole library like "Rescan" does. See
/// `scanner::scan_new_folders`.
#[tauri::command(async)]
pub fn scan_new_folders(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let current = state.current.lock().unwrap();
    let Some(ctx) = current.as_ref() else {
        return Err("no root open".into());
    };
    let root = ctx.root.clone();
    let pool = ctx.pool.clone();
    drop(current);
    std::thread::spawn(move || {
        let _ = scan_new_folders_only(&app, &root, &pool);
    });
    Ok(())
}

#[tauri::command(async)]
pub fn open_in_explorer(state: State<AppState>, rel_path: Option<String>) -> Result<(), String> {
    let current = state.current.lock().unwrap();
    let Some(ctx) = current.as_ref() else {
        return Err("no root open".into());
    };
    let rel_path_is_file = rel_path.is_some();
    let target = match rel_path {
        Some(rel) => ctx.root.resolve(&rel).map_err(|e| e.to_string())?,
        None => ctx.root.canonical_path().to_path_buf(),
    };
    drop(current);

    #[cfg(target_os = "windows")]
    {
        if rel_path_is_file {
            // Opens the containing folder with this exact file selected
            // (SHOpenFolderAndSelectItems). The previous `explorer /select,…`
            // string was mangled by argument quoting for paths with spaces
            // and fell back to some default folder.
            tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg(&target)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}
