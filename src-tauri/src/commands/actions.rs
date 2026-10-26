use serde::Serialize;
use tauri::State;

use crate::db::queries;
use crate::state::AppState;

struct RootHandle {
    pool: crate::db::Pool,
    root: crate::fs_sandbox::GalleryRoot,
}

fn root_handle(state: &State<AppState>) -> Result<RootHandle, String> {
    let current = state.current.lock().unwrap();
    let ctx = current.as_ref().ok_or("no root open")?;
    Ok(RootHandle {
        pool: ctx.pool.clone(),
        root: ctx.root.clone(),
    })
}

/// Resolves a media row to its absolute, sandbox-validated path — used by
/// the viewer/player to load the *original* file (not a thumbnail).
#[tauri::command(async)]
pub fn get_media_file_path(state: State<AppState>, id: i64) -> Result<String, String> {
    let h = root_handle(&state)?;
    let rel_path = queries::get_rel_path(&h.pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
    let abs = h.root.resolve(&rel_path).map_err(|e| e.to_string())?;
    Ok(abs.to_string_lossy().to_string())
}

/// Where playback of this video stopped last time (ms; 0 = from the start).
#[tauri::command(async)]
pub fn get_playback_position(state: State<AppState>, id: i64) -> Result<i64, String> {
    let h = root_handle(&state)?;
    let conn = h.pool.get().map_err(|e| e.to_string())?;
    conn.query_row("SELECT playback_position_ms FROM media WHERE id = ?1", [id], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}

/// Remembers where playback of this video is (ms).
#[tauri::command(async)]
pub fn set_playback_position(state: State<AppState>, id: i64, ms: i64) -> Result<(), String> {
    let h = root_handle(&state)?;
    let conn = h.pool.get().map_err(|e| e.to_string())?;
    conn.execute("UPDATE media SET playback_position_ms = ?1 WHERE id = ?2", rusqlite::params![ms.max(0), id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// A local http URL the player streams this file from (byte ranges, so seeking is quick).
#[tauri::command]
pub async fn get_media_stream_url(state: State<'_, AppState>, id: i64) -> Result<String, String> {
    let path = {
        let h = root_handle(&state)?;
        let rel_path = queries::get_rel_path(&h.pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
        h.root.resolve(&rel_path).map_err(|e| e.to_string())?
    };
    crate::online::server::local_file_url(path).await
}

/// Absolute paths for several media ids at once (for "Copy Path" and friends);
/// `None` where the file no longer exists / can't be resolved.
#[tauri::command(async)]
pub fn get_media_file_paths(state: State<AppState>, ids: Vec<i64>) -> Result<Vec<(i64, Option<String>)>, String> {
    let h = root_handle(&state)?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let path = queries::get_rel_path(&h.pool, id)
            .ok()
            .flatten()
            .and_then(|rel| h.root.resolve(&rel).ok())
            .map(|abs| abs.to_string_lossy().to_string());
        out.push((id, path));
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchResult {
    pub succeeded: Vec<i64>,
    pub failed: Vec<i64>,
}

/// Moves each id's file to the Windows Recycle Bin (default per spec §17)
/// and removes its row — never a bare filesystem delete.
#[tauri::command(async)]
pub fn delete_media(state: State<AppState>, ids: Vec<i64>) -> Result<BatchResult, String> {
    let h = root_handle(&state)?;
    let mut result = BatchResult {
        succeeded: vec![],
        failed: vec![],
    };
    for id in ids {
        let outcome: anyhow::Result<()> = (|| {
            let rel_path = queries::get_rel_path(&h.pool, id)?.ok_or_else(|| anyhow::anyhow!("not found"))?;
            let abs = h.root.resolve(&rel_path)?;
            trash::delete(&abs)?;
            queries::delete_media_row(&h.pool, id)?;
            Ok(())
        })();
        if outcome.is_ok() {
            result.succeeded.push(id);
        } else {
            result.failed.push(id);
        }
    }
    queries::rebuild_folder_counts(&h.pool).ok();
    Ok(result)
}

#[tauri::command(async)]
pub fn rename_media(state: State<AppState>, id: i64, new_name: String) -> Result<(), String> {
    if new_name.is_empty() || new_name.contains(['/', '\\']) {
        return Err("invalid filename".into());
    }
    let h = root_handle(&state)?;
    let rel_path = queries::get_rel_path(&h.pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
    let old_abs = h.root.resolve(&rel_path).map_err(|e| e.to_string())?;
    let new_abs = old_abs.with_file_name(&new_name);

    // Validate the destination stays inside the root even though it
    // doesn't exist yet (resolve_for_write walks up to the nearest
    // existing ancestor and checks that instead).
    h.root.resolve_for_write(&new_abs).map_err(|e| e.to_string())?;

    std::fs::rename(&old_abs, &new_abs).map_err(|e| e.to_string())?;

    let new_rel_path = h.root.relativize(&new_abs).ok_or("rename escaped root")?;
    queries::rename_media(&h.pool, id, &new_rel_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn set_favorite_batch(state: State<AppState>, ids: Vec<i64>, favorite: bool) -> Result<(), String> {
    let h = root_handle(&state)?;
    for id in ids {
        queries::set_favorite(&h.pool, id, favorite).map_err(|e| e.to_string())?;
    }
    Ok(())
}
