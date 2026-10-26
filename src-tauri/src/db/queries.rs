use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::name_key::similar_name_key;
use super::Pool;

/// Fields the scanner writes/updates for a file on disk. Metadata fields
/// (duration, codec, EXIF, ...) are populated later by the metadata
/// pipeline (Phase 2) and are intentionally not part of this struct.
#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub rel_path: String,
    pub filename: String,
    pub extension: String,
    pub folder_rel_path: String,
    pub media_type: String,
    pub file_size: i64,
    pub created_time: i64,
    pub modified_time: i64,
    /// Photos only: cheap header-only dimension read done inline during
    /// the walk (no full pixel decode, so it doesn't slow scanning down).
    /// Videos get their width/height from the async ffprobe queue instead
    /// — spawning a subprocess per file during the walk would.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Photos only: EXIF read inline alongside dimensions (see
    /// `metadata::probe::probe_photo_exif`).
    pub date_taken: Option<i64>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub orientation: Option<i64>,
}

pub fn upsert_scanned_file(pool: &Pool, f: &ScannedFile, now_ms: i64) -> anyhow::Result<()> {
    let conn = pool.get()?;
    let metadata_state = if f.width.is_some() { "ok" } else { "pending" };
    let (name_key, name_num) = similar_name_key(&f.filename);
    conn.execute(
        "INSERT INTO media (
            rel_path, filename, extension, folder_rel_path, media_type,
            file_size, created_time, modified_time, indexed_time, width, height,
            date_taken, gps_lat, gps_lon, camera_make, camera_model, orientation,
            metadata_state, thumbnail_state, is_deleted, name_key, name_num
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'pending', 0, ?19, ?20)
         ON CONFLICT(rel_path) DO UPDATE SET
            file_size = excluded.file_size,
            modified_time = excluded.modified_time,
            indexed_time = excluded.indexed_time,
            width = excluded.width,
            height = excluded.height,
            date_taken = excluded.date_taken,
            gps_lat = excluded.gps_lat,
            gps_lon = excluded.gps_lon,
            camera_make = excluded.camera_make,
            camera_model = excluded.camera_model,
            orientation = excluded.orientation,
            name_key = excluded.name_key,
            name_num = excluded.name_num,
            is_deleted = 0,
            -- a changed file needs re-probing/re-thumbnailing, not stale data
            metadata_state = CASE WHEN media.modified_time != excluded.modified_time
                                   THEN excluded.metadata_state ELSE media.metadata_state END,
            thumbnail_state = CASE WHEN media.modified_time != excluded.modified_time
                                    THEN 'pending' ELSE media.thumbnail_state END
         WHERE media.file_size != excluded.file_size
            OR media.modified_time != excluded.modified_time
            OR media.is_deleted != 0",
        params![
            f.rel_path,
            f.filename,
            f.extension,
            f.folder_rel_path,
            f.media_type,
            f.file_size,
            f.created_time,
            f.modified_time,
            now_ms,
            f.width,
            f.height,
            f.date_taken,
            f.gps_lat,
            f.gps_lon,
            f.camera_make,
            f.camera_model,
            f.orientation,
            metadata_state,
            name_key,
            name_num,
        ],
    )?;
    Ok(())
}

/// Marks every row not touched by the current scan (by rel_path set) as
/// deleted, so stale entries disappear from the library without a
/// separate diff pass in application code — SQLite does the set
/// difference. Renamed files will show up as one delete + one insert
/// until Phase 2's rename-matching heuristic lands (see MEDIA_PIPELINE.md).
pub fn mark_missing_as_deleted(pool: &Pool, seen_rel_paths: &[String]) -> anyhow::Result<usize> {
    let conn = pool.get()?;
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS _scan_seen (rel_path TEXT PRIMARY KEY)", [])?;
    conn.execute("DELETE FROM _scan_seen", [])?;
    {
        let mut stmt = conn.prepare("INSERT INTO _scan_seen (rel_path) VALUES (?1)")?;
        for p in seen_rel_paths {
            stmt.execute(params![p])?;
        }
    }
    let affected = conn.execute(
        "UPDATE media SET is_deleted = 1
         WHERE is_deleted = 0
           AND rel_path NOT IN (SELECT rel_path FROM _scan_seen)",
        [],
    )?;
    conn.execute("DROP TABLE _scan_seen", [])?;
    Ok(affected)
}

/// `(file_size, modified_time, is_deleted)` of just these files — what `known_file_stats` gives for
/// the whole library, for a live change that concerns a handful of paths.
pub fn file_stats_for(pool: &Pool, rel_paths: &[String]) -> anyhow::Result<HashMap<String, (i64, i64, bool)>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT file_size, modified_time, is_deleted FROM media WHERE rel_path = ?1")?;
    let mut out = HashMap::new();
    for rel in rel_paths {
        if let Ok(row) = stmt.query_row(params![rel], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)? != 0))) {
            out.insert(rel.clone(), row);
        }
    }
    Ok(out)
}

/// Whether the library has any file under this folder (so it isn't new to it).
pub fn folder_is_known(pool: &Pool, rel: &str) -> anyhow::Result<bool> {
    let conn = pool.get()?;
    let hit: Option<i64> = conn
        .query_row("SELECT 1 FROM media WHERE rel_path >= ?1 || '/' AND rel_path < ?1 || '0' LIMIT 1", params![rel], |r| r.get(0))
        .optional()?;
    Ok(hit.is_some())
}

/// Marks files gone: each path is a file, or a folder whose whole subtree went with it.
pub fn mark_deleted_paths(pool: &Pool, rel_paths: &[String]) -> anyhow::Result<usize> {
    let mut conn = pool.get()?;
    let tx = conn.transaction()?;
    let mut n = 0;
    {
        // two index lookups (the file itself, then everything under "rel/" as a key range — '0'
        // sorts right after '/'), not a scan of the whole table for every path
        let mut exact = tx.prepare("UPDATE media SET is_deleted = 1 WHERE rel_path = ?1 AND is_deleted = 0")?;
        let mut under = tx.prepare("UPDATE media SET is_deleted = 1 WHERE rel_path >= ?1 || '/' AND rel_path < ?1 || '0' AND is_deleted = 0")?;
        for rel in rel_paths {
            n += exact.execute(params![rel])?;
            n += under.execute(params![rel])?;
        }
    }
    tx.commit()?;
    Ok(n)
}

/// Rebuilds the `folders` materialized-tree table from the current
/// `media` rows. Parent/name/depth are derived from the '/'-joined
/// `folder_rel_path` string in Rust (not SQL string surgery) since that's
/// far less error-prone than replicating path-splitting in SQLite.
///
/// `media_count` is the *recursive* total (a folder's own files plus every
/// descendant's), and any folder whose recursive total is zero is left out
/// entirely — an empty folder (and an all-empty branch of the tree) never
/// appears in the sidebar, while an ancestor with media somewhere beneath
/// it still does, at its true total rather than a misleading direct count.
pub fn rebuild_folder_counts(pool: &Pool) -> anyhow::Result<()> {
    let conn = pool.get()?;

    let mut direct_counts: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT folder_rel_path, COUNT(*) FROM media WHERE is_deleted = 0 GROUP BY folder_rel_path",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (folder, count) = row?;
            direct_counts.insert(folder, count);
        }
    }

    fn ancestors_inclusive(folder: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut current = folder;
        loop {
            out.push(current.to_string());
            match current.rfind('/') {
                Some(idx) => current = &current[..idx],
                None => {
                    if !current.is_empty() {
                        out.push(String::new());
                    }
                    break;
                }
            }
        }
        out
    }

    // Every folder that contains media anywhere in its subtree gets a
    // recursive total: each leaf folder's direct count is added to itself
    // and every ancestor.
    let mut totals: HashMap<String, i64> = HashMap::new();
    for (folder, count) in &direct_counts {
        for ancestor in ancestors_inclusive(folder) {
            *totals.entry(ancestor).or_insert(0) += count;
        }
    }

    conn.execute("DELETE FROM folders", [])?;
    let mut stmt = conn.prepare(
        "INSERT INTO folders (rel_path, parent_rel_path, name, media_count, depth) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    let non_empty_folders: std::collections::BTreeSet<&String> =
        totals.iter().filter(|(_, &c)| c > 0).map(|(f, _)| f).collect();
    for folder in non_empty_folders {
        let (parent, name, depth) = if folder.is_empty() {
            (None, String::new(), 0)
        } else {
            match folder.rfind('/') {
                Some(idx) => (
                    Some(folder[..idx].to_string()),
                    folder[idx + 1..].to_string(),
                    folder.matches('/').count() as i64 + 1,
                ),
                None => (Some(String::new()), folder.clone(), 1),
            }
        };
        let media_count = totals.get(folder).copied().unwrap_or(0);
        stmt.execute(params![folder, parent, name, media_count, depth])?;
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaListItem {
    pub id: i64,
    pub rel_path: String,
    pub filename: String,
    pub extension: String,
    pub folder_rel_path: String,
    pub media_type: String,
    pub file_size: i64,
    pub created_time: i64,
    pub modified_time: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub thumbnail_state: String,
    pub metadata_state: String,
    pub favorite: bool,
    pub rating: i64,
    pub date_taken: Option<i64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MediaQuery {
    /// Folder scope: None = whole library.
    pub folder_rel_path: Option<String>,
    pub include_subfolders: bool,
    /// "all" | "photo" | "video" | "animated" | "other"
    pub media_type: String,
    pub sort_by: String,
    pub sort_desc: bool,
    pub limit: i64,
    pub offset: i64,

    /// Case-insensitive substring match against filename or relative path.
    pub search: Option<String>,
    pub duration_min_ms: Option<i64>,
    pub duration_max_ms: Option<i64>,
    pub size_min_bytes: Option<i64>,
    pub size_max_bytes: Option<i64>,
    pub modified_after: Option<i64>,
    pub modified_before: Option<i64>,
    pub favorites_only: bool,
    pub min_rating: Option<i64>,
    /// Restricts to videos in one of these metadata_state values, e.g.
    /// `["needs_deep_scan"]` or `["failed"]` for the "Metadata Errors" /
    /// "Unscanned" smart collections.
    pub metadata_states: Option<Vec<String>>,
    /// Restricts to media tagged with this exact tag name.
    pub tag: Option<String>,
    /// "landscape" | "portrait" | "square" — compares stored width/height,
    /// so rows without dimensions yet (unprobed video) never match.
    pub orientation: Option<String>,
}

impl Default for MediaQuery {
    fn default() -> Self {
        Self {
            folder_rel_path: None,
            include_subfolders: true,
            media_type: "all".to_string(),
            sort_by: "date_modified".to_string(),
            sort_desc: true,
            limit: 300,
            offset: 0,
            search: None,
            duration_min_ms: None,
            duration_max_ms: None,
            size_min_bytes: None,
            size_max_bytes: None,
            tag: None,
            orientation: None,
            modified_after: None,
            modified_before: None,
            favorites_only: false,
            min_rating: None,
            metadata_states: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaPage {
    pub items: Vec<MediaListItem>,
    pub total: i64,
}

fn sort_column(sort_by: &str) -> &'static str {
    match sort_by {
        "name" => "filename",
        "date_modified" => "modified_time",
        "date_created" => "created_time",
        // Timeline view (spec §21): photo capture date when known,
        // falling back to the file's own dates so undated files still
        // group sensibly instead of sorting as NULL-last outliers.
        "date_taken" => "COALESCE(date_taken, created_time, modified_time)",
        "duration" => "duration_ms",
        "size" => "file_size",
        "width" => "width",
        "height" => "height",
        _ => "modified_time",
    }
}

/// Builds `(where_sql, params)` for a `MediaQuery` using positional `?`
/// placeholders — simpler to keep correct than named params when the
/// number of active filters varies per call.
fn build_where(q: &MediaQuery) -> (String, Vec<rusqlite::types::Value>) {
    use rusqlite::types::Value;

    let mut clauses = vec!["is_deleted = 0".to_string()];
    let mut params: Vec<Value> = vec![];

    if let Some(folder) = &q.folder_rel_path {
        if q.include_subfolders {
            clauses.push("(folder_rel_path = ? OR folder_rel_path LIKE ? || '/%')".into());
            params.push(Value::Text(folder.clone()));
            params.push(Value::Text(folder.clone()));
        } else {
            clauses.push("folder_rel_path = ?".into());
            params.push(Value::Text(folder.clone()));
        }
    }
    if q.media_type != "all" {
        clauses.push("media_type = ?".into());
        params.push(Value::Text(q.media_type.clone()));
    }
    if let Some(search) = q.search.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        // words, "phrases", -exclusions, OR, wildcards and Explorer-style filters (db/search.rs)
        let c = super::search::compile(search, chrono::Local::now());
        clauses.extend(c.clauses);
        params.extend(c.params);
    }
    if let Some(v) = q.duration_min_ms {
        clauses.push("duration_ms >= ?".into());
        params.push(Value::Integer(v));
    }
    if let Some(v) = q.duration_max_ms {
        clauses.push("duration_ms <= ?".into());
        params.push(Value::Integer(v));
    }
    if let Some(v) = q.size_min_bytes {
        clauses.push("file_size >= ?".into());
        params.push(Value::Integer(v));
    }
    if let Some(v) = q.size_max_bytes {
        clauses.push("file_size <= ?".into());
        params.push(Value::Integer(v));
    }
    if let Some(v) = q.modified_after {
        clauses.push("modified_time >= ?".into());
        params.push(Value::Integer(v));
    }
    if let Some(v) = q.modified_before {
        clauses.push("modified_time <= ?".into());
        params.push(Value::Integer(v));
    }
    if q.favorites_only {
        clauses.push("favorite = 1".into());
    }
    if let Some(v) = q.min_rating {
        clauses.push("rating >= ?".into());
        params.push(Value::Integer(v));
    }
    if let Some(states) = &q.metadata_states {
        if !states.is_empty() {
            let placeholders = states.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            clauses.push(format!("metadata_state IN ({placeholders})"));
            for s in states {
                params.push(Value::Text(s.clone()));
            }
        }
    }
    if let Some(tag) = &q.tag {
        clauses.push(
            "id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?)".into(),
        );
        params.push(Value::Text(tag.clone()));
    }
    match q.orientation.as_deref() {
        Some("landscape") => clauses.push("width IS NOT NULL AND height IS NOT NULL AND width > height".into()),
        Some("portrait") => clauses.push("width IS NOT NULL AND height IS NOT NULL AND width < height".into()),
        Some("square") => clauses.push("width IS NOT NULL AND height IS NOT NULL AND width = height".into()),
        _ => {}
    }

    (clauses.join(" AND "), params)
}

/// `ORDER BY` body for a query's sort settings (see the notes inline).
fn order_clause(q: &MediaQuery) -> String {
    let col = sort_column(&q.sort_by);
    let dir = if q.sort_desc { "DESC" } else { "ASC" };
    // NULLs (unknown duration etc.) always sort last regardless of direction.
    // NOT NULL columns skip the `IS NULL` term: that expression made the sort
    // un-indexable, so every page load sorted the entire library. Plain
    // `col, id` lets SQLite walk the column's index and stop after LIMIT rows
    // (and `id` makes page boundaries stable when many rows tie).
    let nullable = matches!(col, "duration_ms" | "width" | "height") || col.starts_with("COALESCE");
    if q.sort_by == "similar_name" {
        // Files named alike sit together, each run in natural number order.
        format!("name_key {dir}, name_num {dir}, filename {dir}, id {dir}")
    } else if nullable {
        format!("{col} IS NULL, {col} {dir}, id {dir}")
    } else {
        format!("{col} {dir}, id {dir}")
    }
}

/// Zero-based position of `id` within the full ordered result of `q`, or
/// `None` if the item isn't part of it. Used to jump to the page that holds a
/// selected item after the sort order changed.
pub fn media_position(pool: &Pool, q: &MediaQuery, id: i64) -> anyhow::Result<Option<i64>> {
    let conn = pool.get()?;
    let (where_sql, mut params) = build_where(q);
    let order_sql = order_clause(q);
    let sql = format!(
        "SELECT rn FROM (
             SELECT id, ROW_NUMBER() OVER (ORDER BY {order_sql}) AS rn
             FROM media WHERE {where_sql}
         ) WHERE id = ?"
    );
    params.push(rusqlite::types::Value::Integer(id));
    let rn: Option<i64> = conn
        .query_row(&sql, rusqlite::params_from_iter(params.iter()), |r| r.get(0))
        .optional()?;
    Ok(rn.map(|n| n - 1))
}

/// The first of `ids` (in the order given) that is part of the result of `q`, with its 0-based
/// position — one pass over the result instead of one per candidate.
pub fn media_position_first(pool: &Pool, q: &MediaQuery, ids: &[i64]) -> anyhow::Result<Option<(i64, i64)>> {
    if ids.is_empty() {
        return Ok(None);
    }
    let conn = pool.get()?;
    let (where_sql, mut params) = build_where(q);
    let order_sql = order_clause(q);
    let marks = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT id, rn FROM (
             SELECT id, ROW_NUMBER() OVER (ORDER BY {order_sql}) AS rn
             FROM media WHERE {where_sql}
         ) WHERE id IN ({marks})"
    );
    params.extend(ids.iter().map(|i| rusqlite::types::Value::Integer(*i)));
    let mut stmt = conn.prepare(&sql)?;
    let found: HashMap<i64, i64> = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        .filter_map(Result::ok)
        .collect();
    Ok(ids.iter().find_map(|id| found.get(id).map(|rn| (*id, rn - 1))))
}

pub fn query_media(pool: &Pool, q: &MediaQuery) -> anyhow::Result<MediaPage> {
    let conn = pool.get()?;

    let (where_sql, params) = build_where(q);
    let order_sql = order_clause(q);

    let sql = format!(
        "SELECT id, rel_path, filename, extension, folder_rel_path, media_type,
                file_size, created_time, modified_time, width, height, duration_ms,
                thumbnail_state, metadata_state, favorite, rating,
                date_taken, camera_make, camera_model, gps_lat, gps_lon
         FROM media WHERE {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?"
    );
    let mut items_params = params.clone();
    items_params.push(rusqlite::types::Value::Integer(q.limit));
    items_params.push(rusqlite::types::Value::Integer(q.offset));

    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(items_params.iter()), |r| {
            Ok(MediaListItem {
                id: r.get(0)?,
                rel_path: r.get(1)?,
                filename: r.get(2)?,
                extension: r.get(3)?,
                folder_rel_path: r.get(4)?,
                media_type: r.get(5)?,
                file_size: r.get(6)?,
                created_time: r.get(7)?,
                modified_time: r.get(8)?,
                width: r.get(9)?,
                height: r.get(10)?,
                duration_ms: r.get(11)?,
                thumbnail_state: r.get(12)?,
                metadata_state: r.get(13)?,
                favorite: r.get::<_, i64>(14)? != 0,
                rating: r.get(15)?,
                date_taken: r.get(16)?,
                camera_make: r.get(17)?,
                camera_model: r.get(18)?,
                gps_lat: r.get(19)?,
                gps_lon: r.get(20)?,
            })
        })?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    let count_sql = format!("SELECT COUNT(*) FROM media WHERE {where_sql}");
    let mut count_stmt = conn.prepare(&count_sql)?;
    let total: i64 = count_stmt.query_row(rusqlite::params_from_iter(params.iter()), |r| r.get(0))?;

    Ok(MediaPage { items, total })
}

pub fn set_favorite(pool: &Pool, id: i64, favorite: bool) -> anyhow::Result<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media SET favorite = ?1 WHERE id = ?2",
        params![favorite as i64, id],
    )?;
    Ok(())
}

pub fn set_rating(pool: &Pool, id: i64, rating: i64) -> anyhow::Result<()> {
    let conn = pool.get()?;
    conn.execute("UPDATE media SET rating = ?1 WHERE id = ?2", params![rating, id])?;
    Ok(())
}

pub fn get_rel_path(pool: &Pool, id: i64) -> anyhow::Result<Option<String>> {
    let conn = pool.get()?;
    Ok(conn
        .query_row("SELECT rel_path FROM media WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?)
}

#[derive(Debug, Clone)]
pub struct ThumbLookup {
    pub rel_path: String,
    pub media_type: String,
    pub modified_time: i64,
    pub file_size: i64,
    pub duration_ms: Option<i64>,
    pub thumbnail_state: String,
}

pub fn get_thumb_lookup(pool: &Pool, id: i64) -> anyhow::Result<Option<ThumbLookup>> {
    let conn = pool.get()?;
    Ok(conn
        .query_row(
            "SELECT rel_path, media_type, modified_time, file_size, duration_ms, thumbnail_state
             FROM media WHERE id = ?1",
            params![id],
            |r| {
                Ok(ThumbLookup {
                    rel_path: r.get(0)?,
                    media_type: r.get(1)?,
                    modified_time: r.get(2)?,
                    file_size: r.get(3)?,
                    duration_ms: r.get(4)?,
                    thumbnail_state: r.get(5)?,
                })
            },
        )
        .optional()?)
}

/// Background workers record their outcome with `let _ = mark_*(...)`, so a
/// transient failure (SQLITE_BUSY on a slow disk / antivirus-locked DB, an
/// exhausted connection pool) used to leave the row `pending` for the rest
/// of the session even though the work itself had succeeded — the Dashboard
/// then said "In progress" forever. Retry a few times before giving up.
fn with_retry<T>(mut f: impl FnMut() -> anyhow::Result<T>) -> anyhow::Result<T> {
    let mut last = None;
    for attempt in 0..6u64 {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(150 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap())
}

pub fn mark_thumbnail_ready(pool: &Pool, id: i64, key: &str) -> anyhow::Result<()> {
    with_retry(|| {
        let conn = pool.get()?;
        conn.execute(
            "UPDATE media SET thumbnail_key = ?1, thumbnail_state = 'ready' WHERE id = ?2",
            params![key, id],
        )?;
        Ok(())
    })
}

/// A row whose path can no longer be resolved inside the root (moved out,
/// permissions, a bad name on this machine) can never be processed. Settle
/// it as failed so it doesn't count as pending forever; a rescan or the
/// per-item Retry actions bring it back if the file reappears.
pub fn mark_unprocessable(pool: &Pool, id: i64) -> anyhow::Result<()> {
    with_retry(|| {
        let conn = pool.get()?;
        conn.execute(
            "UPDATE media SET
                thumbnail_state = CASE WHEN thumbnail_state = 'pending' THEN 'failed' ELSE thumbnail_state END,
                metadata_state = CASE WHEN metadata_state IN ('pending', 'needs_deep_scan') THEN 'failed' ELSE metadata_state END
             WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

pub fn mark_thumbnail_failed(pool: &Pool, id: i64) -> anyhow::Result<()> {
    with_retry(|| {
        let conn = pool.get()?;
        conn.execute(
            "UPDATE media SET thumbnail_state = 'failed' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

/// A row queued for background thumbnail generation.
#[derive(Debug, Clone)]
pub struct ThumbCandidate {
    pub id: i64,
    pub rel_path: String,
    pub media_type: String,
    pub modified_time: i64,
    pub file_size: i64,
    pub duration_ms: Option<i64>,
}

pub fn list_thumbnail_candidates_after(
    pool: &Pool,
    after_id: i64,
    limit: i64,
) -> anyhow::Result<Vec<ThumbCandidate>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, rel_path, media_type, modified_time, file_size, duration_ms FROM media
         WHERE is_deleted = 0 AND thumbnail_state = 'pending'
           AND media_type IN ('photo', 'video', 'animated')
           AND id > ?1
         ORDER BY id ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![after_id, limit], |r| {
        Ok(ThumbCandidate {
            id: r.get(0)?,
            rel_path: r.get(1)?,
            media_type: r.get(2)?,
            modified_time: r.get(3)?,
            file_size: r.get(4)?,
            duration_ms: r.get(5)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// A video row still needing duration/codec metadata.
#[derive(Debug, Clone)]
pub struct MetadataCandidate {
    pub id: i64,
    pub rel_path: String,
    pub metadata_state: String,
}

pub fn list_metadata_candidates_after(
    pool: &Pool,
    after_id: i64,
    limit: i64,
) -> anyhow::Result<Vec<MetadataCandidate>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, rel_path, metadata_state FROM media
         WHERE is_deleted = 0
           AND media_type = 'video'
           AND id > ?1
           AND metadata_state != 'failed'
           AND (
                metadata_state IN ('pending', 'needs_deep_scan')
                OR duration_ms IS NULL
                OR duration_ms <= 0
           )
         ORDER BY id ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![after_id, limit], |r| {
        Ok(MetadataCandidate {
            id: r.get(0)?,
            rel_path: r.get(1)?,
            metadata_state: r.get(2)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Every folder the library already knows about — each distinct
/// `folder_rel_path` (deleted rows included: a folder that merely lost its
/// files isn't "new") plus all of its ancestors, so a folder that only
/// contains sub-folders isn't mistaken for a new one. The root ("") is
/// always known.
pub fn known_folder_paths(pool: &Pool) -> anyhow::Result<HashSet<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT DISTINCT folder_rel_path FROM media")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut known = HashSet::new();
    known.insert(String::new());
    for row in rows {
        let mut folder = row?;
        loop {
            if !known.insert(folder.clone()) && !folder.is_empty() {
                // Ancestors of an already-recorded folder are recorded too.
                break;
            }
            match folder.rsplit_once('/') {
                Some((parent, _)) => folder = parent.to_string(),
                None => break,
            }
        }
    }
    Ok(known)
}

/// Thumbnail work still pending inside one folder subtree (used to feed a
/// newly discovered folder to the queues ahead of the general backlog).
pub fn list_thumbnail_candidates_in_folder(pool: &Pool, folder: &str) -> anyhow::Result<Vec<ThumbCandidate>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, rel_path, media_type, modified_time, file_size, duration_ms FROM media
         WHERE is_deleted = 0 AND thumbnail_state = 'pending'
           AND media_type IN ('photo', 'video', 'animated')
           AND (folder_rel_path = ?1 OR substr(folder_rel_path, 1, length(?1) + 1) = ?1 || '/')
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![folder], |r| {
        Ok(ThumbCandidate {
            id: r.get(0)?,
            rel_path: r.get(1)?,
            media_type: r.get(2)?,
            modified_time: r.get(3)?,
            file_size: r.get(4)?,
            duration_ms: r.get(5)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Video metadata work still pending inside one folder subtree.
pub fn list_metadata_candidates_in_folder(pool: &Pool, folder: &str) -> anyhow::Result<Vec<MetadataCandidate>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT id, rel_path, metadata_state FROM media
         WHERE is_deleted = 0
           AND media_type = 'video'
           AND metadata_state != 'failed'
           AND (
                metadata_state IN ('pending', 'needs_deep_scan')
                OR duration_ms IS NULL
                OR duration_ms <= 0
           )
           AND (folder_rel_path = ?1 OR substr(folder_rel_path, 1, length(?1) + 1) = ?1 || '/')
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![folder], |r| {
        Ok(MetadataCandidate {
            id: r.get(0)?,
            rel_path: r.get(1)?,
            metadata_state: r.get(2)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[derive(Debug, Clone, Default)]
pub struct VideoMetadataUpdate {
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub container: Option<String>,
    pub pixel_format: Option<String>,
    pub has_audio: bool,
    pub rotation: Option<i64>,
    /// true when even the deep-scan fallback couldn't determine a
    /// duration — row stays visible with a "Needs deep scan"/error badge
    /// rather than ever recording 0.
    pub needs_deep_scan: bool,
}

pub fn apply_video_metadata(pool: &Pool, id: i64, m: &VideoMetadataUpdate) -> anyhow::Result<()> {
    with_retry(|| apply_video_metadata_once(pool, id, m))
}

fn apply_video_metadata_once(pool: &Pool, id: i64, m: &VideoMetadataUpdate) -> anyhow::Result<()> {
    let conn = pool.get()?;
    let state = if m.needs_deep_scan {
        "needs_deep_scan"
    } else {
        "ok"
    };
    conn.execute(
        "UPDATE media SET
            duration_ms = ?1, width = ?2, height = ?3, fps = ?4,
            video_codec = ?5, audio_codec = ?6, bitrate = ?7,
            sample_rate = ?8, channels = ?9, container = ?10, pixel_format = ?11,
            has_audio = ?12, rotation = ?13,
            metadata_state = ?14, metadata_attempts = metadata_attempts + 1
         WHERE id = ?15",
        params![
            m.duration_ms,
            m.width,
            m.height,
            m.fps,
            m.video_codec,
            m.audio_codec,
            m.bitrate,
            m.sample_rate,
            m.channels,
            m.container,
            m.pixel_format,
            m.has_audio as i64,
            m.rotation,
            state,
            id,
        ],
    )?;
    Ok(())
}

pub fn mark_metadata_failed(pool: &Pool, id: i64) -> anyhow::Result<()> {
    with_retry(|| {
        let conn = pool.get()?;
        conn.execute(
            "UPDATE media SET metadata_state = 'failed', metadata_attempts = metadata_attempts + 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

/// Persists the hand-off from the cheap header probe to the slow fallback
/// ladder. If the app exits here, the next launch resumes from this state.
pub fn mark_metadata_needs_deep_scan(pool: &Pool, id: i64) -> anyhow::Result<()> {
    with_retry(|| {
        let conn = pool.get()?;
        conn.execute(
            "UPDATE media SET duration_ms = NULL, metadata_state = 'needs_deep_scan' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

/// A resumed deep scan only owns duration/state; preserve codec/dimensions
/// already captured by the earlier fast pass instead of overwriting them.
pub fn apply_video_duration(pool: &Pool, id: i64, duration_ms: i64) -> anyhow::Result<()> {
    with_retry(|| {
        let conn = pool.get()?;
        conn.execute(
            "UPDATE media SET duration_ms = ?1, metadata_state = 'ok',
                metadata_attempts = metadata_attempts + 1
             WHERE id = ?2",
            params![duration_ms, id],
        )?;
        Ok(())
    })
}

/// Resets a row back to `pending` so it re-enters the metadata/thumbnail
/// queues — backs the "Retry metadata" / "Deep scan" / "Rebuild metadata"
/// actions from spec §3.
pub fn requeue_metadata(pool: &Pool, id: i64) -> anyhow::Result<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media SET metadata_state = 'pending' WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn requeue_thumbnail(pool: &Pool, id: i64) -> anyhow::Result<()> {
    let conn = pool.get()?;
    conn.execute(
        "UPDATE media SET thumbnail_state = 'pending' WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Updates the row after the underlying file was moved/renamed on disk.
/// Thumbnail cache key is path-derived, so a rename invalidates it — reset
/// to `pending` rather than leaving a cache entry keyed to the old path.
pub fn rename_media(pool: &Pool, id: i64, new_rel_path: &str) -> anyhow::Result<()> {
    let conn = pool.get()?;
    let filename = new_rel_path.rsplit('/').next().unwrap_or(new_rel_path).to_string();
    let extension = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let folder_rel_path = new_rel_path
        .rsplit_once('/')
        .map(|(f, _)| f.to_string())
        .unwrap_or_default();
    let (name_key, name_num) = similar_name_key(&filename);
    conn.execute(
        "UPDATE media SET rel_path = ?1, filename = ?2, extension = ?3, folder_rel_path = ?4,
            thumbnail_state = 'pending', thumbnail_key = NULL, name_key = ?6, name_num = ?7
         WHERE id = ?5",
        params![new_rel_path, filename, extension, folder_rel_path, id, name_key, name_num],
    )?;
    Ok(())
}

pub fn delete_media_row(pool: &Pool, id: i64) -> anyhow::Result<()> {
    let conn = pool.get()?;
    conn.execute("DELETE FROM media WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderNode {
    pub rel_path: String,
    pub parent_rel_path: Option<String>,
    pub name: String,
    pub media_count: i64,
    pub depth: i64,
}

pub fn list_folders(pool: &Pool) -> anyhow::Result<Vec<FolderNode>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT rel_path, parent_rel_path, name, media_count, depth
         FROM folders ORDER BY rel_path ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(FolderNode {
            rel_path: r.get(0)?,
            parent_rel_path: r.get(1)?,
            name: r.get(2)?,
            media_count: r.get(3)?,
            depth: r.get(4)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn library_stats(pool: &Pool) -> anyhow::Result<(i64, i64, i64, i64)> {
    // (total, photos, videos, total_size)
    let conn = pool.get()?;
    conn.query_row(
        "SELECT COUNT(*),
                SUM(CASE WHEN media_type = 'photo' THEN 1 ELSE 0 END),
                SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END),
                COALESCE(SUM(file_size), 0)
         FROM media WHERE is_deleted = 0",
        [],
        |r| {
            Ok((
                r.get(0)?,
                r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                r.get(3)?,
            ))
        },
    )
    .map_err(Into::into)
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardEntry {
    pub id: i64,
    pub filename: String,
    pub file_size: i64,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardStats {
    pub total: i64,
    pub photos: i64,
    pub videos: i64,
    pub total_size: i64,
    pub favorites: i64,
    pub pending_metadata: i64,
    pub pending_thumbnails: i64,
    pub longest_video: Option<DashboardEntry>,
    pub largest_files: Vec<DashboardEntry>,
    pub recently_added: Vec<DashboardEntry>,
    pub recently_modified: Vec<DashboardEntry>,
}

fn top_entries(pool: &Pool, order_by: &str, limit: i64) -> anyhow::Result<Vec<DashboardEntry>> {
    let conn = pool.get()?;
    let sql = format!(
        "SELECT id, filename, file_size, duration_ms FROM media
         WHERE is_deleted = 0 ORDER BY {order_by} DESC LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(DashboardEntry {
            id: r.get(0)?,
            filename: r.get(1)?,
            file_size: r.get(2)?,
            duration_ms: r.get(3)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Computes `name_key`/`name_num` for rows that predate the "similar names"
/// sort. Batched so it never holds the write lock for long; safe to run in
/// the background while the app is in use.
pub fn backfill_name_keys(pool: &Pool) -> anyhow::Result<usize> {
    let mut total = 0;
    loop {
        let rows: Vec<(i64, String)> = {
            let conn = pool.get()?;
            let mut stmt = conn.prepare("SELECT id, filename FROM media WHERE name_key IS NULL LIMIT 5000")?;
            let mapped = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            mapped.filter_map(Result::ok).collect()
        };
        if rows.is_empty() {
            return Ok(total);
        }
        let mut conn = pool.get()?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare("UPDATE media SET name_key = ?1, name_num = ?2 WHERE id = ?3")?;
            for (id, filename) in &rows {
                let (key, num) = similar_name_key(filename);
                stmt.execute(params![key, num, id])?;
            }
        }
        tx.commit()?;
        total += rows.len();
    }
}

/// Thumbnail lookups for many ids over one connection.
pub fn get_thumb_lookups(pool: &Pool, ids: &[i64]) -> anyhow::Result<Vec<(i64, Option<ThumbLookup>)>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare_cached(
        "SELECT rel_path, media_type, modified_time, file_size, duration_ms, thumbnail_state
         FROM media WHERE id = ?1",
    )?;
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        let lookup = stmt
            .query_row(params![id], |r| {
                Ok(ThumbLookup {
                    rel_path: r.get(0)?,
                    media_type: r.get(1)?,
                    modified_time: r.get(2)?,
                    file_size: r.get(3)?,
                    duration_ms: r.get(4)?,
                    thumbnail_state: r.get(5)?,
                })
            })
            .optional()?;
        out.push((id, lookup));
    }
    Ok(out)
}

pub fn pending_counts(pool: &Pool) -> anyhow::Result<(i64, i64)> {
    let conn = pool.get()?;
    let pending_metadata: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media WHERE is_deleted = 0 AND media_type = 'video'
         AND metadata_state IN ('pending', 'needs_deep_scan')",
        [],
        |r| r.get(0),
    )?;
    let pending_thumbnails: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media WHERE is_deleted = 0 AND thumbnail_state = 'pending'
         AND media_type IN ('photo', 'video', 'animated')",
        [],
        |r| r.get(0),
    )?;
    Ok((pending_metadata, pending_thumbnails))
}

/// `(file_size, modified_time, is_deleted)` for every known file, keyed by
/// rel_path. Lets the scanner skip files that haven't changed without
/// re-reading them (EXIF/dimensions) or writing anything.
pub fn known_file_stats(pool: &Pool) -> anyhow::Result<HashMap<String, (i64, i64, bool)>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT rel_path, file_size, modified_time, is_deleted FROM media")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)? != 0)))
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn dashboard_stats(pool: &Pool) -> anyhow::Result<DashboardStats> {
    let (total, photos, videos, total_size) = library_stats(pool)?;
    let conn = pool.get()?;

    let favorites: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media WHERE is_deleted = 0 AND favorite = 1",
        [],
        |r| r.get(0),
    )?;
    let pending_metadata: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media WHERE is_deleted = 0 AND media_type = 'video'
         AND metadata_state IN ('pending', 'needs_deep_scan')",
        [],
        |r| r.get(0),
    )?;
    let pending_thumbnails: i64 = conn.query_row(
        "SELECT COUNT(*) FROM media WHERE is_deleted = 0 AND thumbnail_state = 'pending'
         AND media_type IN ('photo', 'video', 'animated')",
        [],
        |r| r.get(0),
    )?;

    let longest_video = top_entries(pool, "duration_ms", 1)?.into_iter().next();

    Ok(DashboardStats {
        total,
        photos,
        videos,
        total_size,
        favorites,
        pending_metadata,
        pending_thumbnails,
        longest_video,
        largest_files: top_entries(pool, "file_size", 6)?,
        recently_added: top_entries(pool, "indexed_time", 6)?,
        recently_modified: top_entries(pool, "modified_time", 6)?,
    })
}

// ---------------------------------------------------------------------
// Tags (spec §19/27) — schema already existed; this is the query surface.
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TagWithCount {
    pub id: i64,
    pub name: String,
    pub count: i64,
}

pub fn list_all_tags(pool: &Pool) -> anyhow::Result<Vec<TagWithCount>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, COUNT(mt.media_id)
         FROM tags t
         LEFT JOIN media_tags mt ON mt.tag_id = t.id
         LEFT JOIN media m ON m.id = mt.media_id AND m.is_deleted = 0
         GROUP BY t.id, t.name
         ORDER BY t.name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagWithCount {
            id: r.get(0)?,
            name: r.get(1)?,
            count: r.get(2)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn list_tags_for_media(pool: &Pool, media_id: i64) -> anyhow::Result<Vec<String>> {
    let conn = pool.get()?;
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tags t
         JOIN media_tags mt ON mt.tag_id = t.id
         WHERE mt.media_id = ?1 ORDER BY t.name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map(params![media_id], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn normalize_tag(name: &str) -> String {
    name.trim().to_string()
}

pub fn add_tag(pool: &Pool, media_id: i64, tag_name: &str) -> anyhow::Result<()> {
    let name = normalize_tag(tag_name);
    if name.is_empty() {
        return Ok(());
    }
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO tags (name) VALUES (?1) ON CONFLICT(name) DO NOTHING",
        params![name],
    )?;
    let tag_id: i64 = conn.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO media_tags (media_id, tag_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
        params![media_id, tag_id],
    )?;
    Ok(())
}

pub fn remove_tag(pool: &Pool, media_id: i64, tag_name: &str) -> anyhow::Result<()> {
    let name = normalize_tag(tag_name);
    let conn = pool.get()?;
    conn.execute(
        "DELETE FROM media_tags WHERE media_id = ?1
         AND tag_id = (SELECT id FROM tags WHERE name = ?2)",
        params![media_id, name],
    )?;
    // Tidy up tags nothing references any more, so the tag list doesn't
    // accumulate orphans from renames/typos.
    conn.execute(
        "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM media_tags)",
        [],
    )?;
    Ok(())
}
