//! Studio (the CapCut-style editor): projects, file info, rendering.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::editor::studio::{self, Project};
use crate::editor::{self, runner, EditProgress};
use crate::state::AppState;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[tauri::command(async)]
pub fn studio_list() -> Vec<Project> {
    studio::list(&studio::projects_dir())
}

#[tauri::command(async)]
pub fn studio_load(id: String) -> Result<Project, String> {
    studio::load(&studio::projects_dir(), &id)
}

/// Saves (a new project gets an id); returns what was saved.
#[tauri::command(async)]
pub fn studio_save(mut project: Project) -> Result<Project, String> {
    if project.id.is_empty() {
        project.id = uuid::Uuid::new_v4().simple().to_string();
        project.created_at = now_ms();
    }
    project.updated_at = now_ms();
    studio::save(&studio::projects_dir(), &project)?;
    Ok(project)
}

#[tauri::command(async)]
pub fn studio_delete(id: String) -> Result<(), String> {
    studio::delete(&studio::projects_dir(), &id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub duration_ms: Option<i64>,
    pub has_audio: bool,
    pub has_video: bool,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// Length / tracks of any file (music picked from disk, or a library file).
#[tauri::command]
pub async fn studio_file_info(path: String) -> Result<FileInfo, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("file not found".into());
    }
    let out = tokio::process::Command::new(crate::tools::ffprobe())
        .args(["-v", "error", "-print_format", "json", "-show_streams", "-show_format"])
        .arg(&p)
        .creation_flags(0x0800_0000)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| "this file can't be read".to_string())?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let duration_ms = v["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).map(|d| (d * 1000.0) as i64);
    Ok(FileInfo {
        name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        path,
        duration_ms,
        has_audio: streams.iter().any(|s| s["codec_type"] == "audio"),
        has_video: video.is_some(),
        width: video.and_then(|s| s["width"].as_i64()),
        height: video.and_then(|s| s["height"].as_i64()),
    })
}

/// Files picked from disk: "audio" (music) or "media" (videos / photos), with their info.
#[tauri::command]
pub async fn studio_pick_files(app: AppHandle, kind: String) -> Result<Vec<FileInfo>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (label, exts): (&str, &[&str]) = if kind == "audio" {
        ("Audio", &["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma", "mp4", "mkv", "webm", "mov"])
    } else {
        ("Videos and photos", &["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv", "ts", "jpg", "jpeg", "png", "webp", "bmp", "gif", "heic"])
    };
    let picked = app.dialog().file().add_filter(label, exts).blocking_pick_files().unwrap_or_default();
    let mut out = vec![];
    for p in picked {
        if let Ok(path) = p.into_path() {
            if let Ok(info) = studio_file_info(path.to_string_lossy().to_string()).await {
                out.push(info);
            }
        }
    }
    Ok(out)
}

/// A local http URL the Studio preview streams any file from (music, files picked from disk).
#[tauri::command]
pub async fn studio_stream_url(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("file not found".into());
    }
    crate::online::server::local_file_url(p).await
}

/// Where a render goes: a "Quin Studio" folder in the open library (so it shows up there), or
/// the data folder when no library is open. Never overwrites.
fn output_path(state: &State<AppState>, name: &str) -> PathBuf {
    let dir = state
        .current
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.root.canonical_path().join("Quin Studio"))
        .unwrap_or_else(|| crate::paths::data_dir().join("exports"));
    let _ = std::fs::create_dir_all(&dir);
    let clean: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let stem = if clean.trim().is_empty() { "project".to_string() } else { clean.trim().to_string() };
    let mut p = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}).mp4"));
        n += 1;
    }
    p
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioJob {
    pub job_id: String,
    pub output_path: String,
}

/// Renders the project. Progress / completion arrive as `edit://progress` / `edit://done`;
/// `cancel_edit_job` stops it.
#[tauri::command]
pub fn studio_export(app: AppHandle, state: State<AppState>, project: Project) -> Result<StudioJob, String> {
    let final_output = output_path(&state, &project.name);
    let job_id = uuid::Uuid::new_v4().to_string();
    let tmp_dir = state.edit_temp_dir();
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let tmp_output = tmp_dir.join(format!("{job_id}.tmp.mp4"));
    let (font, font_bold) = studio::default_fonts();
    let env = studio::RenderEnv { tmp_dir: &tmp_dir, job_id: &job_id, font, font_bold };
    let (steps, scratch) = studio::plan(&project, &tmp_output, &env)?;

    let cancel = runner::new_cancel();
    let registry = state.edit_jobs.clone();
    registry.lock().unwrap().insert(job_id.clone(), cancel.clone());
    let (jid, out) = (job_id.clone(), final_output.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = crate::tools::ffmpeg();
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut progress = |pct: f64| {
            if pct >= 99.9 || last.elapsed() >= Duration::from_millis(150) {
                last = Instant::now();
                let _ = app.emit("edit://progress", EditProgress { job_id: jid.clone(), percent: pct.clamp(0.0, 100.0) });
            }
        };
        let result = runner::run_steps(&ffmpeg, &steps, &mut progress, &cancel);
        registry.lock().unwrap().remove(&jid);
        for f in scratch {
            let _ = std::fs::remove_file(f);
        }
        match result.and_then(|_| editor::move_into_place(&tmp_output, &out).map_err(|e| e.to_string())) {
            Ok(()) => editor::emit_done(&app, &jid, true, Some(out.to_string_lossy().to_string()), None),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_output);
                editor::emit_done(&app, &jid, false, None, Some(e));
            }
        }
    });
    Ok(StudioJob { job_id, output_path: final_output.to_string_lossy().to_string() })
}

trait NoWindow {
    fn creation_flags(&mut self, f: u32) -> &mut Self;
}
#[cfg(not(windows))]
impl NoWindow for tokio::process::Command {
    fn creation_flags(&mut self, _f: u32) -> &mut Self {
        self
    }
}
