use std::path::{Path, PathBuf};
use std::collections::HashSet;

use super::{app as app_db, build_pool, open_with_repair, run_migrations, Pool, LIBRARY_MIGRATIONS};

/// Older portable builds may already have `user_version = 1` while their
/// v1 media table predates some of the metadata/thumbnail columns now used
/// by the pipeline. Because SQLite's CREATE TABLE IF NOT EXISTS cannot add
/// those columns retroactively, repair only missing additive columns before
/// normal migrations run. Existing rows and user data are never rebuilt.
fn repair_legacy_media_columns(pool: &Pool) -> anyhow::Result<()> {
    let conn = pool.get()?;
    let media_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media')",
        [],
        |r| r.get(0),
    )?;
    if !media_exists {
        return Ok(());
    }

    let columns: HashSet<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(media)")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
        rows.filter_map(Result::ok).collect()
    };

    let required = [
        ("width", "INTEGER"),
        ("height", "INTEGER"),
        ("orientation", "INTEGER"),
        ("rotation", "INTEGER"),
        ("duration_ms", "INTEGER"),
        ("fps", "REAL"),
        ("video_codec", "TEXT"),
        ("audio_codec", "TEXT"),
        ("bitrate", "INTEGER"),
        ("sample_rate", "INTEGER"),
        ("channels", "INTEGER"),
        ("container", "TEXT"),
        ("pixel_format", "TEXT"),
        ("has_audio", "INTEGER"),
        ("date_taken", "INTEGER"),
        ("gps_lat", "REAL"),
        ("gps_lon", "REAL"),
        ("camera_make", "TEXT"),
        ("camera_model", "TEXT"),
        ("thumbnail_key", "TEXT"),
        ("thumbnail_state", "TEXT NOT NULL DEFAULT 'pending'"),
        ("metadata_state", "TEXT NOT NULL DEFAULT 'pending'"),
        ("metadata_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("fingerprint", "TEXT"),
        ("favorite", "INTEGER NOT NULL DEFAULT 0"),
        ("rating", "INTEGER NOT NULL DEFAULT 0"),
        ("color_label", "TEXT"),
        ("notes", "TEXT"),
        ("playback_position_ms", "INTEGER NOT NULL DEFAULT 0"),
        ("last_viewed", "INTEGER"),
        ("is_deleted", "INTEGER NOT NULL DEFAULT 0"),
        // rel_path, lower case without accents, for the search box (db/search.rs); NULL = not yet
        ("search_key", "TEXT"),
    ];

    for (name, definition) in required {
        if !columns.contains(name) {
            conn.execute_batch(&format!("ALTER TABLE media ADD COLUMN {name} {definition};"))?;
        }
    }
    Ok(())
}

/// Deterministic id for a canonical root path, used to name its per-root
/// database file/folder under app data. Blake3 of the canonical path
/// string keeps it stable across app restarts without leaking the path
/// itself into a filename (Windows path length / character limits).
pub fn root_id(canonical_path: &Path) -> String {
    let s = canonical_path.to_string_lossy();
    blake3::hash(s.as_bytes()).to_hex()[..16].to_string()
}

pub fn library_db_path(app_data_dir: &Path, id: &str) -> PathBuf {
    app_data_dir.join("roots").join(id).join("library.db")
}

/// Keys of this database's own `settings` row that make it self-describing: the folder id
/// (`root_id`) is a one-way hash of the canonical path, so nothing in the filename can recover
/// it — this is the only place that mapping is stored outside the app-level database. See
/// `discover_all`.
const SETTING_ROOT_PATH: &str = "root_path";
const SETTING_LAST_OPENED_AT: &str = "last_opened_at";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn open_library(app_data_dir: &Path, canonical_root: &Path) -> anyhow::Result<(String, Pool, bool)> {
    let id = root_id(canonical_root);
    let path = library_db_path(app_data_dir, &id);
    let (pool, repaired) = open_with_repair(&path, |pool| {
        repair_legacy_media_columns(pool)?;
        // v1 is intentionally idempotent (CREATE ... IF NOT EXISTS). Running
        // it once here also repairs old user_version=1 databases that may be
        // missing one of the later-added auxiliary tables/indexes; the normal
        // migration runner would otherwise skip v1 solely because of the
        // version number.
        pool.get()?.execute_batch(include_str!("migrations/library_0001_init.sql"))?;
        run_migrations(pool, LIBRARY_MIGRATIONS)?;
        let conn = pool.get()?;
        super::search::prepare_schema(&conn)?;
        Ok(())
    })?;
    super::search::backfill_in_background(&pool);
    // Record which folder this is and when it was last opened — even if the app-level database
    // is later lost, recreated, or just doesn't have this root in its "recent roots" list (a
    // fresh install of a portable copy, say), the library can still be found and reopened
    // automatically from the data/ folder alone. Best-effort: a write failure here shouldn't
    // stop the root from opening.
    let _ = app_db::set_setting(&pool, SETTING_ROOT_PATH, &canonical_root.to_string_lossy());
    let _ = app_db::set_setting(&pool, SETTING_LAST_OPENED_AT, &now_ms().to_string());
    Ok((id, pool, repaired))
}

/// One library database found on disk under `data/roots/`, self-reported via the settings it
/// wrote in `open_library`.
#[derive(Debug, Clone)]
pub struct DiscoveredRoot {
    pub canonical_path: String,
    pub last_opened: i64,
    pub db_path: PathBuf,
}

/// Every per-root library whose folder still exists on disk, newest-opened first — read
/// straight from `data/roots/*/library.db`, independent of the app-level database (which
/// normally remembers this list, but may be empty, missing, or freshly recreated after being
/// corrupt). This is what lets the app recover the last-open library on its own instead of
/// asking the user to pick a folder again after a crash, as long as the `data/` folder itself is
/// still there beside the exe.
pub fn discover_all(app_data_dir: &Path) -> Vec<DiscoveredRoot> {
    let Ok(entries) = std::fs::read_dir(app_data_dir.join("roots")) else {
        return vec![];
    };
    let mut found = vec![];
    for entry in entries.filter_map(Result::ok) {
        let db_path = entry.path().join("library.db");
        if !db_path.is_file() {
            continue;
        }
        let Ok(pool) = build_pool(&db_path) else { continue };
        let Ok(Some(canonical_path)) = app_db::get_setting(&pool, SETTING_ROOT_PATH) else {
            continue; // a library.db from before this feature existed: nothing to recover from it (yet)
        };
        if !Path::new(&canonical_path).exists() {
            continue; // the folder itself is gone (moved/deleted/unplugged) — nothing to reopen
        }
        let last_opened = app_db::get_setting(&pool, SETTING_LAST_OPENED_AT)
            .ok()
            .flatten()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        found.push(DiscoveredRoot { canonical_path, last_opened, db_path });
    }
    found.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_and_upgrades_legacy_v1_library_without_rebuild() {
        let tmp = std::env::temp_dir().join(format!("qpg-legacy-db-test-{}", uuid::Uuid::new_v4()));
        let fake_root = tmp.join("gallery-root");
        let id = root_id(&fake_root);
        let db_path = library_db_path(&tmp, &id);

        let legacy_pool = build_pool(&db_path).unwrap();
        {
            let conn = legacy_pool.get().unwrap();
            conn.execute_batch(
                "CREATE TABLE media (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rel_path TEXT NOT NULL UNIQUE,
                    filename TEXT NOT NULL,
                    extension TEXT NOT NULL,
                    folder_rel_path TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    created_time INTEGER NOT NULL,
                    modified_time INTEGER NOT NULL,
                    indexed_time INTEGER NOT NULL
                 );
                 INSERT INTO media (
                    rel_path, filename, extension, folder_rel_path, media_type,
                    file_size, created_time, modified_time, indexed_time
                 ) VALUES ('clip.mp4', 'clip.mp4', 'mp4', '', 'video', 123, 1, 2, 3);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        }
        drop(legacy_pool);

        let (_, upgraded, repaired) = open_library(&tmp, &fake_root).unwrap();
        assert!(!repaired, "an old-but-valid v1 database is upgraded in place, not treated as corrupt");
        {
            let conn = upgraded.get().unwrap();
            let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(version, LIBRARY_MIGRATIONS.len() as i64);

            let row: (Option<i64>, String, String, i64, i64) = conn
                .query_row(
                    "SELECT duration_ms, metadata_state, thumbnail_state, favorite, rating
                     FROM media WHERE rel_path = 'clip.mp4'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap();
            assert_eq!(row, (None, "pending".into(), "pending".into(), 0, 0));

            let tags_exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='tags')",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(tags_exists);
        }
        drop(upgraded);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_corrupt_library_db_is_repaired_instead_of_refusing_to_open() {
        let tmp = std::env::temp_dir().join(format!("qpg-corrupt-lib-test-{}", uuid::Uuid::new_v4()));
        let fake_root = tmp.join("gallery-root");
        std::fs::create_dir_all(&fake_root).unwrap();
        let id = root_id(&fake_root);
        let db_path = library_db_path(&tmp, &id);
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        std::fs::write(&db_path, b"not actually a database").unwrap();

        let (_, pool, repaired) = open_library(&tmp, &fake_root).unwrap();
        assert!(repaired);
        // The fresh library actually works — indexing still functions after the repair.
        let count: i64 = pool.get().unwrap().query_row("SELECT COUNT(*) FROM media", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        assert!(std::fs::read_dir(db_path.parent().unwrap()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains(".corrupt-")));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn discover_all_finds_reachable_roots_newest_first_and_skips_gone_folders() {
        let tmp = std::env::temp_dir().join(format!("qpg-discover-test-{}", uuid::Uuid::new_v4()));
        let root_a = tmp.join("root-a");
        let root_b = tmp.join("root-b");
        let root_gone = tmp.join("root-gone");
        for r in [&root_a, &root_b, &root_gone] {
            std::fs::create_dir_all(r).unwrap();
        }
        let app_data = tmp.join("appdata");

        let (_, pool_a, _) = open_library(&app_data, &root_a).unwrap();
        drop(pool_a);
        std::thread::sleep(std::time::Duration::from_millis(30));
        let (_, pool_b, _) = open_library(&app_data, &root_b).unwrap();
        drop(pool_b);
        let (_, pool_gone, _) = open_library(&app_data, &root_gone).unwrap();
        drop(pool_gone);
        std::fs::remove_dir_all(&root_gone).unwrap(); // the folder disappears after being indexed once

        let found = discover_all(&app_data);
        let paths: Vec<String> = found.iter().map(|d| d.canonical_path.clone()).collect();
        assert_eq!(paths.len(), 2, "{paths:?}");
        assert!(!paths.iter().any(|p| p.contains("root-gone")), "a folder that no longer exists is not offered for recovery");
        // root_b was opened after root_a, so it comes first (most recently opened).
        assert!(paths[0].ends_with("root-b") || paths[0].ends_with("root-b\\"), "{paths:?}");
        assert!(paths[1].ends_with("root-a") || paths[1].ends_with("root-a\\"), "{paths:?}");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn discover_all_ignores_a_library_db_from_before_this_feature_existed() {
        // A library database created before `open_library` started writing `root_path` has
        // nothing to recover a folder path from — it must be skipped, not crash or panic.
        let tmp = std::env::temp_dir().join(format!("qpg-discover-legacy-test-{}", uuid::Uuid::new_v4()));
        let id = "0123456789abcdef";
        let db_path = library_db_path(&tmp, id);
        let pool = build_pool(&db_path).unwrap();
        pool.get().unwrap().execute_batch(include_str!("migrations/library_0001_init.sql")).unwrap();
        drop(pool);

        assert!(discover_all(&tmp).is_empty());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
