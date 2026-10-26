use serde::Serialize;
use tauri::State;

use crate::db::queries::{self, FolderNode, MediaPage, MediaQuery};
use crate::state::AppState;
use crate::thumbnails::{self, queue::ThumbJob};

struct RootHandle {
    pool: crate::db::Pool,
    root: crate::fs_sandbox::GalleryRoot,
    root_id: String,
}

fn root_handle(state: &State<AppState>) -> Result<RootHandle, String> {
    let current = state.current.lock().unwrap();
    let ctx = current.as_ref().ok_or("no root open")?;
    Ok(RootHandle {
        pool: ctx.pool.clone(),
        root: ctx.root.clone(),
        root_id: ctx.id.clone(),
    })
}

#[tauri::command(async)]
pub fn get_media_page(state: State<AppState>, query: MediaQuery) -> Result<MediaPage, String> {
    let h = root_handle(&state)?;
    if query.search.as_deref().is_some_and(|s| !s.trim().is_empty()) {
        crate::db::search::backfill_in_background(&h.pool);
    }
    queries::query_media(&h.pool, &query).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchSuggest {
    /// how the search text was understood
    pub chips: Vec<crate::db::search::Chip>,
    /// the first few matches
    pub items: Vec<crate::db::queries::MediaListItem>,
    pub total: i64,
}

/// For the search box's drop-down: how the text reads, the first matches and how many there are.
#[tauri::command(async)]
pub fn search_suggest(state: State<AppState>, mut query: MediaQuery, limit: Option<i64>) -> Result<SearchSuggest, String> {
    let h = root_handle(&state)?;
    let text = query.search.clone().unwrap_or_default();
    crate::db::search::backfill_in_background(&h.pool);
    query.limit = limit.unwrap_or(8).clamp(1, 50);
    query.offset = 0;
    let page = queries::query_media(&h.pool, &query).map_err(|e| e.to_string())?;
    Ok(SearchSuggest { chips: crate::db::search::compile(&text, chrono::Local::now()).chips, items: page.items, total: page.total })
}

/// The first of `ids` still in the result of `query`, and where it lands (0-based): how the grid
/// keeps its place when a filter, folder or sort changes.
#[tauri::command(async)]
pub fn get_media_position_first(state: State<AppState>, query: MediaQuery, ids: Vec<i64>) -> Result<Option<(i64, i64)>, String> {
    let h = root_handle(&state)?;
    queries::media_position_first(&h.pool, &query, &ids).map_err(|e| e.to_string())
}

/// Where `id` lands in the ordered result of `query` (0-based), so the grid
/// can open the right page after a re-sort.
#[tauri::command(async)]
pub fn get_media_position(state: State<AppState>, query: MediaQuery, id: i64) -> Result<Option<i64>, String> {
    let h = root_handle(&state)?;
    queries::media_position(&h.pool, &query, id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_folders(state: State<AppState>) -> Result<Vec<FolderNode>, String> {
    let h = root_handle(&state)?;
    queries::list_folders(&h.pool).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn set_favorite(state: State<AppState>, id: i64, favorite: bool) -> Result<(), String> {
    let h = root_handle(&state)?;
    queries::set_favorite(&h.pool, id, favorite).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn set_rating(state: State<AppState>, id: i64, rating: i64) -> Result<(), String> {
    let h = root_handle(&state)?;
    queries::set_rating(&h.pool, id, rating).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryStats {
    pub total: i64,
    pub photos: i64,
    pub videos: i64,
    pub total_size: i64,
}

#[tauri::command(async)]
pub fn get_library_stats(state: State<AppState>) -> Result<LibraryStats, String> {
    let h = root_handle(&state)?;
    let (total, photos, videos, total_size) = queries::library_stats(&h.pool).map_err(|e| e.to_string())?;
    Ok(LibraryStats {
        total,
        photos,
        videos,
        total_size,
    })
}

/// Cheap poll for the Dashboard's "In progress" indicator: two indexed
/// counts, instead of re-running every dashboard aggregate every 2 seconds.
#[tauri::command(async)]
pub fn get_pending_counts(state: State<AppState>) -> Result<(i64, i64), String> {
    let h = root_handle(&state)?;
    queries::pending_counts(&h.pool).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_dashboard_stats(state: State<AppState>) -> Result<queries::DashboardStats, String> {
    let h = root_handle(&state)?;
    queries::dashboard_stats(&h.pool).map_err(|e| e.to_string())
}

/// Fast-pathed thumbnail lookup: if it's already on disk, returns the path
/// immediately (no decode). Otherwise it enqueues a high-priority
/// generation job on the shared `ThumbnailQueue` and returns `None` right
/// away — the frontend picks the result up via the `thumbnail://ready`
/// event rather than blocking this call on a decode/ffmpeg-frame-grab.
/// This is what makes browsing feel fast even before a folder's
/// thumbnails are fully warmed.
/// Shared by the single and batch commands: the cached thumbnail's path if
/// it exists, otherwise queue generation and answer `None` for now.
fn thumbnail_or_enqueue(
    state: &State<AppState>,
    h: &RootHandle,
    id: i64,
    lookup: queries::ThumbLookup,
) -> Result<Option<String>, String> {
    if lookup.thumbnail_state == "failed" || !matches!(lookup.media_type.as_str(), "photo" | "video" | "animated") {
        return Ok(None);
    }

    let key = thumbnails::cache_key(&lookup.rel_path, lookup.modified_time, lookup.file_size);
    let cache_dir = state.thumbcache_dir(&h.root_id);
    let out_path = thumbnails::thumbnail_path(&cache_dir, &key);

    // Already cached: answer from the key alone. Resolving the source path
    // (exists + canonicalize) costs several syscalls per item and a page asks
    // for ~120 of them at once — needless when nothing has to be generated.
    if out_path.exists() {
        return Ok(Some(out_path.to_string_lossy().to_string()));
    }

    let abs_path = h.root.resolve(&lookup.rel_path).map_err(|e| e.to_string())?;

    state.thumbnail_queue.request(ThumbJob {
        media_id: id,
        abs_path,
        media_type: lookup.media_type,
        cache_dir,
        key,
        duration_ms: lookup.duration_ms,
        pool: h.pool.clone(),
    });
    Ok(None)
}

#[tauri::command(async)]
pub fn get_thumbnail_path(state: State<AppState>, id: i64) -> Result<Option<String>, String> {
    let h = root_handle(&state)?;
    let Some(lookup) = queries::get_thumb_lookup(&h.pool, id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    thumbnail_or_enqueue(&state, &h, id, lookup)
}

/// Batch form of `get_thumbnail_path`: a page of the grid asks for all of its
/// thumbnails in one round trip instead of ~120 separate IPC calls. One entry
/// per requested id, in order; `None` = not ready (generation queued).
#[tauri::command(async)]
pub fn get_thumbnail_paths(state: State<AppState>, ids: Vec<i64>) -> Result<Vec<(i64, Option<String>)>, String> {
    let h = root_handle(&state)?;
    let lookups = queries::get_thumb_lookups(&h.pool, &ids).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(lookups.len());
    for (id, lookup) in lookups {
        let path = match lookup {
            Some(l) => thumbnail_or_enqueue(&state, &h, id, l).unwrap_or(None),
            None => None,
        };
        out.push((id, path));
    }
    Ok(out)
}

/// Resets a row to `pending` so it re-enters the metadata queue on the
/// next sweep/retry action (spec §3: "Retry metadata"). `Deep scan` and
/// `Rebuild metadata` in the UI both call this — the queue itself always
/// runs the full layered ladder, so there's no separate "shallow vs deep"
/// entry point to expose.
#[tauri::command(async)]
pub fn retry_metadata(state: State<AppState>, id: i64) -> Result<(), String> {
    let h = root_handle(&state)?;
    queries::requeue_metadata(&h.pool, id).map_err(|e| e.to_string())?;
    let rel_path = queries::get_rel_path(&h.pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
    let abs_path = h.root.resolve(&rel_path).map_err(|e| e.to_string())?;
    state.metadata_queue.enqueue(crate::metadata::queue::MetadataJob {
        media_id: id,
        abs_path,
        pool: h.pool,
        deep_only: false,
    });
    Ok(())
}

#[tauri::command(async)]
pub fn retry_thumbnail(state: State<AppState>, id: i64) -> Result<(), String> {
    let h = root_handle(&state)?;
    queries::requeue_thumbnail(&h.pool, id).map_err(|e| e.to_string())
}
