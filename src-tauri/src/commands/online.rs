use std::process::Stdio;

use tauri::{AppHandle, State};

use crate::online::download::{self, DownloadRequest, DownloadTask};
use crate::online::resolve::{self, PlayInfo, PrepareRequest};
use crate::online::server;
use crate::state::AppState;

/// Resolves a link (or a sniffed media URL) to something the player can play.
#[tauri::command]
pub async fn online_prepare(req: PrepareRequest) -> Result<PlayInfo, String> {
    resolve::prepare(req).await
}

/// The player is done with this session.
#[tauri::command(async)]
pub fn online_forget(id: String) {
    server::forget(&id);
}

/// Where downloads go by default: `<open library>/Downloads`, so they show up
/// in the gallery right away; otherwise the user's Downloads folder.
#[tauri::command(async)]
pub fn default_download_dir(_state: State<AppState>) -> String {
    // inside the data folder, like everything else (the user can still pick any folder)
    crate::paths::downloads_dir().to_string_lossy().to_string()
}

#[tauri::command(async)]
pub fn download_start(app: AppHandle, req: DownloadRequest) -> Result<String, String> {
    download::start(app, req)
}

#[tauri::command(async)]
pub fn download_list() -> Vec<DownloadTask> {
    download::list()
}

#[tauri::command(async)]
pub fn download_cancel(id: String) {
    download::cancel(&id);
}

#[tauri::command(async)]
pub fn download_remove(app: AppHandle, id: String) {
    download::remove(&app, &id);
}

#[tauri::command(async)]
pub fn download_clear_finished(app: AppHandle) {
    download::clear_finished(&app);
}

/// Opens Explorer with the downloaded file selected.
#[tauri::command(async)]
pub fn download_reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct EngineInfo {
    pub ytdlp: String,
    pub ffmpeg: String,
}

async fn version_of(cmd: std::path::PathBuf, arg: &str) -> String {
    let mut c = tokio::process::Command::new(cmd);
    c.arg(arg).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    match c.output().await {
        Ok(o) => String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string(),
        Err(_) => String::new(),
    }
}

#[tauri::command]
pub async fn engine_info() -> EngineInfo {
    let ytdlp = version_of(crate::tools::ytdlp(), "--version").await;
    let ffmpeg = version_of(crate::tools::ffmpeg(), "-version").await;
    EngineInfo {
        ytdlp,
        ffmpeg: ffmpeg.split_whitespace().nth(2).unwrap_or("").to_string(),
    }
}

/// Sites change; yt-dlp updates itself in place (`yt-dlp -U`) — this is the
/// "Update video engine" button.
#[tauri::command]
pub async fn engine_update() -> Result<String, String> {
    let mut c = tokio::process::Command::new(crate::tools::ytdlp());
    c.args(crate::tools::ytdlp_cache_args()).arg("-U").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(std::time::Duration::from_secs(120), c.output())
        .await
        .map_err(|_| "the update took too long".to_string())?
        .map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let line = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
    if out.status.success() {
        Ok(line)
    } else {
        Err(line)
    }
}

/// Lets the user choose where downloads go (native folder dialog).
#[tauri::command]
pub async fn pick_download_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked.map(|p| p.to_string()))
}
