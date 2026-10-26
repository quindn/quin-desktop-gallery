pub mod app;
pub mod library;
pub mod name_key;
pub mod queries;
pub mod search;

use r2d2_sqlite::SqliteConnectionManager;

pub type Pool = r2d2::Pool<SqliteConnectionManager>;
pub type Conn = r2d2::PooledConnection<SqliteConnectionManager>;

/// Pragmas (WAL mode, foreign keys, normal sync — see DATABASE_SCHEMA.md)
/// are applied on every new pooled connection via the manager's init hook
/// in `build_pool` below.
pub fn build_pool(path: &std::path::Path) -> anyhow::Result<Pool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let manager = SqliteConnectionManager::file(path).with_init(|conn| {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 30000;
             PRAGMA journal_size_limit = 16777216;",
        )?;
        search::register(conn)?;
        Ok(())
    });
    let pool = r2d2::Pool::builder().max_size(8).build(manager)?;
    Ok(pool)
}

/// Renames `path` (and its `-wal`/`-shm` companions, if present) aside with a
/// `.corrupt-<unix time>` suffix, so a broken database never blocks the app — and the old file
/// stays on disk in case anything in it is still worth recovering by hand.
fn quarantine(path: &std::path::Path, reason: &str) {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let base = path.to_string_lossy().to_string();
    for suffix in ["", "-wal", "-shm"] {
        let f = std::path::PathBuf::from(format!("{base}{suffix}"));
        if f.exists() {
            let _ = std::fs::rename(&f, std::path::PathBuf::from(format!("{base}{suffix}.corrupt-{stamp}")));
        }
    }
    eprintln!("[db] {} looked corrupt ({reason}); starting a fresh one (the old file was kept as *.corrupt-{stamp})", path.display());
}

/// Opens a database and runs `init` (schema creation / migrations) against it, the way
/// `open_app_db`/`open_library` need. If that fails on a file that already existed — most
/// likely a hard kill or power loss left it unreadable, since WAL mode itself protects against
/// ordinary corruption — the broken file is quarantined and a fresh one takes its place, so a
/// damaged database degrades to "empty, needs reindexing" instead of refusing to start at all
/// (a fresh file failing `init` is a real error: something like a full disk, not corruption).
/// Returns whether a quarantine happened, so the caller can tell the user their index was
/// rebuilt rather than silently losing track of favorites/ratings/etc.
pub fn open_with_repair(path: &std::path::Path, init: impl Fn(&Pool) -> anyhow::Result<()>) -> anyhow::Result<(Pool, bool)> {
    // Deliberately no `PRAGMA quick_check` here: it reads the whole file, which on a big library on a
    // slow disk kept the app on "Loading…" for a long time on every start. What a hard kill leaves
    // behind (garbage, a torn header) fails the header check or the first real queries in `init`;
    // a deeper check runs in the background after an unclean shutdown instead (see `integrity_ok`).
    let try_once = |p: &std::path::Path| -> anyhow::Result<Pool> {
        if !has_sqlite_header(p) {
            anyhow::bail!("not a SQLite database");
        }
        let pool = build_pool(p)?;
        init(&pool)?;
        Ok(pool)
    };
    // A background check found this database damaged and asked for a rebuild on the next start.
    let flag = rebuild_flag(path);
    if flag.exists() {
        let _ = std::fs::remove_file(&flag);
        if path.exists() {
            quarantine(path, "marked for rebuilding");
            return Ok((try_once(path)?, true));
        }
    }
    let existed = path.exists();
    match try_once(path) {
        Ok(pool) => Ok((pool, false)),
        Err(e) if existed => {
            quarantine(path, &e.to_string());
            Ok((try_once(path)?, true))
        }
        Err(e) => Err(e),
    }
}

/// An empty or missing file is fine (SQLite creates it); anything else must start like a database.
fn has_sqlite_header(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else { return true };
    let mut head = [0u8; 16];
    match f.read(&mut head) {
        Ok(0) => true,
        Ok(16) => &head == b"SQLite format 3\0",
        _ => false,
    }
}

/// Next to a database: "rebuild me on the next start".
pub fn rebuild_flag(db: &std::path::Path) -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}.rebuild", db.to_string_lossy()))
}

/// The full (slow: reads everything) consistency check, for the background.
pub fn integrity_ok(pool: &Pool) -> bool {
    pool.get()
        .ok()
        .and_then(|c| c.query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, String>(0)).ok())
        .is_some_and(|s| s == "ok")
}

/// Moves what the write-ahead log holds into the database and shrinks the log again (after a big
/// scan it can grow larger than the database itself, and every start would have to read it).
pub fn checkpoint(pool: &Pool) {
    if let Ok(c) = pool.get() {
        let _ = c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
    }
}

/// Runs a `user_version`-tracked sequence of embedded migrations against
/// whichever pool is passed in (shared by both the global app DB and each
/// per-root library DB, using different migration sets).
pub fn run_migrations(pool: &Pool, migrations: &[&str]) -> anyhow::Result<()> {
    let mut conn = pool.get()?;
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let tx = conn.transaction()?;
    for (i, sql) in migrations.iter().enumerate() {
        let version = (i + 1) as i64;
        if version <= current {
            continue;
        }
        tx.execute_batch(sql)?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {}", migrations.len()))?;
    tx.commit()?;
    Ok(())
}

pub const APP_MIGRATIONS: &[&str] = &[include_str!("migrations/app_0001_init.sql")];

pub const LIBRARY_MIGRATIONS: &[&str] = &[
    include_str!("migrations/library_0001_init.sql"),
    include_str!("migrations/library_0002_resume_pipeline.sql"),
    include_str!("migrations/library_0003_sort_indexes.sql"),
    include_str!("migrations/library_0004_name_key.sql"),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("qpg-db-repair-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_missing_file_is_created_normally_not_treated_as_corrupt() {
        let dir = scratch("new");
        let path = dir.join("x.db");
        let (pool, repaired) = open_with_repair(&path, |p| run_migrations(p, APP_MIGRATIONS)).unwrap();
        assert!(!repaired);
        pool.get().unwrap().execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", []).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_garbage_file_is_quarantined_and_replaced_with_a_fresh_working_one() {
        let dir = scratch("garbage");
        let path = dir.join("x.db");
        std::fs::write(&path, b"this is not a sqlite database, just some garbage bytes").unwrap();

        let (pool, repaired) = open_with_repair(&path, |p| run_migrations(p, APP_MIGRATIONS)).unwrap();
        assert!(repaired, "a pre-existing unreadable file must be reported as repaired");
        // The fresh database actually works.
        pool.get().unwrap().execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", []).unwrap();
        let v: String = pool.get().unwrap().query_row("SELECT value FROM settings WHERE key = 'k'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "v");
        // The garbage original is kept alongside, not deleted.
        let quarantined: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1, "{quarantined:?}");
        assert_eq!(std::fs::read(dir.join(&quarantined[0])).unwrap(), b"this is not a sqlite database, just some garbage bytes");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_database_marked_for_rebuilding_is_replaced_on_the_next_open() {
        let dir = scratch("flag");
        let path = dir.join("x.db");
        {
            let (pool, _) = open_with_repair(&path, |p| run_migrations(p, APP_MIGRATIONS)).unwrap();
            pool.get().unwrap().execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", []).unwrap();
            assert!(integrity_ok(&pool));
            checkpoint(&pool);
        }
        std::fs::write(rebuild_flag(&path), b"1").unwrap();
        let (pool, repaired) = open_with_repair(&path, |p| run_migrations(p, APP_MIGRATIONS)).unwrap();
        assert!(repaired);
        let n: i64 = pool.get().unwrap().query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "a fresh database");
        assert!(!rebuild_flag(&path).exists(), "the flag is used up");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_valid_database_is_never_touched() {
        let dir = scratch("valid");
        let path = dir.join("x.db");
        {
            let (pool, repaired) = open_with_repair(&path, |p| run_migrations(p, APP_MIGRATIONS)).unwrap();
            assert!(!repaired);
            pool.get().unwrap().execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", []).unwrap();
        }
        // Reopening it must see the same data and must not be flagged as repaired.
        let (pool, repaired) = open_with_repair(&path, |p| run_migrations(p, APP_MIGRATIONS)).unwrap();
        assert!(!repaired);
        let v: String = pool.get().unwrap().query_row("SELECT value FROM settings WHERE key = 'k'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "v");
        std::fs::remove_dir_all(&dir).ok();
    }
}
