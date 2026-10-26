use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Result of the fast ffprobe pass (MEDIA_PIPELINE.md stages 1-2). When
/// the container's own duration fields are missing/invalid, `duration_ms`
/// is `None` and `needs_deep_scan` is set — callers must never coerce
/// that into `0`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct VideoProbe {
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub container: Option<String>,
    pub pixel_format: Option<String>,
    pub has_audio: bool,
    pub rotation: Option<i64>,
    pub needs_deep_scan: bool,
}

pub struct SidecarOutput {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Runs a bundled helper program to completion but never waits forever: past
/// `timeout` the child is killed and an error returned. A single corrupt or
/// unreachable file that made ffmpeg/ffprobe hang used to pin its row in
/// `pending` (and a worker slot) for the whole session, which is what kept
/// the library's scan status stuck on "In progress".
pub async fn run_sidecar(
    app: &AppHandle,
    name: &str,
    args: Vec<String>,
    timeout: Duration,
) -> anyhow::Result<SidecarOutput> {
    let (mut rx, child) = app.shell().command(crate::tools::path(name)).args(args).spawn()?;
    let deadline = tokio::time::Instant::now() + timeout;
    let mut out = SidecarOutput {
        success: false,
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => {
                let _ = child.kill();
                anyhow::bail!("{name} timed out after {}s", timeout.as_secs());
            }
            Ok(None) => break,
            Ok(Some(CommandEvent::Stdout(b))) => out.stdout.extend_from_slice(&b),
            Ok(Some(CommandEvent::Stderr(b))) => out.stderr.extend_from_slice(&b),
            Ok(Some(CommandEvent::Terminated(p))) => out.success = p.code == Some(0),
            Ok(Some(CommandEvent::Error(e))) => anyhow::bail!("{name}: {e}"),
            Ok(Some(_)) => {}
        }
    }
    Ok(out)
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const DEEP_TIMEOUT: Duration = Duration::from_secs(180);
const DECODE_TIMEOUT: Duration = Duration::from_secs(900);

async fn run_ffprobe_json(app: &AppHandle, args: &[&str], timeout: Duration) -> anyhow::Result<Value> {
    let output = run_sidecar(app, "ffprobe", args.iter().map(|a| a.to_string()).collect(), timeout).await?;
    if !output.success {
        anyhow::bail!("ffprobe failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    let value: Value = serde_json::from_slice(&output.stdout)?;
    Ok(value)
}

fn parse_fraction(s: &str) -> Option<f64> {
    if let Some((num, den)) = s.split_once('/') {
        let num: f64 = num.parse().ok()?;
        let den: f64 = den.parse().ok()?;
        if den == 0.0 {
            None
        } else {
            Some(num / den)
        }
    } else {
        s.parse().ok()
    }
}

/// Stages 1-2: header/format-level duration, plus codec/stream details.
pub async fn probe_video(app: &AppHandle, path: &Path) -> anyhow::Result<VideoProbe> {
    let path_str = path.to_string_lossy().to_string();
    let value = run_ffprobe_json(
        app,
        &[
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path_str,
        ],
        PROBE_TIMEOUT,
    )
    .await?;

    let mut probe = VideoProbe::default();
    let format = value.get("format");

    probe.container = format
        .and_then(|f| f.get("format_name"))
        .and_then(|v| v.as_str())
        .map(|s| s.split(',').next().unwrap_or(s).to_string());
    probe.bitrate = format
        .and_then(|f| f.get("bit_rate"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());

    let format_duration = format
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|d| *d > 0.0);

    let streams = value
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let mut stream_duration: Option<f64> = None;
    for stream in &streams {
        let codec_type = stream.get("codec_type").and_then(|v| v.as_str()).unwrap_or("");
        if codec_type == "video" && probe.video_codec.is_none() {
            probe.video_codec = stream.get("codec_name").and_then(|v| v.as_str()).map(String::from);
            probe.width = stream.get("width").and_then(|v| v.as_i64());
            probe.height = stream.get("height").and_then(|v| v.as_i64());
            probe.pixel_format = stream.get("pix_fmt").and_then(|v| v.as_str()).map(String::from);
            probe.fps = stream
                .get("avg_frame_rate")
                .and_then(|v| v.as_str())
                .and_then(parse_fraction)
                .filter(|f| *f > 0.0)
                .or_else(|| {
                    stream
                        .get("r_frame_rate")
                        .and_then(|v| v.as_str())
                        .and_then(parse_fraction)
                });
            probe.rotation = stream
                .get("tags")
                .and_then(|t| t.get("rotate"))
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .or_else(|| {
                    // Newer ffmpeg reports display-matrix rotation via
                    // side_data_list rather than the legacy `rotate` tag.
                    stream.get("side_data_list").and_then(|sd| sd.as_array()).and_then(|arr| {
                        arr.iter().find_map(|entry| entry.get("rotation").and_then(|v| v.as_i64()))
                    })
                });
            stream_duration = stream
                .get("duration")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|d| *d > 0.0);
        } else if codec_type == "audio" {
            probe.has_audio = true;
            if probe.audio_codec.is_none() {
                probe.audio_codec = stream.get("codec_name").and_then(|v| v.as_str()).map(String::from);
                probe.sample_rate = stream
                    .get("sample_rate")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse().ok());
                probe.channels = stream.get("channels").and_then(|v| v.as_i64());
            }
        }
    }

    match format_duration.or(stream_duration) {
        Some(secs) => probe.duration_ms = Some((secs * 1000.0).round() as i64),
        None => probe.needs_deep_scan = true,
    }

    Ok(probe)
}

/// Stage 4: decode frame count + frame rate when the header lies or is
/// absent (VFR footage, some streamed/concatenated/MKV/TS files). Slow —
/// only invoked for rows `probe_video` already flagged `needs_deep_scan`.
pub async fn deep_probe_duration(app: &AppHandle, path: &Path) -> anyhow::Result<Option<i64>> {
    let path_str = path.to_string_lossy().to_string();
    let value = run_ffprobe_json(
        app,
        &[
            "-v",
            "error",
            "-print_format",
            "json",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames,avg_frame_rate,r_frame_rate",
            &path_str,
        ],
        DEEP_TIMEOUT,
    )
    .await?;

    let Some(stream) = value.get("streams").and_then(|s| s.as_array()).and_then(|a| a.first()) else {
        return Ok(None);
    };

    let frames: Option<f64> = stream
        .get("nb_read_frames")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());
    let fps = stream
        .get("avg_frame_rate")
        .and_then(|v| v.as_str())
        .and_then(parse_fraction)
        .filter(|f| *f > 0.0)
        .or_else(|| {
            stream
                .get("r_frame_rate")
                .and_then(|v| v.as_str())
                .and_then(parse_fraction)
        });

    Ok(match (frames, fps) {
        (Some(frames), Some(fps)) if fps > 0.0 => Some(((frames / fps) * 1000.0).round() as i64),
        _ => None,
    })
}

/// Stage 5: last-resort fallback when even `-count_frames` finds nothing
/// usable (a handful of VFR/concatenated/exotic streams defeat frame
/// counting too). Actually decodes the file start-to-finish and reads how
/// far ffmpeg's own progress reporting got — slower than count_frames in
/// the common case, but it's the most literal possible answer to "how
/// long does this file actually play for," so it resolves files nothing
/// else can. This is what guarantees every video ends up with *some*
/// duration rather than being stuck at "needs deep scan" forever.
pub async fn decode_probe_duration(app: &AppHandle, path: &Path) -> anyhow::Result<Option<i64>> {
    let path_str = path.to_string_lossy().to_string();
    let output = run_sidecar(
        app,
        "ffmpeg",
        ["-nostdin", "-v", "error", "-stats", "-i", &path_str, "-map", "0:v:0", "-f", "null", "-"]
            .iter()
            .map(|a| a.to_string())
            .collect(),
        DECODE_TIMEOUT,
    )
    .await?;
    Ok(parse_last_time(&String::from_utf8_lossy(&output.stderr)))
}

fn parse_last_time(stderr: &str) -> Option<i64> {
    let mut last: Option<i64> = None;
    for line in stderr.lines() {
        let Some(idx) = line.find("time=") else { continue };
        let rest = &line[idx + 5..];
        let end = rest.find(' ').unwrap_or(rest.len());
        let parts: Vec<&str> = rest[..end].split(':').collect();
        if parts.len() != 3 {
            continue;
        }
        if let (Ok(h), Ok(m), Ok(s)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>(), parts[2].parse::<f64>()) {
            last = Some(((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as i64);
        }
    }
    last.filter(|ms| *ms > 0)
}

/// Cheap header-only dimension read for photos (no full pixel decode).
pub fn probe_photo_dimensions(path: &Path) -> Option<(u32, u32)> {
    image::image_dimensions(path).ok()
}

#[derive(Debug, Clone, Default)]
pub struct PhotoExif {
    pub date_taken: Option<i64>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub orientation: Option<i64>,
}

fn dms_to_degrees(field: &exif::Field) -> Option<f64> {
    let exif::Value::Rational(ref v) = field.value else {
        return None;
    };
    if v.len() < 3 {
        return None;
    }
    let deg = v[0].to_f64();
    let min = v[1].to_f64();
    let sec = v[2].to_f64();
    Some(deg + min / 60.0 + sec / 3600.0)
}

/// Reads EXIF (camera, capture date, GPS, orientation) where present.
/// Read-only — never modifies the source file (spec §4: "Do not overwrite
/// original EXIF without explicit action"). Missing/unsupported formats
/// simply yield an empty `PhotoExif`, not an error.
pub fn probe_photo_exif(path: &Path) -> PhotoExif {
    let mut result = PhotoExif::default();

    let Ok(file) = std::fs::File::open(path) else {
        return result;
    };
    let mut reader = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return result;
    };

    if let Some(field) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
        if let exif::Value::Ascii(ref v) = field.value {
            if let Some(s) = v.first().and_then(|b| std::str::from_utf8(b).ok()) {
                if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y:%m:%d %H:%M:%S") {
                    result.date_taken = Some(dt.and_utc().timestamp_millis());
                }
            }
        }
    }

    if let Some(field) = exif.get_field(exif::Tag::Make, exif::In::PRIMARY) {
        result.camera_make = Some(field.display_value().to_string().trim().to_string());
    }
    if let Some(field) = exif.get_field(exif::Tag::Model, exif::In::PRIMARY) {
        result.camera_model = Some(field.display_value().to_string().trim().to_string());
    }
    if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        result.orientation = field.value.get_uint(0).map(|v| v as i64);
    }

    if let (Some(lat_field), Some(lat_ref)) = (
        exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY),
        exif.get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY),
    ) {
        if let Some(mut lat) = dms_to_degrees(lat_field) {
            if lat_ref.display_value().to_string().starts_with('S') {
                lat = -lat;
            }
            result.gps_lat = Some(lat);
        }
    }
    if let (Some(lon_field), Some(lon_ref)) = (
        exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY),
        exif.get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY),
    ) {
        if let Some(mut lon) = dms_to_degrees(lon_field) {
            if lon_ref.display_value().to_string().starts_with('W') {
                lon = -lon;
            }
            result.gps_lon = Some(lon);
        }
    }

    result
}
