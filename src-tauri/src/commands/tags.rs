use tauri::State;

use crate::db::queries;
use crate::state::AppState;

fn pool(state: &State<AppState>) -> Result<crate::db::Pool, String> {
    let current = state.current.lock().unwrap();
    Ok(current.as_ref().ok_or("no root open")?.pool.clone())
}

#[tauri::command(async)]
pub fn list_all_tags(state: State<AppState>) -> Result<Vec<queries::TagWithCount>, String> {
    queries::list_all_tags(&pool(&state)?).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn list_tags_for_media(state: State<AppState>, id: i64) -> Result<Vec<String>, String> {
    queries::list_tags_for_media(&pool(&state)?, id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn add_tag(state: State<AppState>, id: i64, tag: String) -> Result<(), String> {
    queries::add_tag(&pool(&state)?, id, &tag).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn remove_tag(state: State<AppState>, id: i64, tag: String) -> Result<(), String> {
    queries::remove_tag(&pool(&state)?, id, &tag).map_err(|e| e.to_string())
}
