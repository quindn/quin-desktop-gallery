use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{run_migrations, Pool, APP_MIGRATIONS};

pub fn open_app_db(app_data_dir: &Path) -> anyhow::Result<Pool> {
    let path = app_data_dir.join("app.db");
    // Never lets a corrupt app db take the whole app down (see `open_with_repair`): worst case
    // it starts with an empty "recent roots" list, and `get_startup_info` recovers that list
    // from the per-root databases living in data/roots/ (each knows its own folder — see
    // `library::open_library` / `library::discover_all`).
    let (pool, _repaired) = super::open_with_repair(&path, |pool| run_migrations(pool, APP_MIGRATIONS))?;
    Ok(pool)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentRoot {
    pub canonical_path: String,
    pub display_name: String,
    pub last_opened: i64,
    pub db_path: String,
}

pub fn upsert_recent_root(pool: &Pool, root: &RecentRoot) -> anyhow::Result<()> {
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO recent_roots (canonical_path, display_name, last_opened, db_path)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(canonical_path) DO UPDATE SET
            display_name = excluded.display_name,
            last_opened = excluded.last_opened,
            db_path = excluded.db_path",
        rusqlite::params![
            root.canonical_path,
            root.display_name,
            root.last_opened,
            root.db_path
        ],
    )?;
    Ok(())
}

pub fn list_recent_roots(pool: &Pool) -> anyhow::Result<Vec<RecentRoot>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT canonical_path, display_name, last_opened, db_path
         FROM recent_roots ORDER BY last_opened DESC LIMIT 10",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(RecentRoot {
            canonical_path: r.get(0)?,
            display_name: r.get(1)?,
            last_opened: r.get(2)?,
            db_path: r.get(3)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn remove_recent_root(pool: &Pool, canonical_path: &str) -> anyhow::Result<()> {
    let conn = pool.get()?;
    conn.execute(
        "DELETE FROM recent_roots WHERE canonical_path = ?1",
        rusqlite::params![canonical_path],
    )?;
    Ok(())
}

pub fn get_setting(pool: &Pool, key: &str) -> anyhow::Result<Option<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(rusqlite::params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_setting(pool: &Pool, key: &str, value: &str) -> anyhow::Result<()> {
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}
