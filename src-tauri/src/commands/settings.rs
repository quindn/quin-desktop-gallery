use serde::Serialize;
use tauri::State;

use crate::state::AppState;

fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
        .sum()
}

#[derive(Debug, Clone, Serialize)]
pub struct CacheStats {
    pub thumbnail_bytes: u64,
    pub playback_bytes: u64,
}

#[tauri::command(async)]
pub fn get_cache_stats(state: State<AppState>) -> Result<CacheStats, String> {
    let root_id = {
        let current = state.current.lock().unwrap();
        current.as_ref().ok_or("no root open")?.id.clone()
    };
    Ok(CacheStats {
        thumbnail_bytes: dir_size(&state.thumbcache_dir(&root_id)),
        playback_bytes: dir_size(&state.playcache_dir(&root_id)),
    })
}

#[tauri::command(async)]
pub fn clear_thumbnail_cache(state: State<AppState>) -> Result<(), String> {
    let (pool, root_id) = {
        let current = state.current.lock().unwrap();
        let ctx = current.as_ref().ok_or("no root open")?;
        (ctx.pool.clone(), ctx.id.clone())
    };
    let dir = state.thumbcache_dir(&root_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE media SET thumbnail_state = 'pending', thumbnail_key = NULL WHERE thumbnail_state != 'pending'",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn clear_playback_cache(state: State<AppState>) -> Result<(), String> {
    let root_id = {
        let current = state.current.lock().unwrap();
        current.as_ref().ok_or("no root open")?.id.clone()
    };
    let dir = state.playcache_dir(&root_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
