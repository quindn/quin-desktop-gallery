//! AI enhancement (smoother motion / sharper picture): tool status, download, jobs.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::ai::{self, Options, SourceInfo};
use crate::db::queries;
use crate::editor::{self, runner, EditProgress};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub rife: bool,
    pub esrgan: bool,
    /// the Vulkan graphics card, when one works
    pub gpu: Option<String>,
}

#[tauri::command]
pub async fn ai_status() -> AiStatus {
    tauri::async_runtime::spawn_blocking(|| AiStatus { rife: ai::installed("rife"), esrgan: ai::installed("esrgan"), gpu: ai::gpu() })
        .await
        .unwrap_or(AiStatus { rife: false, esrgan: false, gpu: None })
}

/// Downloads "rife" or "esrgan" (progress: `ai://install`).
#[tauri::command]
pub async fn ai_install(app: AppHandle, tool: String) -> Result<AiStatus, String> {
    if tool != "rife" && tool != "esrgan" {
        return Err("unknown tool".into());
    }
    let last = std::sync::Mutex::new(Instant::now() - Duration::from_secs(1));
    ai::install(&tool, |p| {
        let mut l = last.lock().unwrap();
        if p.done >= p.total || l.elapsed() >= Duration::from_millis(150) {
            *l = Instant::now();
            let _ = app.emit("ai://install", p);
        }
    })
    .await?;
    Ok(ai_status().await)
}

fn media_path(state: &State<AppState>, id: i64) -> Result<std::path::PathBuf, String> {
    let current = state.current.lock().unwrap();
    let ctx = current.as_ref().ok_or("no library open")?;
    let rel = queries::get_rel_path(&ctx.pool, id).map_err(|e| e.to_string())?.ok_or("file not found")?;
    ctx.root.resolve(&rel).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_source_info(state: State<'_, AppState>, id: i64) -> Result<SourceInfo, String> {
    let path = media_path(&state, id)?;
    tauri::async_runtime::spawn_blocking(move || ai::probe(&path)).await.map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJob {
    pub job_id: String,
    pub output_path: String,
}

/// Starts a job; progress / completion come as `edit://progress` / `edit://done`, `cancel_edit_job` stops it.
#[tauri::command]
pub fn ai_enhance(app: AppHandle, state: State<AppState>, id: i64, options: Options) -> Result<AiJob, String> {
    let src = media_path(&state, id)?;
    let info = ai::probe(&src)?;
    let out = ai::output_path(&src, &info, &options);
    let job_id = uuid::Uuid::new_v4().to_string();
    let tmp_root = state.edit_temp_dir();
    let tmp = tmp_root.join(format!("ai-{job_id}"));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let tmp_out = tmp_root.join(format!("{job_id}.ai.mp4"));
    let cancel = runner::new_cancel();
    let registry = state.edit_jobs.clone();
    registry.lock().unwrap().insert(job_id.clone(), cancel.clone());
    let (jid, final_out) = (job_id.clone(), out.clone());
    std::thread::spawn(move || {
        let mut last = Instant::now() - Duration::from_secs(1);
        let result = ai::run(&src, &tmp_out, &tmp, &options, &cancel, |pct| {
            if pct >= 99.9 || last.elapsed() >= Duration::from_millis(250) {
                last = Instant::now();
                let _ = app.emit("edit://progress", EditProgress { job_id: jid.clone(), percent: pct });
            }
        });
        registry.lock().unwrap().remove(&jid);
        match result.and_then(|_| editor::move_into_place(&tmp_out, &final_out).map_err(|e| e.to_string())) {
            Ok(()) => editor::emit_done(&app, &jid, true, Some(final_out.to_string_lossy().to_string()), None),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp_out);
                editor::emit_done(&app, &jid, false, None, Some(e));
            }
        }
    });
    Ok(AiJob { job_id, output_path: out.to_string_lossy().to_string() })
}
