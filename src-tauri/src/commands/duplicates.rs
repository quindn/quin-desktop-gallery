use tauri::{AppHandle, Emitter, State};

use crate::duplicates::run_duplicate_scan;
use crate::state::AppState;

/// Fire-and-forget: runs the (potentially slow, content-hashing) scan on a
/// background thread and reports results via `duplicates://progress` /
/// `duplicates://result` events rather than blocking this call.
#[tauri::command(async)]
pub fn find_duplicates(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let (root, pool) = {
        let current = state.current.lock().unwrap();
        let ctx = current.as_ref().ok_or("no root open")?;
        (ctx.root.clone(), ctx.pool.clone())
    };
    std::thread::spawn(move || match run_duplicate_scan(&app, &root, &pool) {
        Ok(groups) => {
            let _ = app.emit("duplicates://result", groups);
        }
        Err(e) => {
            let _ = app.emit("duplicates://error", e.to_string());
        }
    });
    Ok(())
}
