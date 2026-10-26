use tauri::{AppHandle, State};

use crate::db::queries;
use crate::state::AppState;
use crate::thumbnails;
use crate::transcode;

/// Called only when the WebView2 `<video>` element failed to play a file
/// natively. Produces (and caches) a browser-playable MP4 via FFmpeg —
/// remux first, transcode as the fallback — and returns its path.
#[tauri::command]
pub async fn prepare_video_playback(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<String, String> {
    let (pool, root, root_id) = {
        let current = state.current.lock().unwrap();
        let ctx = current.as_ref().ok_or("no root open")?;
        (ctx.pool.clone(), ctx.root.clone(), ctx.id.clone())
    };

    let lookup = queries::get_thumb_lookup(&pool, id)
        .map_err(|e| e.to_string())?
        .ok_or("not found")?;
    let abs_path = root.resolve(&lookup.rel_path).map_err(|e| e.to_string())?;
    let key = thumbnails::cache_key(&lookup.rel_path, lookup.modified_time, lookup.file_size);
    let cache_dir = state.playcache_dir(&root_id);

    let out = transcode::ensure_playable(&app, &abs_path, &cache_dir, &key)
        .await
        .map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}
