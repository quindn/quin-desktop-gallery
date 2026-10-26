//! Non-destructive video editing (spec §14): trim/cut, rotate/flip, crop
//! (aspect-ratio presets or a free-form rectangle), resize, mute, speed
//! change, basic color, ping-pong loop rendering (original + reversed,
//! repeated N times), and format conversion — always exported to a new file by default,
//! "Replace Original" is an explicit opt-in that still writes to a temp
//! file first and atomically renames over the original (crash-safe).
//!
//! Lossless stream-copy is used automatically whenever nothing requires
//! re-encoding (a pure trim); anything else re-encodes through a single
//! FFmpeg filter chain. "Accurate Cut" forces re-encoding even for a pure
//! trim, for frame-accurate cut points instead of the nearest keyframe.

pub mod inpaint;
pub mod job;
pub mod pipeline;
pub mod runner;
pub mod studio;
pub mod watermark;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Free-form crop rectangle, normalized to 0..1 of the frame as displayed
/// (i.e. after the container's rotation metadata is applied — which is what
/// both the browser preview and FFmpeg's autorotate operate on). Fractions
/// rather than pixels so the result doesn't depend on which file (original
/// or a transcoded playback copy) the preview happened to be playing.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One kept piece of the source (source timeline, ms). See `EditParams::segments`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct EditParams {
    pub trim_start_ms: Option<i64>,
    pub trim_end_ms: Option<i64>,
    pub rotate: i32, // 0, 90, 180, 270
    pub flip_h: bool,
    pub flip_v: bool,
    /// "original" | "1:1" | "16:9" | "9:16" | "4:3"
    pub aspect: String,
    pub target_width: Option<i32>,
    pub mute: bool,
    pub speed: f64,
    pub brightness: f64,  // -1.0..1.0, 0 = unchanged
    pub contrast: f64,    // 0.0..2.0, 1 = unchanged
    pub saturation: f64,  // 0.0..2.0, 1 = unchanged
    pub format: String,   // "source" | "mp4" | "webm"
    pub quality: String,  // "high" | "medium" | "compressed"
    pub accurate_cut: bool,
    pub replace_original: bool,
    /// Free-form crop; takes precedence over the `aspect` preset.
    pub crop: Option<CropRect>,
    /// Render "original + reversed" back to back (a seamless ping-pong loop).
    pub loop_pingpong: bool,
    /// How many times the original+reversed cycle repeats in the output.
    pub loop_count: u32,
    /// Watermark / object removal regions, in the coordinates of the original
    /// (un-cropped, un-rotated) frame. Painted out first; every other edit
    /// then runs on the cleaned clip, all within one job.
    pub removal: Vec<watermark::RemovalRegion>,
    /// Two or more kept pieces, in order: everything between them is cut out and the pieces are
    /// joined. With fewer than two, `trim_start_ms` / `trim_end_ms` describe the single range.
    pub segments: Vec<Segment>,
}

impl Default for EditParams {
    fn default() -> Self {
        Self {
            trim_start_ms: None,
            trim_end_ms: None,
            rotate: 0,
            flip_h: false,
            flip_v: false,
            aspect: "original".to_string(),
            target_width: None,
            mute: false,
            speed: 1.0,
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            format: "source".to_string(),
            quality: "high".to_string(),
            accurate_cut: false,
            replace_original: false,
            crop: None,
            loop_pingpong: false,
            loop_count: 1,
            removal: vec![],
            segments: vec![],
        }
    }
}

fn needs_video_reencode(p: &EditParams) -> bool {
    // WebM only holds VP8/VP9/AV1, so converting to it is never a stream copy
    // (copying H.264 into WebM is exactly what FFmpeg refuses).
    p.format == "webm"
        // "Medium" / "Compressed" only mean something when the video is encoded again
        || p.quality != "high"
        || p.accurate_cut
        || p.crop.as_ref().and_then(custom_crop_filter).is_some()
        || p.loop_pingpong
        || p.aspect != "original"
        || p.target_width.is_some()
        || p.rotate != 0
        || p.flip_h
        || p.flip_v
        || p.speed != 1.0
        || p.brightness != 0.0
        || p.contrast != 1.0
        || p.saturation != 1.0
}

fn crop_filter(aspect: &str, src_w: i64, src_h: i64) -> Option<String> {
    let target_ratio = match aspect {
        "1:1" => 1.0,
        "16:9" => 16.0 / 9.0,
        "9:16" => 9.0 / 16.0,
        "4:3" => 4.0 / 3.0,
        _ => return None,
    };
    let src_ratio = src_w as f64 / src_h as f64;
    let (w, h) = if src_ratio > target_ratio {
        (((src_h as f64) * target_ratio).round() as i64, src_h)
    } else {
        (src_w, ((src_w as f64) / target_ratio).round() as i64)
    };
    // Even dimensions — required by most video codecs (yuv420p chroma subsampling).
    let w = w - (w % 2);
    let h = h - (h % 2);
    Some(format!("crop={w}:{h}:(iw-{w})/2:(ih-{h})/2"))
}

/// `crop=` filter for a normalized rectangle. Evaluated by FFmpeg against
/// the real input size (`iw`/`ih`), rounded down to even values — required
/// by yuv420p chroma subsampling.
fn custom_crop_filter(c: &CropRect) -> Option<String> {
    let x = c.x.clamp(0.0, 1.0);
    let y = c.y.clamp(0.0, 1.0);
    let w = c.w.clamp(0.0, 1.0 - x);
    let h = c.h.clamp(0.0, 1.0 - y);
    if w < 0.005 || h < 0.005 {
        return None;
    }
    // Whole frame selected -> nothing to crop.
    if x <= 0.0005 && y <= 0.0005 && w >= 0.9995 && h >= 0.9995 {
        return None;
    }
    // pixels are rounded to the nearest one first (0.35 * 360 is 125.99999…, and truncating that lost a
    // whole pixel row), then made even like the "Output" size the editor shows
    Some(format!(
        "crop=w='max(2,trunc(round(iw*{w:.6})/2)*2)':h='max(2,trunc(round(ih*{h:.6})/2)*2)':x='trunc(round(iw*{x:.6})/2)*2':y='trunc(round(ih*{y:.6})/2)*2'"
    ))
}

fn build_video_filters(p: &EditParams, src_w: Option<i64>, src_h: Option<i64>) -> Vec<String> {
    let mut filters = vec![];
    if let Some(crop) = p.crop.as_ref().and_then(custom_crop_filter) {
        filters.push(crop);
    } else if let (Some(w), Some(h)) = (src_w, src_h) {
        if let Some(crop) = crop_filter(&p.aspect, w, h) {
            filters.push(crop);
        }
    }
    if let Some(w) = p.target_width {
        filters.push(format!("scale={w}:-2"));
    }
    match p.rotate {
        90 => filters.push("transpose=1".to_string()),
        180 => filters.push("transpose=1,transpose=1".to_string()),
        270 => filters.push("transpose=2".to_string()),
        _ => {}
    }
    if p.flip_h {
        filters.push("hflip".to_string());
    }
    if p.flip_v {
        filters.push("vflip".to_string());
    }
    if p.speed != 1.0 {
        filters.push(format!("setpts=PTS/{}", p.speed));
    }
    if p.brightness != 0.0 || p.contrast != 1.0 || p.saturation != 1.0 {
        filters.push(format!(
            "eq=brightness={}:contrast={}:saturation={}",
            p.brightness, p.contrast, p.saturation
        ));
    }
    filters
}

/// `atempo` only accepts 0.5-2.0 per instance; chain multiple stages for
/// values outside that range rather than silently clamping audio speed.
pub(crate) fn atempo_chain(speed: f64) -> String {
    let mut remaining = speed;
    let mut stages = vec![];
    while remaining > 2.0 {
        stages.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        stages.push(0.5);
        remaining /= 0.5;
    }
    stages.push(remaining);
    stages.iter().map(|s| format!("atempo={s:.4}")).collect::<Vec<_>>().join(",")
}

fn quality_to_crf(quality: &str) -> &'static str {
    match quality {
        "high" => "18",
        "compressed" => "28",
        _ => "23", // medium
    }
}

pub struct BuiltCommand {
    pub args: Vec<String>,
    pub output_ext: String,
    pub stream_copy: bool,
}

pub fn build_command(
    source_path: &std::path::Path,
    output_path: &std::path::Path,
    p: &EditParams,
    src_w: Option<i64>,
    src_h: Option<i64>,
) -> BuiltCommand {
    let mut args = vec!["-y".to_string(), "-nostdin".to_string()];

    // Both -ss and -t are placed *before* -i (input-side) rather than
    // after (output-side): with a speed filter downstream, an
    // output-side -t measures duration in the *post-speed* timeline, so
    // it would read a different amount of source content than the user
    // actually selected. Input-side -ss/-t always mean "this range of the
    // original file," regardless of what filters run afterward.
    let start_s = p.trim_start_ms.map(|ms| ms as f64 / 1000.0);
    if let Some(s) = start_s {
        args.push("-ss".to_string());
        args.push(format!("{s:.3}"));
    }
    if let Some(end_ms) = p.trim_end_ms {
        let start_ms = p.trim_start_ms.unwrap_or(0);
        let duration_s = (end_ms - start_ms).max(0) as f64 / 1000.0;
        args.push("-t".to_string());
        args.push(format!("{duration_s:.3}"));
    }
    args.push("-i".to_string());
    args.push(source_path.to_string_lossy().to_string());

    let video_filters = build_video_filters(p, src_w, src_h);
    let stream_copy = !needs_video_reencode(p) && video_filters.is_empty();

    if stream_copy {
        args.push("-c:v".to_string());
        args.push("copy".to_string());
    } else {
        if !video_filters.is_empty() {
            args.push("-vf".to_string());
            args.push(video_filters.join(","));
        }
        match p.format.as_str() {
            "webm" => {
                args.extend(["-c:v".to_string(), "libvpx-vp9".to_string()]);
                args.extend(["-crf".to_string(), quality_to_crf(&p.quality).to_string()]);
                args.extend(["-b:v".to_string(), "0".to_string()]);
            }
            _ => {
                args.extend(["-c:v".to_string(), "libx264".to_string()]);
                args.extend(["-preset".to_string(), "medium".to_string()]);
                args.extend(["-crf".to_string(), quality_to_crf(&p.quality).to_string()]);
                args.extend(["-pix_fmt".to_string(), "yuv420p".to_string()]);
            }
        }
    }

    if p.mute {
        args.push("-an".to_string());
    } else if p.speed != 1.0 {
        args.extend(["-filter:a".to_string(), atempo_chain(p.speed)]);
        args.extend([
            "-c:a".to_string(),
            if p.format == "webm" { "libopus".to_string() } else { "aac".to_string() },
        ]);
    } else if stream_copy {
        args.push("-c:a".to_string());
        args.push("copy".to_string());
    } else {
        args.extend([
            "-c:a".to_string(),
            if p.format == "webm" { "libopus".to_string() } else { "aac".to_string() },
        ]);
    }

    if p.format == "mp4" || (p.format == "source" && stream_copy) {
        args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }

    let output_ext = match p.format.as_str() {
        "mp4" => "mp4",
        "webm" => "webm",
        _ => source_path.extension().and_then(|e| e.to_str()).unwrap_or("mp4"),
    }
    .to_string();

    args.push(output_path.to_string_lossy().to_string());

    BuiltCommand {
        args,
        output_ext,
        stream_copy,
    }
}

/// Ping-pong loop: the (trimmed / cropped / adjusted) clip followed by the
/// same clip reversed. One pass renders a single original+reversed cycle;
/// repeating it `loop_count` times is a second, lossless stream-copy pass
/// (`-stream_loop`), so a 50x loop costs no more encoding than a 1x one.
pub struct LoopPlan {
    pub cycle_args: Vec<String>,
    /// Present only when the cycle has to be repeated (`loop_count > 1`).
    pub repeat_args: Option<Vec<String>>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub output_ext: String,
}

/// Rough RAM the `reverse` filter needs: it buffers every decoded frame of
/// the clip (post crop/scale) before it can emit the first reversed one.
pub fn estimate_reverse_bytes(
    p: &EditParams,
    src_w: i64,
    src_h: i64,
    fps: f64,
    duration_ms: i64,
) -> u64 {
    let (mut w, mut h) = (src_w as f64, src_h as f64);
    if let Some(c) = p.crop.as_ref() {
        w *= c.w.clamp(0.0, 1.0);
        h *= c.h.clamp(0.0, 1.0);
    }
    if let Some(tw) = p.target_width {
        let tw = tw as f64;
        if tw > 0.0 && tw < w {
            h *= tw / w;
            w = tw;
        }
    }
    // `setpts` for a speed change rescales timestamps, it doesn't drop frames.
    let frames = fps.max(1.0) * (duration_ms.max(0) as f64 / 1000.0);
    (w * h * 1.5 * frames) as u64
}

pub fn build_loop_plan(
    source_path: &std::path::Path,
    cycle_output: &std::path::Path,
    final_output: &std::path::Path,
    p: &EditParams,
    src_w: Option<i64>,
    src_h: Option<i64>,
    has_audio: bool,
) -> LoopPlan {
    let mut args = vec!["-y".to_string(), "-nostdin".to_string()];
    if let Some(ms) = p.trim_start_ms {
        args.push("-ss".to_string());
        args.push(format!("{:.3}", ms as f64 / 1000.0));
    }
    if let Some(end_ms) = p.trim_end_ms {
        let start_ms = p.trim_start_ms.unwrap_or(0);
        args.push("-t".to_string());
        args.push(format!("{:.3}", (end_ms - start_ms).max(0) as f64 / 1000.0));
    }
    args.push("-i".to_string());
    args.push(source_path.to_string_lossy().to_string());

    let vf = build_video_filters(p, src_w, src_h);
    let vchain = if vf.is_empty() { "null".to_string() } else { vf.join(",") };
    let with_audio = has_audio && !p.mute;

    // The reversed half drops its first frame: it's the same picture as the
    // last frame of the forward half, and keeping both would hold that frame
    // for two ticks at every turnaround.
    let mut graph = format!(
        "[0:v]{vchain},split[vf][vb];[vb]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[vr];"
    );
    if with_audio {
        let atempo = if p.speed != 1.0 { format!("{},", atempo_chain(p.speed)) } else { String::new() };
        graph.push_str(&format!(
            "[0:a]{atempo}asplit[af][ab];[ab]areverse[ar];[vf][af][vr][ar]concat=n=2:v=1:a=1[v][a]"
        ));
    } else {
        graph.push_str("[vf][vr]concat=n=2:v=1:a=0[v]");
    }
    args.extend(["-filter_complex".to_string(), graph]);
    args.extend(["-map".to_string(), "[v]".to_string()]);
    if with_audio {
        args.extend(["-map".to_string(), "[a]".to_string()]);
    }

    let output_ext = loop_output_ext(p, source_path);
    let vp9 = output_ext == "webm";
    args.extend(video_encode_args(vp9, &p.quality));
    if with_audio {
        args.extend(["-c:a".to_string(), audio_codec(vp9).to_string()]);
    }
    if !vp9 {
        args.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }

    let repeats = p.loop_count.clamp(1, 9999);
    let (cycle_target, repeat_args) = if repeats > 1 {
        (cycle_output, Some(repeat_args(cycle_output, final_output, repeats, &output_ext)))
    } else {
        (final_output, None)
    };
    args.push(cycle_target.to_string_lossy().to_string());

    LoopPlan {
        cycle_args: args,
        repeat_args,
        output_ext,
    }
}

/// The lossless "play this cycle N times" step.
fn repeat_args(cycle_output: &std::path::Path, final_output: &std::path::Path, repeats: u32, ext: &str) -> Vec<String> {
    let mut r = vec![
        "-y".to_string(),
        "-nostdin".to_string(),
        "-stream_loop".to_string(),
        (repeats - 1).to_string(),
        "-i".to_string(),
        cycle_output.to_string_lossy().to_string(),
        "-c".to_string(),
        "copy".to_string(),
    ];
    if ext != "webm" {
        r.extend(["-movflags".to_string(), "+faststart".to_string()]);
    }
    r.push(final_output.to_string_lossy().to_string());
    r
}

/// A ping-pong loop rendered piece by piece, for clips whose frames do not fit in memory
/// (`reverse` has to hold every frame it reverses). The forward half is one ordinary streaming
/// encode; the reversed half is cut into short pieces that are each reversed and encoded on their
/// own, then everything (and the audio, forward + backward) is joined without re-encoding.
pub struct ChunkedLoop {
    pub steps: Vec<EditStep>,
    /// Intermediate files to delete afterwards.
    pub scratch: Vec<std::path::PathBuf>,
}

pub struct ChunkedLoopInput<'a> {
    pub source: &'a std::path::Path,
    pub tmp_dir: &'a std::path::Path,
    pub job_id: &'a str,
    pub final_output: &'a std::path::Path,
    pub p: &'a EditParams,
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub has_audio: bool,
    /// Length of the selected range in the source timeline.
    pub range_ms: i64,
    /// How many bytes of raw frames one reversed piece may hold.
    pub budget_bytes: u64,
}

/// Bytes of raw frames per second of source, as they are held by `reverse` (after crop / resize).
pub fn reverse_bytes_per_second(p: &EditParams, w: i64, h: i64, fps: f64) -> f64 {
    estimate_reverse_bytes(p, w, h, fps, 1000) as f64
}

pub fn build_chunked_loop(i: &ChunkedLoopInput) -> ChunkedLoop {
    let p = i.p;
    let start_ms = p.trim_start_ms.unwrap_or(0).max(0);
    let range_s = i.range_ms as f64 / 1000.0;
    let speed = p.speed.max(0.01);

    // equal pieces of at least a second
    let per_sec = reverse_bytes_per_second(p, i.width, i.height, i.fps).max(1.0);
    let max_piece_s = (i.budget_bytes as f64 / per_sec).max(1.0);
    let n = ((range_s / max_piece_s).ceil() as usize).clamp(1, 100_000);
    let piece_s = range_s / n as f64;

    let vf = build_video_filters(p, Some(i.width), Some(i.height));
    let vchain = if vf.is_empty() { "null".to_string() } else { vf.join(",") };
    let output_ext = loop_output_ext(p, i.source);
    let vp9 = output_ext == "webm";
    let with_audio = i.has_audio && !p.mute;
    let repeats = p.loop_count.clamp(1, 9999);
    let src = i.source.to_string_lossy().to_string();

    let tmp = |name: &str| i.tmp_dir.join(format!("{}.tmp.{name}", i.job_id));
    let mut scratch = vec![];
    let mut work: Vec<(Vec<String>, Option<i64>, f64, Option<(std::path::PathBuf, String)>)> = vec![];

    let input = |from_s: f64, len_s: f64| -> Vec<String> {
        vec![
            "-y".into(),
            "-nostdin".into(),
            "-ss".into(),
            format!("{from_s:.3}"),
            "-t".into(),
            format!("{len_s:.3}"),
            "-i".into(),
            src.clone(),
        ]
    };
    let video_out = |mut args: Vec<String>, filter: String, out: &std::path::Path| -> Vec<String> {
        args.extend(["-map".into(), "0:v:0".into(), "-vf".into(), filter, "-an".into()]);
        args.extend(video_encode_args(vp9, &p.quality));
        args.extend(["-f".into(), "matroska".into(), out.to_string_lossy().to_string()]);
        args
    };

    // 1. the forward half: one streaming encode
    let fwd = tmp("fwd.mkv");
    let fwd_ms = (range_s * 1000.0 / speed) as i64;
    work.push((video_out(input(start_ms as f64 / 1000.0, range_s), vchain.clone(), &fwd), Some(fwd_ms), fwd_ms as f64, None));
    scratch.push(fwd.clone());

    // 2. the reversed half, piece by piece (each piece is reversed on its own)
    let mut rev_files = vec![];
    for k in 0..n {
        let from = start_ms as f64 / 1000.0 + k as f64 * piece_s;
        let len = if k + 1 == n { range_s - k as f64 * piece_s } else { piece_s };
        // the very first reversed frame equals the last forward frame: drop it
        let tail = if k + 1 == n { ",trim=start_frame=1" } else { "" };
        let out = tmp(&format!("rev{k}.mkv"));
        let ms = (len * 1000.0 / speed) as i64;
        work.push((video_out(input(from, len), format!("{vchain},reverse{tail},setpts=PTS-STARTPTS"), &out), Some(ms), ms as f64, None));
        scratch.push(out.clone());
        rev_files.push(out);
    }
    rev_files.reverse(); // the last piece plays first

    // 3. the audio, forward then backward
    let aud = tmp("aud.mkv");
    if with_audio {
        let atempo = if p.speed != 1.0 { format!("{},", atempo_chain(p.speed)) } else { String::new() };
        let graph = format!("[0:a]{atempo}aformat=sample_fmts=s16,asplit[af][ab];[ab]areverse[ar];[af][ar]concat=n=2:v=0:a=1[a]");
        let mut args = input(start_ms as f64 / 1000.0, range_s);
        args.extend(["-filter_complex".into(), graph, "-map".into(), "[a]".into(), "-vn".into()]);
        args.extend(["-c:a".into(), audio_codec(vp9).to_string(), "-f".into(), "matroska".into(), aud.to_string_lossy().to_string()]);
        let ms = (range_s * 2000.0 / speed) as i64;
        work.push((args, Some(ms), ms as f64 * 0.2, None));
        scratch.push(aud.clone());
    }

    // 4. join it all without re-encoding
    let list = tmp("list.txt");
    let quote = |f: &std::path::Path| format!("file '{}'\n", f.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"));
    let mut text = quote(&fwd);
    for f in &rev_files {
        text.push_str(&quote(f));
    }
    let cycle_output = tmp(&format!("cycle.{output_ext}"));
    let target: &std::path::Path = if repeats > 1 { &cycle_output } else { i.final_output };
    let mut join: Vec<String> = ["-y", "-nostdin", "-f", "concat", "-safe", "0", "-i"].iter().map(|a| a.to_string()).collect();
    join.push(list.to_string_lossy().to_string());
    if with_audio {
        join.extend(["-i".into(), aud.to_string_lossy().to_string()]);
    }
    join.extend(["-map".into(), "0:v:0".into()]);
    if with_audio {
        join.extend(["-map".into(), "1:a:0".into()]);
    }
    join.extend(["-c".into(), "copy".into()]);
    if !vp9 {
        join.extend(["-movflags".into(), "+faststart".into()]);
    }
    join.push(target.to_string_lossy().to_string());
    let cycle_ms = (range_s * 2000.0 / speed) as i64;
    work.push((join, None, cycle_ms as f64 * 0.03, Some((list.clone(), text))));
    scratch.push(list);
    if repeats > 1 {
        scratch.push(cycle_output.clone());
    }

    // one smooth 0..100 bar across all of it (the repeat step, if any, takes the last 15 %)
    let span = if repeats > 1 { 85.0 } else { 100.0 };
    let total: f64 = work.iter().map(|w| w.2).sum::<f64>().max(1.0);
    let mut steps = vec![];
    let mut at = 0.0;
    for (args, total_ms, weight, list_file) in work {
        let to = at + weight / total * span;
        let mut st = EditStep::new(args, total_ms, at, to);
        st.list_file = list_file;
        steps.push(st);
        at = to;
    }
    if repeats > 1 {
        steps.push(EditStep::new(
            repeat_args(&cycle_output, i.final_output, repeats, &output_ext),
            Some(cycle_ms * repeats as i64),
            85.0,
            100.0,
        ));
    }
    ChunkedLoop { steps, scratch }
}

pub(crate) fn video_encode_args_pub(vp9: bool, quality: &str) -> Vec<String> {
    video_encode_args(vp9, quality)
}

pub(crate) fn audio_codec_pub(vp9: bool) -> &'static str {
    audio_codec(vp9)
}

fn loop_output_ext(p: &EditParams, source_path: &std::path::Path) -> String {
    match p.format.as_str() {
        "mp4" => "mp4",
        "webm" => "webm",
        _ => match source_path.extension().and_then(|e| e.to_str()) {
            Some(e) if e.eq_ignore_ascii_case("webm") => "webm",
            _ => "mp4",
        },
    }
    .to_string()
}

fn video_encode_args(vp9: bool, quality: &str) -> Vec<String> {
    if vp9 {
        ["-c:v", "libvpx-vp9", "-crf", quality_to_crf(quality), "-b:v", "0"]
            .iter()
            .map(|a| a.to_string())
            .collect()
    } else {
        ["-c:v", "libx264", "-preset", "medium", "-crf", quality_to_crf(quality), "-pix_fmt", "yuv420p"]
            .iter()
            .map(|a| a.to_string())
            .collect()
    }
}

fn audio_codec(vp9: bool) -> &'static str {
    if vp9 {
        "libopus"
    } else {
        "aac"
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EditProgress {
    pub job_id: String,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditDone {
    pub job_id: String,
    pub success: bool,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

/// One FFmpeg invocation inside an edit job. `pct_from..pct_to` is the slice
/// of the job's overall progress bar this step owns, so a two-step job (loop
/// cycle, then lossless repeat) still reports one smooth 0-100 bar.
pub struct EditStep {
    pub args: Vec<String>,
    pub total_ms: Option<i64>,
    pub pct_from: f64,
    pub pct_to: f64,
    /// A small text file (an FFmpeg concat list) to write just before this step runs.
    pub list_file: Option<(std::path::PathBuf, String)>,
}

impl EditStep {
    pub fn new(args: Vec<String>, total_ms: Option<i64>, pct_from: f64, pct_to: f64) -> EditStep {
        EditStep { args, total_ms, pct_from, pct_to, list_file: None }
    }

    pub fn single(args: Vec<String>, total_ms: Option<i64>) -> Vec<EditStep> {
        vec![EditStep::new(args, total_ms, 0.0, 100.0)]
    }
}

/// `rename` fails across volumes (temp dir on C:, gallery on D:/network),
/// so fall back to copy + delete — otherwise every export to another drive
/// would render fully and then fail at the very last step.
pub fn move_into_place(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

pub fn emit_done(app: &AppHandle, job_id: &str, success: bool, output_path: Option<String>, error: Option<String>) {
    let _ = app.emit(
        "edit://done",
        EditDone {
            job_id: job_id.to_string(),
            success,
            output_path,
            error,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn pure_trim_uses_stream_copy() {
        let params = EditParams::default();
        let built = build_command(Path::new("in.mp4"), Path::new("out.mp4"), &params, Some(1920), Some(1080));
        assert!(built.stream_copy);
        assert!(built.args.contains(&"copy".to_string()));
        assert_eq!(built.output_ext, "mp4");
    }

    #[test]
    fn rotate_forces_reencode_with_transpose_filter() {
        let params = EditParams {
            rotate: 90,
            ..Default::default()
        };
        let built = build_command(Path::new("in.mp4"), Path::new("out.mp4"), &params, Some(1920), Some(1080));
        assert!(!built.stream_copy);
        let vf_idx = built.args.iter().position(|a| a == "-vf").expect("has -vf");
        assert!(built.args[vf_idx + 1].contains("transpose=1"));
    }

    #[test]
    fn aspect_crop_centers_and_evens_dimensions() {
        let f = crop_filter("16:9", 1080, 1920).unwrap();
        // Portrait source cropped to 16:9 landscape: height becomes the
        // constraint (1080 * 9/16 = 607.5 -> even-rounded).
        assert!(f.starts_with("crop=1080:608"));
    }

    #[test]
    fn webm_format_uses_vp9_opus() {
        let params = EditParams {
            format: "webm".to_string(),
            rotate: 90, // force re-encode path
            ..Default::default()
        };
        let built = build_command(Path::new("in.mp4"), Path::new("out.webm"), &params, Some(1920), Some(1080));
        assert!(built.args.contains(&"libvpx-vp9".to_string()));
        assert_eq!(built.output_ext, "webm");
    }

    #[test]
    fn trim_range_emits_ss_and_t() {
        let params = EditParams {
            trim_start_ms: Some(2000),
            trim_end_ms: Some(5000),
            ..Default::default()
        };
        let built = build_command(Path::new("in.mp4"), Path::new("out.mp4"), &params, None, None);
        assert!(built.args.contains(&"-ss".to_string()));
        assert!(built.args.contains(&"2.000".to_string()));
        assert!(built.args.contains(&"-t".to_string()));
        assert!(built.args.contains(&"3.000".to_string()));
    }

    #[test]
    fn atempo_chain_handles_out_of_range_speed() {
        // atempo only accepts 0.5-2.0 per stage; 3x needs two stages.
        let chain = atempo_chain(3.0);
        assert_eq!(chain, "atempo=2.0000,atempo=1.5000");
    }

    #[test]
    fn custom_crop_forces_reencode_and_uses_frame_fractions() {
        let params = EditParams {
            crop: Some(CropRect { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }),
            ..Default::default()
        };
        let built = build_command(Path::new("in.mp4"), Path::new("out.mp4"), &params, Some(1920), Some(1080));
        assert!(!built.stream_copy);
        let vf = &built.args[built.args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert!(vf.starts_with("crop=w='max(2,trunc(round(iw*0.500000)/2)*2)'"));
        assert!(vf.contains("x='trunc(round(iw*0.100000)/2)*2'"));
    }

    #[test]
    fn full_frame_crop_is_a_noop() {
        let params = EditParams {
            crop: Some(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }),
            ..Default::default()
        };
        let built = build_command(Path::new("in.mp4"), Path::new("out.mp4"), &params, Some(1920), Some(1080));
        assert!(built.stream_copy);
    }

    #[test]
    fn custom_crop_overrides_aspect_preset() {
        let params = EditParams {
            crop: Some(CropRect { x: 0.0, y: 0.0, w: 0.5, h: 0.5 }),
            aspect: "1:1".to_string(),
            ..Default::default()
        };
        let filters = build_video_filters(&params, Some(1920), Some(1080));
        assert_eq!(filters.len(), 1);
        assert!(filters[0].contains("iw*0.500000"));
    }

    #[test]
    fn pingpong_loop_builds_reverse_concat_graph() {
        let params = EditParams { loop_pingpong: true, loop_count: 1, ..Default::default() };
        let plan = build_loop_plan(Path::new("in.mp4"), Path::new("cycle.mp4"), Path::new("out.mp4"), &params, Some(1920), Some(1080), true);
        assert!(plan.repeat_args.is_none());
        let graph = &plan.cycle_args[plan.cycle_args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(graph.contains("reverse"));
        assert!(graph.contains("areverse"));
        assert!(graph.contains("concat=n=2:v=1:a=1"));
        assert_eq!(plan.cycle_args.last().unwrap(), "out.mp4");
    }

    #[test]
    fn pingpong_repeat_uses_lossless_stream_loop() {
        let params = EditParams { loop_pingpong: true, loop_count: 5, mute: true, ..Default::default() };
        let plan = build_loop_plan(Path::new("in.mp4"), Path::new("cycle.mp4"), Path::new("out.mp4"), &params, None, None, true);
        // Cycle goes to the scratch file; the repeat pass writes the final.
        assert_eq!(plan.cycle_args.last().unwrap(), "cycle.mp4");
        let graph = &plan.cycle_args[plan.cycle_args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(!graph.contains("areverse"), "muted -> no audio in the loop");
        let repeat = plan.repeat_args.unwrap();
        let idx = repeat.iter().position(|a| a == "-stream_loop").unwrap();
        assert_eq!(repeat[idx + 1], "4");
        assert!(repeat.contains(&"copy".to_string()));
        assert_eq!(repeat.last().unwrap(), "out.mp4");
    }

    #[test]
    fn reverse_memory_estimate_accounts_for_crop() {
        let full = EditParams::default();
        let cropped = EditParams { crop: Some(CropRect { x: 0.0, y: 0.0, w: 0.5, h: 0.5 }), ..Default::default() };
        let a = estimate_reverse_bytes(&full, 1920, 1080, 30.0, 10_000);
        let b = estimate_reverse_bytes(&cropped, 1920, 1080, 30.0, 10_000);
        assert!(b * 3 < a);
    }

    #[test]
    fn source_webm_loop_uses_vp9_not_h264() {
        let params = EditParams { loop_pingpong: true, ..Default::default() };
        let plan = build_loop_plan(Path::new("in.webm"), Path::new("c.webm"), Path::new("o.webm"), &params, None, None, false);
        assert_eq!(plan.output_ext, "webm");
        assert!(plan.cycle_args.contains(&"libvpx-vp9".to_string()));
        assert!(!plan.cycle_args.contains(&"libx264".to_string()));
    }
}
