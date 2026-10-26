//! One export = one job, however many edits it carries. The user can trim,
//! crop, rotate, flip, recolour, change speed, render a ping-pong loop *and*
//! remove watermarks in a single go; this module turns that into the FFmpeg
//! work it takes:
//!
//! * no watermark regions → the ordinary edit (one FFmpeg run, or the
//!   two-step loop render);
//! * watermark regions → a raw-frame pass first (`pipeline.rs`) that trims the
//!   clip and paints the regions out on the *original* frames — the regions
//!   are drawn on the un-cropped, un-rotated picture — then the ordinary
//!   edit runs on that cleaned clip for everything else. When nothing else
//!   is left to do, the pass writes the final file directly (one encode).

use std::path::{Path, PathBuf};

use super::pipeline::{run_watermark_pass, WatermarkPass};
use super::runner::{run_steps, Cancel};
use super::watermark::RemovalRegion;
use super::{
    audio_codec_pub, build_chunked_loop, build_command, build_loop_plan, estimate_reverse_bytes, loop_output_ext,
    quality_to_crf, video_encode_args_pub, ChunkedLoopInput, EditParams, EditStep, Segment,
};

/// Up to this many bytes of raw frames a ping-pong loop is reversed in one FFmpeg run (`reverse`
/// holds them all in RAM, and FFmpeg's real footprint is a few times that); a longer / larger clip
/// is reversed piece by piece instead.
const SINGLE_PASS_LIMIT: u64 = 512 * 1024 * 1024;
#[cfg(not(test))]
fn single_pass_limit() -> u64 {
    SINGLE_PASS_LIMIT
}
#[cfg(test)]
static TEST_LIMIT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(SINGLE_PASS_LIMIT);
#[cfg(test)]
fn single_pass_limit() -> u64 {
    TEST_LIMIT.load(std::sync::atomic::Ordering::Relaxed)
}

/// What the job needs to know about the source. Dimensions are the
/// *displayed* ones (rotation metadata already applied).
#[derive(Debug, Clone, Default)]
pub struct SourceInfo {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub has_audio: bool,
    pub duration_ms: Option<i64>,
}

pub struct JobCtx<'a> {
    pub ffmpeg: &'a Path,
    pub source: &'a Path,
    pub tmp_dir: &'a Path,
    pub job_id: &'a str,
    /// Where the finished file is written (a temp path; the caller moves it into place).
    pub final_tmp: &'a Path,
}

pub struct EditPlan {
    pub steps: Vec<EditStep>,
    /// Intermediate files to delete afterwards.
    pub scratch: Vec<PathBuf>,
    pub stream_copy: bool,
}

/// The kept pieces when the user cut more than one part out (`None` for the ordinary single range).
fn multi_segments(p: &EditParams) -> Option<&[Segment]> {
    (p.segments.len() >= 2).then_some(p.segments.as_slice())
}

/// Pieces must be at least 0.1 s, in order, not overlapping, and start inside the video.
fn check_segments(segs: &[Segment], duration_ms: Option<i64>) -> Result<(), String> {
    let mut prev_end = 0;
    for (i, s) in segs.iter().enumerate() {
        if s.start_ms < 0 || s.end_ms - s.start_ms < 100 {
            return Err(format!("part {} is shorter than 0.1 s", i + 1));
        }
        if i > 0 && s.start_ms < prev_end {
            return Err("the parts overlap or are out of order".into());
        }
        if duration_ms.is_some_and(|d| s.start_ms >= d) {
            return Err(format!("part {} starts after the end of the video", i + 1));
        }
        prev_end = s.end_ms;
    }
    Ok(())
}

/// Length of each piece, clipped to the video's end when it is known.
fn segment_lengths(segs: &[Segment], duration_ms: Option<i64>) -> Vec<i64> {
    segs.iter()
        .map(|s| {
            let end = duration_ms.map(|d| s.end_ms.min(d)).unwrap_or(s.end_ms);
            (end - s.start_ms).max(0)
        })
        .collect()
}

/// A watermark region's time window (source timeline) placed on the joined timeline. `None` when
/// it falls entirely inside a part that was cut out.
fn map_region(r: &RemovalRegion, segs: &[Segment], lens: &[i64]) -> Option<RemovalRegion> {
    if r.start_ms.is_none() && r.end_ms.is_none() {
        return Some(r.clone());
    }
    let (ws, we) = (r.start_ms.unwrap_or(i64::MIN), r.end_ms.unwrap_or(i64::MAX));
    let (mut out_s, mut out_e) = (None, None);
    let mut offset = 0;
    for (s, len) in segs.iter().zip(lens) {
        let (a, b) = (ws.max(s.start_ms), we.min(s.start_ms + len));
        if a <= b {
            out_s.get_or_insert(offset + (a - s.start_ms));
            out_e = Some(offset + (b - s.start_ms));
        }
        offset += len;
    }
    let (start, end) = (out_s?, out_e?);
    Some(RemovalRegion {
        start_ms: r.start_ms.map(|_| start),
        end_ms: r.end_ms.map(|_| end),
        ..r.clone()
    })
}

/// Everything else the user asked for, once the kept pieces have been joined: the trim is spent
/// and timed watermark regions now refer to the joined timeline.
fn after_join(p: &EditParams, segs: &[Segment], lens: &[i64]) -> EditParams {
    let mut rest = p.clone();
    rest.segments.clear();
    rest.trim_start_ms = None;
    rest.trim_end_ms = None;
    rest.removal = p.removal.iter().filter_map(|r| map_region(r, segs, lens)).collect();
    rest
}

/// Length of the selected range in the source timeline.
pub fn range_ms(p: &EditParams, duration_ms: Option<i64>) -> Option<i64> {
    if let Some(segs) = multi_segments(p) {
        return Some(segment_lengths(segs, duration_ms).iter().sum());
    }
    match (p.trim_start_ms, p.trim_end_ms) {
        (Some(s), Some(e)) => Some((e - s).max(0)),
        (Some(s), None) => duration_ms.map(|d| (d - s).max(0)),
        (None, Some(e)) => Some(e.max(0)),
        (None, None) => duration_ms,
    }
}

/// Container of the file this job will produce.
pub fn output_ext_for(p: &EditParams, source: &Path) -> String {
    if !p.removal.is_empty() {
        // The watermark pass always writes MP4; WebM is a later re-encode.
        return if p.format == "webm" { "webm".into() } else { "mp4".into() };
    }
    if p.loop_pingpong {
        loop_output_ext(p, source)
    } else {
        build_command(source, Path::new(""), p, None, None).output_ext
    }
}

/// The ordinary (non-watermark) edit as FFmpeg steps.
pub fn plan_edit_steps(
    source: &Path,
    tmp_dir: &Path,
    job_id: &str,
    final_tmp: &Path,
    p: &EditParams,
    info: &SourceInfo,
    range: Option<i64>,
) -> Result<EditPlan, String> {
    if !p.loop_pingpong {
        let built = build_command(source, final_tmp, p, info.width, info.height);
        let total_ms = range.map(|d| (d as f64 / p.speed.max(0.01)) as i64);
        return Ok(EditPlan {
            steps: EditStep::single(built.args, total_ms),
            scratch: vec![],
            stream_copy: built.stream_copy,
        });
    }

    let range = range.ok_or("this video's duration isn't known yet — wait for the scan to finish, then try again")?;
    if range < 200 {
        return Err("the selected range is too short to loop".into());
    }
    // `reverse` holds every frame it reverses in RAM, so a big clip is reversed piece by piece
    // (see `build_chunked_loop`) instead of being refused.
    if let (Some(w), Some(h)) = (info.width, info.height) {
        let limit = single_pass_limit();
        if estimate_reverse_bytes(p, w, h, info.fps.unwrap_or(30.0), range) > limit {
            let hours = range as f64 / 3_600_000.0;
            if info.has_audio && !p.mute && hours > 3.0 {
                return Err("a ping-pong loop of more than 3 hours needs the sound off (mute it) or a shorter range".into());
            }
            let chunked = build_chunked_loop(&ChunkedLoopInput {
                source,
                tmp_dir,
                job_id,
                final_output: final_tmp,
                p,
                width: w,
                height: h,
                fps: info.fps.unwrap_or(30.0),
                has_audio: info.has_audio,
                range_ms: range,
                budget_bytes: limit / 2,
            });
            return Ok(EditPlan { steps: chunked.steps, scratch: chunked.scratch, stream_copy: false });
        }
    }
    let ext = loop_output_ext(p, source);
    let cycle_tmp = tmp_dir.join(format!("{job_id}.tmp.cycle.{ext}"));
    let plan = build_loop_plan(source, &cycle_tmp, final_tmp, p, info.width, info.height, info.has_audio);
    let cycle_ms = ((range as f64 / p.speed.max(0.01)) * 2.0) as i64;
    Ok(match plan.repeat_args {
        Some(repeat) => {
            let total_ms = cycle_ms * p.loop_count.clamp(1, 9999) as i64;
            EditPlan {
                steps: vec![
                    EditStep::new(plan.cycle_args, Some(cycle_ms), 0.0, 85.0),
                    EditStep::new(repeat, Some(total_ms), 85.0, 100.0),
                ],
                scratch: vec![cycle_tmp],
                stream_copy: false,
            }
        }
        None => EditPlan {
            steps: EditStep::single(plan.cycle_args, Some(cycle_ms)),
            scratch: vec![],
            stream_copy: false,
        },
    })
}

/// Checks a job can run *before* anything starts (so an impossible request
/// fails instantly instead of after a long watermark pass). Returns whether
/// the job will be a lossless stream copy.
pub fn validate(p: &EditParams, source: &Path, info: &SourceInfo) -> Result<bool, String> {
    if let Some(segs) = multi_segments(p) {
        check_segments(segs, info.duration_ms)?;
        let lens = segment_lengths(segs, info.duration_ms);
        let rest = after_join(p, segs, &lens);
        let info2 = SourceInfo { duration_ms: Some(lens.iter().sum()), has_audio: info.has_audio && !p.mute, ..info.clone() };
        validate(&rest, source, &info2)?;
        return Ok(false);
    }
    let range = range_ms(p, info.duration_ms);
    let scratch = Path::new("");
    if p.removal.is_empty() {
        return plan_edit_steps(source, scratch, "check", scratch, p, info, range).map(|plan| plan.stream_copy);
    }
    if info.width.is_none() || info.height.is_none() {
        return Err("could not determine the video's dimensions for watermark removal".into());
    }
    if range.is_some_and(|r| r < 200) {
        return Err("the selected range is too short".into());
    }
    let mut rest = p.clone();
    rest.removal.clear();
    rest.trim_start_ms = None;
    rest.trim_end_ms = None;
    let info2 = SourceInfo { duration_ms: range, has_audio: info.has_audio && !p.mute, ..info.clone() };
    plan_edit_steps(source, scratch, "check", scratch, &rest, &info2, range)?;
    Ok(false)
}

fn cleanup(files: &[PathBuf]) {
    for f in files {
        let _ = std::fs::remove_file(f);
    }
}

/// Runs the whole job. `on_progress` gets one 0..=100 bar across every stage.
pub fn run_job(
    ctx: &JobCtx,
    p: &EditParams,
    info: &SourceInfo,
    on_progress: &mut dyn FnMut(f64),
    cancel: &Cancel,
) -> Result<(), String> {
    if let Some(segs) = multi_segments(p) {
        return run_segments(ctx, p, info, segs, on_progress, cancel);
    }
    let range = range_ms(p, info.duration_ms);

    if p.removal.is_empty() {
        let plan = plan_edit_steps(ctx.source, ctx.tmp_dir, ctx.job_id, ctx.final_tmp, p, info, range)?;
        let result = run_steps(ctx.ffmpeg, &plan.steps, on_progress, cancel);
        cleanup(&plan.scratch);
        return result;
    }

    // ---- watermark removal first, on the original frames ----
    let (Some(w), Some(h)) = (info.width, info.height) else {
        return Err("could not determine the video's dimensions for watermark removal".into());
    };
    let fps = info.fps.filter(|f| *f > 0.0).unwrap_or(30.0);

    // What's left for the ordinary edit once the removal is done. The trim was
    // already applied by the pass, so it must not be applied a second time.
    let mut rest = p.clone();
    rest.removal.clear();
    rest.trim_start_ms = None;
    rest.trim_end_ms = None;

    let intermediate = ctx.tmp_dir.join(format!("{}.tmp.wm.mp4", ctx.job_id));
    let finish_here = !rest.loop_pingpong
        && rest.format != "webm"
        && build_command(&intermediate, ctx.final_tmp, &rest, Some(w), Some(h)).stream_copy;

    let target: &Path = if finish_here { ctx.final_tmp } else { &intermediate };
    // A stepping-stone gets a near-transparent quality; the final encode gets
    // the quality the user asked for.
    let crf = if finish_here { quality_to_crf(&p.quality) } else { "14" };
    let split = if finish_here { 100.0 } else { 62.0 };
    let trimmed = p.trim_start_ms.is_some() || p.trim_end_ms.is_some();

    let pass = WatermarkPass {
        ffmpeg: ctx.ffmpeg,
        source: ctx.source,
        output: target,
        start_ms: p.trim_start_ms.unwrap_or(0).max(0),
        range_ms: if trimmed { range } else { None },
        expected_ms: range,
        width: w as usize,
        height: h as usize,
        fps,
        with_audio: info.has_audio && !p.mute,
        regions: &p.removal,
        crf,
    };
    let mut stage1 = |pc: f64| on_progress(pc * split / 100.0);
    if let Err(e) = run_watermark_pass(&pass, &mut stage1, cancel) {
        cleanup(&[intermediate]);
        return Err(e);
    }
    if finish_here {
        return Ok(());
    }

    // ---- everything else the user asked for, on the cleaned clip ----
    let info2 = SourceInfo {
        duration_ms: range,
        has_audio: info.has_audio && !p.mute,
        ..info.clone()
    };
    let plan = match plan_edit_steps(&intermediate, ctx.tmp_dir, ctx.job_id, ctx.final_tmp, &rest, &info2, range) {
        Ok(plan) => plan,
        Err(e) => {
            cleanup(&[intermediate]);
            return Err(e);
        }
    };
    let mut stage2 = |pc: f64| on_progress(split + pc * (100.0 - split) / 100.0);
    let result = run_steps(ctx.ffmpeg, &plan.steps, &mut stage2, cancel);
    cleanup(&plan.scratch);
    cleanup(&[intermediate]);
    result
}

/// Cuts several parts out: the kept pieces are joined first, then everything else the user asked
/// for (crop, rotate, watermark, loop…) runs on the joined clip as if it were the source.
///
/// When joining is all there is to do, the result goes straight to the output — as a stream copy
/// with "Fast Cut" (keyframe-snapped, nothing re-encoded) or a single frame-accurate encode with
/// "Accurate Cut". Otherwise the join goes to a near-lossless intermediate first.
fn run_segments(
    ctx: &JobCtx,
    p: &EditParams,
    info: &SourceInfo,
    segs: &[Segment],
    on_progress: &mut dyn FnMut(f64),
    cancel: &Cancel,
) -> Result<(), String> {
    check_segments(segs, info.duration_ms)?;
    let lens = segment_lengths(segs, info.duration_ms);
    let total: i64 = lens.iter().sum();
    let rest = after_join(p, segs, &lens);
    let with_audio = info.has_audio && !p.mute;
    let only_join = rest.removal.is_empty()
        && !rest.loop_pingpong
        && build_command(ctx.source, ctx.final_tmp, &rest, info.width, info.height).stream_copy;
    let src = ctx.source.to_string_lossy().to_string();
    let final_is_webm = ctx.final_tmp.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("webm"));
    let mut scratch: Vec<PathBuf> = vec![];

    // ---- 1. fast: one stream-copying pass of the concat demuxer, reading each piece straight out
    // of the source (`inpoint` snaps back to the keyframe before it, `outpoint` ends exactly) ----
    if only_join && !p.accurate_cut {
        let quote = |f: &str| f.replace('\\', "/").replace('\'', "'\\''");
        let mut list = String::new();
        for (s, len) in segs.iter().zip(&lens) {
            list.push_str(&format!(
                "file '{}'
inpoint {:.3}
outpoint {:.3}
",
                quote(&src),
                s.start_ms as f64 / 1000.0,
                (s.start_ms + len) as f64 / 1000.0
            ));
        }
        let list_path = ctx.tmp_dir.join(format!("{}.tmp.parts.txt", ctx.job_id));
        let mut join: Vec<String> = ["-y", "-nostdin", "-f", "concat", "-safe", "0", "-i"].iter().map(|a| a.to_string()).collect();
        join.push(list_path.to_string_lossy().to_string());
        join.extend(["-map".into(), "0:v:0".into()]);
        if with_audio {
            join.extend(["-map".into(), "0:a:0?".into()]);
        }
        join.extend(["-c".into(), "copy".into(), "-avoid_negative_ts".into(), "make_zero".into()]);
        if !final_is_webm {
            join.extend(["-movflags".into(), "+faststart".into()]);
        }
        join.push(ctx.final_tmp.to_string_lossy().to_string());
        let mut step = EditStep::new(join, Some(total), 0.0, 100.0);
        step.list_file = Some((list_path.clone(), list));
        scratch.push(list_path);
        let result = run_steps(ctx.ffmpeg, &[step], on_progress, cancel);
        cleanup(&scratch);
        return result;
    }

    // ---- 2. accurate: every piece is its own input (seeking straight to it), joined in one encode ----
    let target: PathBuf = if only_join { ctx.final_tmp.to_path_buf() } else { ctx.tmp_dir.join(format!("{}.tmp.joined.mkv", ctx.job_id)) };
    let mut args: Vec<String> = vec!["-y".into(), "-nostdin".into()];
    for (s, len) in segs.iter().zip(&lens) {
        args.extend(["-ss".into(), format!("{:.3}", s.start_ms as f64 / 1000.0), "-t".into(), format!("{:.3}", *len as f64 / 1000.0), "-i".into(), src.clone()]);
    }
    let mut graph = String::new();
    for i in 0..segs.len() {
        graph.push_str(&format!("[{i}:v:0]"));
        if with_audio {
            graph.push_str(&format!("[{i}:a:0]"));
        }
    }
    graph.push_str(&format!("concat=n={}:v=1:a={}[v]{}", segs.len(), u8::from(with_audio), if with_audio { "[a]" } else { "" }));
    args.extend(["-filter_complex".into(), graph, "-map".into(), "[v]".into()]);
    if with_audio {
        args.extend(["-map".into(), "[a]".into()]);
    }
    if only_join {
        args.extend(video_encode_args_pub(final_is_webm, &p.quality));
        if with_audio {
            args.extend(["-c:a".into(), audio_codec_pub(final_is_webm).into()]);
        }
        if !final_is_webm {
            args.extend(["-movflags".into(), "+faststart".into()]);
        }
    } else {
        // a stepping stone: near-lossless, quick to write
        args.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p"].iter().map(|a| a.to_string()));
        if with_audio {
            args.extend(["-c:a", "aac", "-b:a", "256k"].iter().map(|a| a.to_string()));
        }
        args.extend(["-f".into(), "matroska".into()]);
    }
    args.push(target.to_string_lossy().to_string());
    let split = if only_join { 100.0 } else { 45.0 };
    if let Err(e) = run_steps(ctx.ffmpeg, &[EditStep::new(args, Some(total), 0.0, split)], on_progress, cancel) {
        if !only_join {
            cleanup(&[target]);
        }
        return Err(e);
    }
    if only_join {
        return Ok(());
    }

    // ---- 3. everything else, on the joined clip ----
    let info2 = SourceInfo { duration_ms: Some(total), has_audio: with_audio, ..info.clone() };
    let ctx2 = JobCtx { ffmpeg: ctx.ffmpeg, source: &target, tmp_dir: ctx.tmp_dir, job_id: ctx.job_id, final_tmp: ctx.final_tmp };
    let mut stage2 = |pc: f64| on_progress(split + pc * (100.0 - split) / 100.0);
    let result = run_job(&ctx2, &rest, &info2, &mut stage2, cancel);
    cleanup(&[target]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::runner::new_cancel;
    use crate::editor::watermark::RemovalRegion;
    use crate::editor::CropRect;
    use std::process::Command;
    use std::sync::atomic::Ordering;

    /// The bundled FFmpeg/FFprobe, if this checkout has them (tests that need
    /// real media are skipped otherwise).
    fn tools() -> Option<(PathBuf, PathBuf)> {
        let bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("bin");
        let ffmpeg = bin.join("ffmpeg-x86_64-pc-windows-msvc.exe");
        let ffprobe = bin.join("ffprobe-x86_64-pc-windows-msvc.exe");
        (ffmpeg.exists() && ffprobe.exists()).then_some((ffmpeg, ffprobe))
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qpg-job-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_clip(ffmpeg: &Path, out: &Path, secs: u32, w: u32, h: u32, audio: bool) {
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("testsrc=duration={secs}:size={w}x{h}:rate=30"));
        if audio {
            cmd.args(["-f", "lavfi", "-i"]).arg(format!("sine=frequency=440:duration={secs}"));
        }
        cmd.args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30"]);
        if audio {
            cmd.args(["-c:a", "aac", "-shortest"]);
        }
        assert!(cmd.arg(out).status().unwrap().success(), "could not generate the test clip");
    }

    struct Probed {
        w: i64,
        h: i64,
        duration: f64,
        has_audio: bool,
        video_codec: String,
    }

    fn probe(ffprobe: &Path, file: &Path) -> Probed {
        let out = Command::new(ffprobe)
            .args(["-v", "error", "-print_format", "json", "-show_streams", "-show_format"])
            .arg(file)
            .output()
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("ffprobe json");
        let streams = v["streams"].as_array().unwrap();
        let video = streams.iter().find(|s| s["codec_type"] == "video").expect("video stream");
        Probed {
            w: video["width"].as_i64().unwrap(),
            h: video["height"].as_i64().unwrap(),
            duration: v["format"]["duration"].as_str().unwrap().parse().unwrap(),
            has_audio: streams.iter().any(|s| s["codec_type"] == "audio"),
            video_codec: video["codec_name"].as_str().unwrap().to_string(),
        }
    }

    /// Number of (nearly) black pixels in the frame at `at_s`.
    fn black_pixels(ffmpeg: &Path, file: &Path, at_s: f64) -> usize {
        let out = Command::new(ffmpeg)
            .args(["-v", "error", "-ss", &format!("{at_s}"), "-i"])
            .arg(file)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap();
        out.stdout.chunks_exact(3).filter(|p| p[0] < 24 && p[1] < 24 && p[2] < 24).count()
    }

    fn cover(x: i64, y: i64, w: i64, h: i64) -> RemovalRegion {
        RemovalRegion {
            mode: "cover".into(),
            x,
            y,
            w,
            h,
            start_ms: None,
            end_ms: None,
            color: Some("#000000".into()),
            mask: None,
        }
    }

    fn info_of(ffprobe: &Path, clip: &Path) -> SourceInfo {
        let p = probe(ffprobe, clip);
        SourceInfo {
            width: Some(p.w),
            height: Some(p.h),
            fps: Some(30.0),
            has_audio: p.has_audio,
            duration_ms: Some((p.duration * 1000.0) as i64),
        }
    }

    fn run(ffmpeg: &Path, dir: &Path, src: &Path, name: &str, p: &EditParams, info: &SourceInfo) -> Result<PathBuf, String> {
        let out = dir.join(format!("{name}.tmp.{}", output_ext_for(p, src)));
        let ctx = JobCtx { ffmpeg, source: src, tmp_dir: dir, job_id: name, final_tmp: &out };
        let mut last = 0.0_f64;
        let mut progress = |pc: f64| {
            assert!(pc >= last - 1e-6, "progress went backwards: {last} -> {pc}");
            assert!((0.0..=100.0001).contains(&pc), "progress out of range: {pc}");
            last = pc;
        };
        run_job(&ctx, p, info, &mut progress, &new_cancel())?;
        assert!(last >= 99.0, "progress never reached the end ({last})");
        Ok(out)
    }

    #[test]
    fn trim_crop_rotate_and_watermark_removal_in_a_single_job() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("combined");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 6, 320, 240, true);
        let info = info_of(&ffprobe, &src);

        let base = EditParams {
            trim_start_ms: Some(1000),
            trim_end_ms: Some(4000),
            crop: Some(CropRect { x: 0.0, y: 0.25, w: 1.0, h: 0.75 }), // top 25 % off
            rotate: 90,
            ..Default::default()
        };
        // A patch in the area that survives the crop, drawn on the ORIGINAL frame.
        let with_removal = EditParams { removal: vec![cover(100, 100, 80, 50)], ..base.clone() };

        let cleaned = run(&ffmpeg, &dir, &src, "cleaned", &with_removal, &info).unwrap();
        let reference = run(&ffmpeg, &dir, &src, "reference", &base, &info).unwrap();

        let out = probe(&ffprobe, &cleaned);
        assert_eq!((out.w, out.h), (180, 320), "crop 320x180 then rotate 90");
        assert!((out.duration - 3.0).abs() < 0.25, "trimmed to 3 s, got {}", out.duration);
        assert!(out.has_audio, "audio kept");
        assert_eq!(out.video_codec, "h264");

        let painted = black_pixels(&ffmpeg, &cleaned, 1.0);
        let plain = black_pixels(&ffmpeg, &reference, 1.0);
        assert!(painted >= plain + 3000, "the 80x50 patch must be blacked out ({painted} vs {plain})");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watermark_removal_alone_keeps_size_length_and_audio() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("wmonly");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 4, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        let p = EditParams {
            removal: vec![RemovalRegion { mode: "inpaint".into(), ..cover(20, 20, 60, 40) }],
            ..Default::default()
        };
        let out = run(&ffmpeg, &dir, &src, "wm", &p, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert_eq!((o.w, o.h), (320, 240));
        assert!((o.duration - 4.0).abs() < 0.25, "got {}", o.duration);
        assert!(o.has_audio);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watermark_removal_together_with_speed_mute_and_flip() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("mix");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 6, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        let p = EditParams {
            trim_start_ms: Some(0),
            trim_end_ms: Some(4000),
            speed: 2.0,
            mute: true,
            flip_h: true,
            removal: vec![cover(10, 10, 50, 30)],
            ..Default::default()
        };
        let out = run(&ffmpeg, &dir, &src, "mix", &p, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert!((o.duration - 2.0).abs() < 0.3, "4 s at 2x -> 2 s, got {}", o.duration);
        assert!(!o.has_audio, "muted");
        assert_eq!((o.w, o.h), (320, 240));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watermark_removal_plus_pingpong_loop() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("loop");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 4, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        let p = EditParams {
            trim_start_ms: Some(0),
            trim_end_ms: Some(2000),
            loop_pingpong: true,
            loop_count: 2,
            removal: vec![cover(30, 30, 60, 40)],
            ..Default::default()
        };
        let out = run(&ffmpeg, &dir, &src, "loop", &p, &info).unwrap();
        let o = probe(&ffprobe, &out);
        // 2 s forward + 2 s back, twice.
        assert!((o.duration - 8.0).abs() < 0.5, "got {}", o.duration);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watermark_removal_to_webm() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("webm");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 3, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        let p = EditParams { format: "webm".into(), removal: vec![cover(30, 30, 60, 40)], ..Default::default() };
        let out = run(&ffmpeg, &dir, &src, "webm", &p, &info).unwrap();
        assert_eq!(out.extension().unwrap(), "webm");
        let o = probe(&ffprobe, &out);
        assert_eq!(o.video_codec, "vp9");
        assert!((o.duration - 3.0).abs() < 0.3, "got {}", o.duration);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn watermark_regions_follow_the_displayed_orientation_of_a_rotated_source() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("rot");
        let plain = dir.join("plain.mp4");
        make_clip(&ffmpeg, &plain, 3, 320, 240, false);
        // Same pixels, but flagged "display rotated 90 degrees": shown as 240x320.
        let rotated = dir.join("rotated.mp4");
        let ok = Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-display_rotation", "90", "-i"])
            .arg(&plain)
            .args(["-c", "copy"])
            .arg(&rotated)
            .status()
            .unwrap()
            .success();
        if !ok {
            return; // this FFmpeg cannot write a display matrix
        }
        // What the app computes from the DB: coded 320x240 + rotation 270 -> displayed 240x320.
        let info = SourceInfo { width: Some(240), height: Some(320), fps: Some(30.0), has_audio: false, duration_ms: Some(3000) };
        let p = EditParams { removal: vec![cover(60, 200, 100, 60)], ..Default::default() };
        let out = run(&ffmpeg, &dir, &rotated, "rot", &p, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert_eq!((o.w, o.h), (240, 320), "output keeps the displayed orientation");
        let reference = run(&ffmpeg, &dir, &rotated, "rotref", &EditParams { removal: vec![cover(0, 0, 1, 1)], ..Default::default() }, &info).unwrap();
        assert!(black_pixels(&ffmpeg, &out, 1.0) >= black_pixels(&ffmpeg, &reference, 1.0) + 4500);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_cancelled_job_stops_and_leaves_nothing_behind() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("cancel");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 3, 320, 240, false);
        let info = info_of(&ffprobe, &src);
        let p = EditParams { removal: vec![cover(30, 30, 60, 40)], ..Default::default() };
        let out = dir.join("out.tmp.mp4");
        let ctx = JobCtx { ffmpeg: &ffmpeg, source: &src, tmp_dir: &dir, job_id: "c", final_tmp: &out };
        let cancel = new_cancel();
        cancel.store(true, Ordering::Relaxed);
        let err = run_job(&ctx, &p, &info, &mut |_| {}, &cancel).unwrap_err();
        assert_eq!(err, "cancelled");
        assert!(!out.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plain_webm_conversion_reencodes_instead_of_copying_h264() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("webmplain");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 3, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        let p = EditParams { format: "webm".into(), ..Default::default() };
        assert!(!validate(&p, &src, &info).unwrap(), "not a stream copy");
        let out = run(&ffmpeg, &dir, &src, "webmplain", &p, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert_eq!(o.video_codec, "vp9");
        assert!(o.has_audio);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn timed_regions_are_matched_against_the_source_timeline_after_a_trim() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("timed");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 6, 320, 240, false);
        let info = info_of(&ffprobe, &src);
        // Active only from 2.0 s to 3.0 s of the ORIGINAL video; the export starts at 1.0 s,
        // so the patch must show at output 1.0-2.0 s and not before or after.
        let timed = RemovalRegion { start_ms: Some(2000), end_ms: Some(3000), ..cover(100, 100, 80, 50) };
        let p = EditParams { trim_start_ms: Some(1000), trim_end_ms: Some(5000), removal: vec![timed], ..Default::default() };
        let out = run(&ffmpeg, &dir, &src, "timed", &p, &info).unwrap();
        let none = EditParams { trim_start_ms: Some(1000), trim_end_ms: Some(5000), ..Default::default() };
        let plain = run(&ffmpeg, &dir, &src, "timedref", &none, &info).unwrap();
        let extra = |t: f64| black_pixels(&ffmpeg, &out, t) as i64 - black_pixels(&ffmpeg, &plain, t) as i64;
        assert!(extra(0.4).abs() < 400, "not yet active at output 0.4 s: {}", extra(0.4));
        assert!(extra(1.5) > 3000, "active at output 1.5 s (source 2.5 s): {}", extra(1.5));
        assert!(extra(2.6).abs() < 400, "over again at output 2.6 s: {}", extra(2.6));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Throughput check on real-sized frames; run on demand with
    /// `cargo test --lib bench_1080p -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_1080p_watermark_pass() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("bench");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 5, 1920, 1080, true);
        let info = info_of(&ffprobe, &src);
        let p = EditParams {
            crop: Some(CropRect { x: 0.0, y: 0.1, w: 1.0, h: 0.9 }),
            rotate: 90,
            removal: vec![
                RemovalRegion { mode: "inpaint".into(), ..cover(1600, 40, 260, 90) },
                RemovalRegion { mode: "blur".into(), ..cover(40, 900, 300, 120) },
            ],
            ..Default::default()
        };
        let t = std::time::Instant::now();
        let out = run(&ffmpeg, &dir, &src, "bench", &p, &info).unwrap();
        let secs = t.elapsed().as_secs_f64();
        let o = probe(&ffprobe, &out);
        println!("1080p x 150 frames, 2 regions + crop + rotate: {secs:.1}s ({:.1} fps), out {}x{}", 150.0 / secs, o.w, o.h);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn everything_at_once_without_watermark_uses_one_ffmpeg_run() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("std");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 6, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        let p = EditParams {
            trim_start_ms: Some(500),
            trim_end_ms: Some(3500),
            crop: Some(CropRect { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }),
            rotate: 270,
            flip_v: true,
            brightness: 0.1,
            speed: 1.5,
            target_width: Some(120),
            ..Default::default()
        };
        assert_eq!(plan_edit_steps(&src, &dir, "x", &dir.join("o.mp4"), &p, &info, range_ms(&p, info.duration_ms)).unwrap().steps.len(), 1);
        let out = run(&ffmpeg, &dir, &src, "std", &p, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert!((o.duration - 2.0).abs() < 0.3, "3 s at 1.5x -> 2 s, got {}", o.duration);
        assert!(o.has_audio);
        // crop 160x120 -> scaled to width 120 (90 tall) -> rotated 270: 90 x 120
        assert_eq!((o.w, o.h), (90, 120));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The frame at `at_s` as raw RGB bytes.
    fn frame_rgb(ffmpeg: &Path, file: &Path, at_s: f64) -> Vec<u8> {
        Command::new(ffmpeg)
            .args(["-v", "error", "-ss", &format!("{at_s}"), "-i"])
            .arg(file)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap()
            .stdout
    }

    fn mean_abs_diff(a: &[u8], b: &[u8]) -> f64 {
        let n = a.len().min(b.len()).max(1);
        a.iter().zip(b).map(|(x, y)| (*x as f64 - *y as f64).abs()).sum::<f64>() / n as f64
    }

    #[test]
    fn a_big_pingpong_loop_is_reversed_piece_by_piece_and_still_mirrors_itself() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("chunked");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 6, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        // pretend the clip is huge: a tiny limit forces the piecewise path (pieces of >= 1 s)
        TEST_LIMIT.store(1024 * 1024, std::sync::atomic::Ordering::Relaxed);
        let p = EditParams { loop_pingpong: true, loop_count: 2, speed: 1.0, ..Default::default() };
        let plan = plan_edit_steps(&src, &dir, "chunkjob", &dir.join("plan.mp4"), &p, &info, Some(6000)).unwrap();
        assert!(plan.steps.len() >= 7, "forward + several pieces + audio + join + repeat, got {}", plan.steps.len());
        let out = run(&ffmpeg, &dir, &src, "chunked", &p, &info);
        TEST_LIMIT.store(SINGLE_PASS_LIMIT, std::sync::atomic::Ordering::Relaxed);
        let out = out.unwrap();
        let o = probe(&ffprobe, &out);
        // 6 s forward + 6 s back, twice (minus the dropped duplicate frame each cycle)
        assert!((o.duration - 24.0).abs() < 0.6, "got {}", o.duration);
        assert!(o.has_audio, "the audio is kept, forward then backward");
        assert_eq!(o.video_codec, "h264");
        // the second half is the first half backwards: a frame and its mirror image match
        let (a, b) = (frame_rgb(&ffmpeg, &out, 2.0), frame_rgb(&ffmpeg, &out, 12.0 - 2.0));
        let unrelated = frame_rgb(&ffmpeg, &out, 5.0);
        let (same, other) = (mean_abs_diff(&a, &b), mean_abs_diff(&a, &unrelated));
        assert!(same < other / 3.0 && same < 12.0, "mirror frames should match ({same:.1} vs {other:.1})");
        assert!(!dir.join("chunkjob.tmp.fwd.mkv").exists(), "scratch files are removed");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn seg(a: i64, b: i64) -> Segment {
        Segment { start_ms: a, end_ms: b }
    }

    #[test]
    fn several_parts_are_joined_fast_by_copy_or_accurately_by_encoding() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("segs");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 8, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        // keep 0-2 s and 5-7 s: 4 s in total
        let parts = vec![seg(0, 2000), seg(5000, 7000)];

        let accurate = EditParams { segments: parts.clone(), accurate_cut: true, ..Default::default() };
        let out = run(&ffmpeg, &dir, &src, "acc", &accurate, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert!((o.duration - 4.0).abs() < 0.2, "accurate join: {}", o.duration);
        assert!(o.has_audio);
        // the frame just after the join is the source's picture at 5 s, not 2 s
        let joined = frame_rgb(&ffmpeg, &out, 2.1);
        let at5 = frame_rgb(&ffmpeg, &src, 5.1);
        let at2 = frame_rgb(&ffmpeg, &src, 2.1);
        assert!(mean_abs_diff(&joined, &at5) < mean_abs_diff(&joined, &at2) / 2.0, "the cut-out part is gone");

        let fast = EditParams { segments: parts.clone(), ..Default::default() };
        let out = run(&ffmpeg, &dir, &src, "fast", &fast, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert!((o.duration - 4.0).abs() < 0.2, "fast join (keyframe-snapped): {}", o.duration);
        assert_eq!(o.video_codec, "h264");
        assert!(std::fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".tmp.parts")), "the list is cleaned up");
        let joined = frame_rgb(&ffmpeg, &out, 2.5);
        assert!(mean_abs_diff(&joined, &frame_rgb(&ffmpeg, &src, 5.5)) < mean_abs_diff(&joined, &frame_rgb(&ffmpeg, &src, 2.5)) / 2.0, "fast join: the cut-out part is gone");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn several_parts_then_rotate_mute_and_a_loop() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("segs2");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 8, 320, 240, true);
        let info = info_of(&ffprobe, &src);
        let p = EditParams {
            segments: vec![seg(1000, 2000), seg(4000, 5500)],
            rotate: 90,
            mute: true,
            loop_pingpong: true,
            loop_count: 2,
            ..Default::default()
        };
        assert_eq!(validate(&p, &src, &info), Ok(false));
        let out = run(&ffmpeg, &dir, &src, "rot", &p, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert_eq!((o.w, o.h), (240, 320));
        assert!(!o.has_audio);
        // 2.5 s joined, forward + back, twice
        assert!((o.duration - 10.0).abs() < 0.6, "got {}", o.duration);
        assert!(!dir.join("rot.tmp.joined.mkv").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn several_parts_with_a_timed_watermark_window() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch_dir("segs3");
        let src = dir.join("src.mp4");
        make_clip(&ffmpeg, &src, 6, 320, 240, false);
        let info = info_of(&ffprobe, &src);
        // black box only during 4-5 s of the source; kept: 0-1 s and 4-5 s -> it shows during 1-2 s of the output
        let p = EditParams {
            segments: vec![seg(0, 1000), seg(4000, 5000)],
            removal: vec![RemovalRegion { start_ms: Some(4000), end_ms: Some(5000), ..cover(0, 0, 120, 100) }],
            ..Default::default()
        };
        let out = run(&ffmpeg, &dir, &src, "wmseg", &p, &info).unwrap();
        let o = probe(&ffprobe, &out);
        assert!((o.duration - 2.0).abs() < 0.3, "got {}", o.duration);
        assert!(black_pixels(&ffmpeg, &out, 1.5) >= black_pixels(&ffmpeg, &out, 0.5) + 5000, "the box follows its window onto the joined timeline");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parts_are_checked_before_anything_runs() {
        let src = Path::new("in.mp4");
        let info = SourceInfo { width: Some(320), height: Some(240), fps: Some(30.0), has_audio: true, duration_ms: Some(10_000) };
        let bad = |parts: Vec<Segment>| validate(&EditParams { segments: parts, ..Default::default() }, src, &info);
        assert!(bad(vec![seg(0, 50), seg(1000, 2000)]).is_err(), "too short");
        assert!(bad(vec![seg(0, 3000), seg(2000, 4000)]).is_err(), "overlap");
        assert!(bad(vec![seg(0, 1000), seg(11_000, 12_000)]).is_err(), "past the end");
        assert_eq!(bad(vec![seg(0, 1000), seg(2000, 3000)]), Ok(false));
        assert_eq!(range_ms(&EditParams { segments: vec![seg(0, 1000), seg(8000, 12_000)], ..Default::default() }, Some(10_000)), Some(3000));
    }

    #[test]
    fn impossible_requests_are_rejected_before_anything_runs() {
        let src = Path::new("in.mp4");
        let unknown_len = SourceInfo { width: Some(1920), height: Some(1080), fps: Some(30.0), has_audio: true, duration_ms: None };
        let looped = EditParams { loop_pingpong: true, ..Default::default() };
        assert!(validate(&looped, src, &unknown_len).is_err());

        // a clip too big to reverse in memory is reversed piece by piece, not refused
        let huge = SourceInfo { duration_ms: Some(120_000), ..unknown_len.clone() };
        assert_eq!(validate(&looped, src, &huge), Ok(false));
        let endless = SourceInfo { duration_ms: Some(4 * 3_600_000), ..unknown_len.clone() };
        assert!(validate(&looped, src, &endless).unwrap_err().contains("3 hours"));
        assert_eq!(validate(&EditParams { mute: true, ..looped.clone() }, src, &endless), Ok(false));

        let no_dims = SourceInfo { width: None, height: None, ..unknown_len.clone() };
        let wm = EditParams { removal: vec![cover(0, 0, 10, 10)], ..Default::default() };
        assert!(validate(&wm, src, &no_dims).is_err());

        // Pure trim stays a lossless stream copy.
        let trim = EditParams { trim_start_ms: Some(1000), trim_end_ms: Some(2000), ..Default::default() };
        assert_eq!(validate(&trim, src, &SourceInfo { duration_ms: Some(5000), ..unknown_len }), Ok(true));
    }
}
