//! On-demand playback fallback (spec §12/VIDEO_PLAYBACK.md): the WebView2
//! `<video>` element is tried first, natively, straight off the original
//! file — this module only runs when that fails. It first tries a
//! lossless stream-copy remux into an MP4 container (fast, no quality
//! loss — covers "right codecs, wrong container", e.g. H.264/AAC in an
//! MKV or AVI); only if that fails does it fall back to a full transcode.
//! Output is disposable cache, never the original file.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

async fn run_ffmpeg(app: &AppHandle, args: &[String]) -> anyhow::Result<bool> {
    let sidecar = app.shell().command(crate::tools::ffmpeg());
    let output = sidecar.args(args).output().await?;
    Ok(output.status.success())
}

pub fn playback_cache_path(cache_dir: &Path, key: &str) -> PathBuf {
    cache_dir.join(format!("{key}.mp4"))
}

/// Returns a browser-playable MP4 for `source`, generating (and caching)
/// it if needed. Remux is tried first; transcode is the fallback.
pub async fn ensure_playable(app: &AppHandle, source: &Path, cache_dir: &Path, key: &str) -> anyhow::Result<PathBuf> {
    let out_path = playback_cache_path(cache_dir, key);
    if out_path.exists() {
        return Ok(out_path);
    }
    std::fs::create_dir_all(cache_dir)?;

    let source_str = source.to_string_lossy().to_string();
    let tmp_path = cache_dir.join(format!("{key}.tmp.mp4"));
    let tmp_str = tmp_path.to_string_lossy().to_string();

    let remux_args = vec![
        "-y".to_string(),
        "-i".to_string(),
        source_str.clone(),
        "-c".to_string(),
        "copy".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        tmp_str.clone(),
    ];
    let remuxed = run_ffmpeg(app, &remux_args).await.unwrap_or(false) && tmp_path.exists();

    if !remuxed {
        let _ = std::fs::remove_file(&tmp_path);
        let transcode_args = vec![
            "-y".to_string(),
            "-i".to_string(),
            source_str,
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "veryfast".to_string(),
            "-crf".to_string(),
            "22".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            tmp_str.clone(),
        ];
        let transcoded = run_ffmpeg(app, &transcode_args).await? && tmp_path.exists();
        if !transcoded {
            let _ = std::fs::remove_file(&tmp_path);
            anyhow::bail!("ffmpeg could not produce a playable file for {}", source.display());
        }
    }

    std::fs::rename(&tmp_path, &out_path)?;
    Ok(out_path)
}
