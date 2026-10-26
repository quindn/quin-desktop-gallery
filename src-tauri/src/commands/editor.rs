use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;

use crate::db::queries;
use crate::editor::{self, job, runner, EditParams, EditProgress};
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

/// Picks a non-clobbering destination next to the source: `name-edited.ext`,
/// `name-edited-2.ext`, ... — never silently overwrites an existing file.
fn next_available_export_path(source: &std::path::Path, ext: &str) -> std::path::PathBuf {
    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("edited");
    let dir = source.parent().unwrap_or_else(|| std::path::Path::new("."));
    let mut candidate = dir.join(format!("{stem}-edited.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-edited-{n}.{ext}"));
        n += 1;
    }
    candidate
}

#[derive(Debug, Clone, Serialize)]
pub struct StartEditResult {
    pub job_id: String,
    pub output_path: String,
    pub stream_copy: bool,
}

/// Starts one export carrying every edit the user set up — trim, crop,
/// rotate/flip, colour, speed, loop and watermark removal together. Returns
/// immediately; progress and completion arrive as `edit://progress` /
/// `edit://done` events.
#[tauri::command]
pub async fn start_edit_job(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    params: EditParams,
) -> Result<StartEditResult, String> {
    let h = root_handle(&state)?;
    let lookup = queries::get_thumb_lookup(&h.pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
    let source_path = h.root.resolve(&lookup.rel_path).map_err(|e| e.to_string())?;

    let conn = h.pool.get().map_err(|e| e.to_string())?;
    let (mut src_w, mut src_h, mut fps, mut has_audio, mut rotation): (Option<i64>, Option<i64>, Option<f64>, bool, Option<i64>) = conn
        .query_row(
            "SELECT width, height, fps, has_audio, rotation FROM media WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0, r.get(4)?)),
        )
        .map_err(|e| e.to_string())?;
    drop(conn);

    // Watermark removal needs the real frame size; a video whose metadata
    // hasn't been scanned yet gets probed on the spot.
    if !params.removal.is_empty() && (src_w.is_none() || src_h.is_none()) {
        let probe = crate::metadata::probe::probe_video(&app, &source_path)
            .await
            .map_err(|e| format!("could not read the video: {e}"))?;
        src_w = probe.width;
        src_h = probe.height;
        fps = fps.or(probe.fps);
        has_audio = probe.has_audio;
        rotation = probe.rotation;
    }
    // Stored dimensions are the coded ones; FFmpeg autorotates before any
    // filter (and before it hands out raw frames), so everything downstream —
    // the aspect crop, the watermark regions drawn in the editor — is in the
    // displayed orientation.
    if matches!(rotation.map(|r| r.rem_euclid(360)), Some(90) | Some(270)) {
        std::mem::swap(&mut src_w, &mut src_h);
    }
    let info = job::SourceInfo {
        width: src_w,
        height: src_h,
        fps,
        has_audio,
        duration_ms: lookup.duration_ms,
    };

    // Reject an impossible request now, not minutes into the render.
    let stream_copy = job::validate(&params, &source_path, &info)?;

    let output_ext = job::output_ext_for(&params, &source_path);
    let final_output = if params.replace_original {
        let same_container = params.format == "source"
            || source_path.extension().and_then(|e| e.to_str()) == Some(output_ext.as_str());
        if same_container {
            source_path.clone()
        } else {
            next_available_export_path(&source_path, &output_ext)
        }
    } else {
        next_available_export_path(&source_path, &output_ext)
    };
    h.root.resolve_for_write(&final_output).map_err(|e| e.to_string())?;

    let job_id = uuid::Uuid::new_v4().to_string();
    let tmp_dir = state.edit_temp_dir();
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let tmp_output = tmp_dir.join(format!("{job_id}.tmp.{output_ext}"));

    let cancel = runner::new_cancel();
    let registry = state.edit_jobs.clone();
    registry.lock().unwrap().insert(job_id.clone(), cancel.clone());

    let worker = {
        let (job_id, final_output, tmp_output) = (job_id.clone(), final_output.clone(), tmp_output.clone());
        move || {
            let ffmpeg = crate::tools::ffmpeg();
            let ctx = job::JobCtx {
                ffmpeg: &ffmpeg,
                source: &source_path,
                tmp_dir: &tmp_dir,
                job_id: &job_id,
                final_tmp: &tmp_output,
            };
            let mut last_emit = Instant::now() - Duration::from_secs(1);
            let mut progress = |pct: f64| {
                if pct >= 99.9 || last_emit.elapsed() >= Duration::from_millis(120) {
                    last_emit = Instant::now();
                    let _ = app.emit(
                        "edit://progress",
                        EditProgress { job_id: job_id.clone(), percent: pct.clamp(0.0, 100.0) },
                    );
                }
            };
            let result = job::run_job(&ctx, &params, &info, &mut progress, &cancel);
            registry.lock().unwrap().remove(&job_id);

            match result {
                Ok(()) => match editor::move_into_place(&tmp_output, &final_output) {
                    Ok(()) => editor::emit_done(&app, &job_id, true, Some(final_output.to_string_lossy().to_string()), None),
                    Err(e) => {
                        let _ = std::fs::remove_file(&tmp_output);
                        editor::emit_done(&app, &job_id, false, None, Some(e.to_string()));
                    }
                },
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp_output);
                    editor::emit_done(&app, &job_id, false, None, Some(e));
                }
            }
        }
    };
    tauri::async_runtime::spawn_blocking(worker);

    Ok(StartEditResult {
        job_id,
        output_path: final_output.to_string_lossy().to_string(),
        stream_copy,
    })
}

#[tauri::command(async)]
pub fn cancel_edit_job(state: State<AppState>, job_id: String) -> Result<(), String> {
    if let Some(flag) = state.edit_jobs.lock().unwrap().get(&job_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// One-shot quick action (spec §12/§14): grabs a single frame at a given
/// timestamp as a full-resolution image, exported non-destructively.
#[tauri::command]
pub async fn extract_frame(app: AppHandle, state: State<'_, AppState>, id: i64, at_ms: i64) -> Result<String, String> {
    let h = root_handle(&state)?;
    let rel_path = queries::get_rel_path(&h.pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
    let source_path = h.root.resolve(&rel_path).map_err(|e| e.to_string())?;
    let out_path = next_available_export_path(&source_path, "jpg");
    h.root.resolve_for_write(&out_path).map_err(|e| e.to_string())?;

    let out_str = out_path.to_string_lossy().to_string();
    let sidecar = app.shell().command(crate::tools::ffmpeg());
    let output = sidecar
        .args([
            "-y".to_string(),
            "-ss".to_string(),
            format!("{:.3}", at_ms as f64 / 1000.0),
            "-i".to_string(),
            source_path.to_string_lossy().to_string(),
            "-frames:v".to_string(),
            "1".to_string(),
            "-q:v".to_string(),
            "2".to_string(),
            out_str.clone(),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() || !out_path.exists() {
        return Err("ffmpeg could not extract a frame at that position".into());
    }
    Ok(out_str)
}

/// One-shot quick action: extracts the audio track as an M4A file.
#[tauri::command]
pub async fn extract_audio(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<String, String> {
    let h = root_handle(&state)?;
    let rel_path = queries::get_rel_path(&h.pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
    let source_path = h.root.resolve(&rel_path).map_err(|e| e.to_string())?;
    let out_path = next_available_export_path(&source_path, "m4a");
    h.root.resolve_for_write(&out_path).map_err(|e| e.to_string())?;

    let out_str = out_path.to_string_lossy().to_string();
    let sidecar = app.shell().command(crate::tools::ffmpeg());
    let output = sidecar
        .args([
            "-y".to_string(),
            "-i".to_string(),
            source_path.to_string_lossy().to_string(),
            "-vn".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            out_str.clone(),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() || !out_path.exists() {
        return Err("ffmpeg could not extract audio (does this file have an audio track?)".into());
    }
    Ok(out_str)
}

#[derive(Debug, Clone, Serialize)]
pub struct EditorSourceInfo {
    pub duration_ms: Option<i64>,
    pub fps: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub has_audio: bool,
}

/// What the editor's timeline needs about the source: its exact length and frame rate (for frame
/// stepping and for typing times). Read from the library; probed on the spot if not scanned yet.
#[tauri::command]
pub async fn editor_source_info(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<EditorSourceInfo, String> {
    let h = root_handle(&state)?;
    let lookup = queries::get_thumb_lookup(&h.pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
    let (fps, width, height, has_audio): (Option<f64>, Option<i64>, Option<i64>, bool) = {
        let conn = h.pool.get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT fps, width, height, has_audio FROM media WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0))
        })
        .map_err(|e| e.to_string())?
    };
    let mut info = EditorSourceInfo { duration_ms: lookup.duration_ms, fps, width, height, has_audio };
    if info.duration_ms.is_none() || info.fps.is_none() {
        let path = h.root.resolve(&lookup.rel_path).map_err(|e| e.to_string())?;
        if let Ok(p) = crate::metadata::probe::probe_video(&app, &path).await {
            info.duration_ms = info.duration_ms.or(p.duration_ms);
            info.fps = info.fps.or(p.fps);
            info.width = info.width.or(p.width);
            info.height = info.height.or(p.height);
            info.has_audio = info.has_audio || p.has_audio;
        }
    }
    Ok(info)
}

const STRIP_W: u32 = 160;
const STRIP_H: u32 = 90;

/// One frame at `at_s`, letterboxed into a `STRIP_W` × `STRIP_H` RGB tile (black on failure).
fn strip_tile(ffmpeg: &std::path::Path, source: &std::path::Path, at_s: f64) -> Vec<u8> {
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(["-v", "error", "-ss", &format!("{at_s:.3}"), "-i"])
        .arg(source)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={STRIP_W}:{STRIP_H}:force_original_aspect_ratio=decrease,pad={STRIP_W}:{STRIP_H}:(ow-iw)/2:(oh-ih)/2:black"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    runner::hide_window(&mut cmd);
    let want = (STRIP_W * STRIP_H * 3) as usize;
    match cmd.output() {
        Ok(o) if o.stdout.len() >= want => o.stdout[..want].to_vec(),
        _ => vec![0; want],
    }
}

/// A strip of `count` evenly spaced frames, side by side, for the editor's timeline. Cached next to
/// the library's thumbnails (keyed by the file's path, size and date), so reopening is instant.
#[tauri::command]
pub async fn editor_filmstrip(state: State<'_, AppState>, id: i64, count: u32) -> Result<String, String> {
    let (pool, root, root_id) = {
        let current = state.current.lock().unwrap();
        let ctx = current.as_ref().ok_or("no root open")?;
        (ctx.pool.clone(), ctx.root.clone(), ctx.id.clone())
    };
    let lookup = queries::get_thumb_lookup(&pool, id).map_err(|e| e.to_string())?.ok_or("not found")?;
    let duration_ms = lookup.duration_ms.filter(|d| *d > 0).ok_or("the video's length isn't known yet")?;
    let count = count.clamp(4, 60);
    let source = root.resolve(&lookup.rel_path).map_err(|e| e.to_string())?;
    let key = blake3::hash(format!("{}|{}|{}|{count}", lookup.rel_path, lookup.modified_time, lookup.file_size).as_bytes()).to_hex()[..20].to_string();
    let dir = state.thumbcache_dir(&root_id).join("filmstrip");
    let out = dir.join(format!("{key}.jpg"));
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out2 = out.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let ffmpeg = crate::tools::ffmpeg();
        let times: Vec<f64> = (0..count).map(|i| (i as f64 + 0.5) * duration_ms as f64 / 1000.0 / count as f64).collect();
        let mut tiles: Vec<Vec<u8>> = vec![vec![]; count as usize];
        // a few seeks at a time: each is a short FFmpeg run
        for chunk in (0..count as usize).collect::<Vec<_>>().chunks(4) {
            let handles: Vec<_> = chunk
                .iter()
                .map(|&i| {
                    let (f, s, t) = (ffmpeg.clone(), source.clone(), times[i]);
                    (i, std::thread::spawn(move || strip_tile(&f, &s, t)))
                })
                .collect();
            for (i, h) in handles {
                tiles[i] = h.join().unwrap_or_else(|_| vec![0; (STRIP_W * STRIP_H * 3) as usize]);
            }
        }
        let mut img = image::RgbImage::new(STRIP_W * count, STRIP_H);
        for (i, tile) in tiles.iter().enumerate() {
            let t = image::RgbImage::from_raw(STRIP_W, STRIP_H, tile.clone()).ok_or("bad tile")?;
            image::imageops::replace(&mut img, &t, (i as u32 * STRIP_W) as i64, 0);
        }
        let tmp = out2.with_extension("tmp.jpg");
        img.save_with_format(&tmp, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &out2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(out.to_string_lossy().to_string())
}
