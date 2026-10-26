//! Raw-frame pass for watermark/object removal. FFmpeg decodes the selected
//! part of the source to raw RGB24 frames; each frame is composited here
//! (inpaint/blur/pixelate/cover, see `watermark.rs`); a second FFmpeg encodes
//! the processed stream and muxes the (trimmed) original audio back in.
//! It exists because neither an arbitrary brush mask nor real pixel-guessing
//! inpaint can be written as an FFmpeg filter graph. Everything else the
//! editor does (trim, crop, rotate, colour, speed, loop, ...) stays ordinary
//! FFmpeg invocations — `job.rs` chains this pass in front of them so the
//! user gets one export for all of it.
//!
//! Synchronous on purpose: the pipe between the processes gives natural
//! backpressure (the decoder can never run ahead of the encoder and pile up
//! multi-megabyte frames in memory), and the whole thing is callable from a
//! test without any app runtime.

use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::Instant;

use super::inpaint::InpaintScratch;
use super::runner::{drain_stderr, hide_window, tail_of, Cancel};
use super::watermark::{self, RemovalRegion};

pub struct WatermarkPass<'a> {
    pub ffmpeg: &'a Path,
    pub source: &'a Path,
    pub output: &'a Path,
    /// The selected range, in the source's timeline. Regions with their own
    /// start/end times are matched against the source timeline too.
    pub start_ms: i64,
    /// Length to cut (`-t`); `None` = to the end.
    pub range_ms: Option<i64>,
    /// Length used to estimate progress when `range_ms` is `None`.
    pub expected_ms: Option<i64>,
    /// Frame size as *displayed* (after the container's rotation is applied —
    /// FFmpeg autorotates before it hands out raw frames, and the regions
    /// were drawn on the same picture in the editor).
    pub width: usize,
    pub height: usize,
    pub fps: f64,
    /// Carry the source's audio into the output (aac).
    pub with_audio: bool,
    pub regions: &'a [RemovalRegion],
    pub crf: &'a str,
}

impl WatermarkPass<'_> {
    fn decoder_args(&self) -> Vec<String> {
        let mut a: Vec<String> = vec!["-nostdin".into(), "-v".into(), "error".into(), "-y".into()];
        if self.start_ms > 0 {
            a.extend(["-ss".into(), format!("{:.3}", self.start_ms as f64 / 1000.0)]);
        }
        if let Some(r) = self.range_ms {
            a.extend(["-t".into(), format!("{:.3}", r as f64 / 1000.0)]);
        }
        a.extend([
            "-i".into(),
            self.source.to_string_lossy().to_string(),
            "-map".into(),
            "0:v:0".into(),
            "-an".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "rgb24".into(),
            "pipe:1".into(),
        ]);
        a
    }

    fn encoder_args(&self) -> Vec<String> {
        let mut a: Vec<String> = vec![
            "-v".into(),
            "error".into(),
            "-y".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "rgb24".into(),
            "-s".into(),
            format!("{}x{}", self.width, self.height),
            "-r".into(),
            format!("{:.5}", self.fps),
            "-i".into(),
            "pipe:0".into(),
        ];
        if self.with_audio {
            // Same window as the video: input-side seek on the second input.
            if self.start_ms > 0 {
                a.extend(["-ss".into(), format!("{:.3}", self.start_ms as f64 / 1000.0)]);
            }
            if let Some(r) = self.range_ms {
                a.extend(["-t".into(), format!("{:.3}", r as f64 / 1000.0)]);
            }
            a.extend(["-i".into(), self.source.to_string_lossy().to_string()]);
        }
        a.extend(["-map".into(), "0:v:0".into()]);
        if self.with_audio {
            a.extend(["-map".into(), "1:a:0?".into()]);
        }
        a.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            self.crf.to_string(),
            // Raw RGB carries no colour-range tag; without an explicit remap
            // libx264 tags the result full-range "yuvj420p", which Windows'
            // hardware H.264 decoder (what WebView2's <video> uses) can show
            // as a black picture.
            "-vf".into(),
            "scale=out_range=tv".into(),
            "-color_range".into(),
            "tv".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);
        if self.with_audio {
            a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "256k".into(), "-shortest".into()]);
        } else {
            a.push("-an".into());
        }
        a.extend([
            "-movflags".into(),
            "+faststart".into(),
            self.output.to_string_lossy().to_string(),
        ]);
        a
    }
}

/// Reads exactly `buf.len()` bytes; `Ok(false)` on a clean end of stream
/// before the first byte (a partial trailing frame counts as the end too).
fn read_frame(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => return Ok(false),
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

/// Runs the pass; `on_progress` gets 0..=100.
pub fn run_watermark_pass(
    p: &WatermarkPass,
    on_progress: &mut dyn FnMut(f64),
    cancel: &Cancel,
) -> Result<(), String> {
    if p.width == 0 || p.height == 0 {
        return Err("could not determine the video's frame size".into());
    }
    let frame_size = p.width * p.height * 3;
    let fps = if p.fps > 0.0 { p.fps } else { 30.0 };
    let total_frames = p.range_ms.or(p.expected_ms).map(|ms| ((ms as f64 / 1000.0) * fps).round().max(1.0));

    let mut dec_cmd = Command::new(p.ffmpeg);
    dec_cmd.args(p.decoder_args()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut dec_cmd);
    let mut decoder = dec_cmd.spawn().map_err(|e| format!("could not start ffmpeg (decoder): {e}"))?;

    let mut enc_cmd = Command::new(p.ffmpeg);
    enc_cmd.args(p.encoder_args()).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    hide_window(&mut enc_cmd);
    let mut encoder = match enc_cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = decoder.kill();
            return Err(format!("could not start ffmpeg (encoder): {e}"));
        }
    };

    let mut dec_out = decoder.stdout.take().ok_or("no decoder stdout")?;
    let dec_err = drain_stderr(decoder.stderr.take().ok_or("no decoder stderr")?);
    let mut enc_in = encoder.stdin.take().ok_or("no encoder stdin")?;
    let enc_err = drain_stderr(encoder.stderr.take().ok_or("no encoder stderr")?);

    let mut scratch: Vec<InpaintScratch> = (0..p.regions.len()).map(|_| InpaintScratch::default()).collect();
    let mut frame = vec![0u8; frame_size];
    let mut frames: u64 = 0;
    let mut cancelled = false;
    let mut write_failed = false;
    let mut last_emit = Instant::now();

    loop {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        match read_frame(&mut dec_out, &mut frame) {
            Ok(true) => {}
            Ok(false) | Err(_) => break,
        }
        let t_ms = p.start_ms + ((frames as f64 / fps) * 1000.0).round() as i64;
        watermark::apply_regions_to_frame(&mut frame, p.width, p.height, p.regions, t_ms, &mut scratch);
        if enc_in.write_all(&frame).is_err() {
            write_failed = true;
            break;
        }
        frames += 1;
        if last_emit.elapsed().as_millis() > 120 {
            last_emit = Instant::now();
            let pct = match total_frames {
                Some(t) => (frames as f64 / t * 100.0).min(99.0),
                None => 100.0 * (1.0 - 1.0 / (1.0 + frames as f64 / 300.0)),
            };
            on_progress(pct);
        }
    }

    if cancelled || write_failed {
        let _ = decoder.kill();
    }
    // Closing the encoder's stdin is how it learns the video stream ended.
    drop(enc_in);
    drop(dec_out);

    let dec_status = decoder.wait();
    let enc_status = encoder.wait();
    let dec_stderr = dec_err.join().unwrap_or_default();
    let enc_stderr = enc_err.join().unwrap_or_default();

    if cancelled || cancel.load(Ordering::Relaxed) {
        let _ = std::fs::remove_file(p.output);
        return Err("cancelled".into());
    }

    let enc_ok = matches!(&enc_status, Ok(s) if s.success());
    let dec_ok = matches!(&dec_status, Ok(s) if s.success());
    // A decoder that hit a damaged tail after producing frames still leaves a
    // usable result; one that produced nothing never does.
    if frames == 0 || !enc_ok || (write_failed && !enc_ok) {
        let _ = std::fs::remove_file(p.output);
        let mut detail = String::new();
        if frames == 0 || !dec_ok {
            detail.push_str(&format!("decoder (frames: {frames}): {}", tail_of(&dec_stderr, 400)));
        }
        if !enc_ok {
            if !detail.is_empty() {
                detail.push_str(" || ");
            }
            detail.push_str(&format!("encoder: {}", tail_of(&enc_stderr, 400)));
        }
        if detail.is_empty() {
            detail = "watermark removal failed".into();
        }
        return Err(detail);
    }
    if !p.output.exists() {
        return Err("ffmpeg reported success but produced no output".into());
    }
    on_progress(100.0);
    Ok(())
}
