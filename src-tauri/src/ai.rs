//! AI video enhancement, both with small ncnn / Vulkan tools that run on the graphics card:
//! - smoother motion: RIFE (frame interpolation) puts real in-between frames between every pair,
//!   2× / 3× / 4× the frame rate;
//! - a sharper picture: Real-ESRGAN (general video model, or the anime one) restores detail at the
//!   same size or makes the video 2× bigger.
//!
//! The tools are downloaded on first use into `data/bin/ai` (only the few files needed are pulled
//! out of the release zips with HTTP range requests). A job decodes the video with FFmpeg, runs the
//! tool chunk by chunk on PNG frames in the temp folder (so disk use stays small), and pipes the
//! result back into one FFmpeg encode with the original sound.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::editor::runner::Cancel;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const RIFE_ZIP: &str = "https://github.com/TNTwise/rife-ncnn-vulkan/releases/download/20250112/windows.zip";
const RIFE_IN: &str = "rife-ncnn-vulkan-refs/heads/master-windows/";
const ESRGAN_ZIP: &str = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip";
const GENERAL_MODEL: &str = "https://raw.githubusercontent.com/upscayl/custom-models/main/models/RealESRGAN_General_x4_v3";

pub const RIFE_BEST: &str = "rife-v4.26";
pub const RIFE_FAST: &str = "rife-v4.6";
const GENERAL_NAME: &str = "RealESRGAN_General_x4_v3";
const ANIME_NAME: &str = "realesr-animevideov3";

pub fn dir() -> PathBuf {
    crate::paths::tools_dir().join("ai")
}
fn rife_exe() -> PathBuf {
    dir().join("rife").join("rife-ncnn-vulkan.exe")
}
fn esrgan_exe() -> PathBuf {
    dir().join("esrgan").join("realesrgan-ncnn-vulkan.exe")
}

/// (source, entry in the zip or "" for a plain file, where it goes under data/bin/ai)
fn files_for(tool: &str) -> Vec<(String, String, String)> {
    let mut v = vec![];
    match tool {
        "rife" => {
            for (entry, dest) in [
                ("rife-ncnn-vulkan.exe", "rife/rife-ncnn-vulkan.exe"),
                ("vcomp140.dll", "rife/vcomp140.dll"),
                ("LICENSE", "rife/LICENSE.txt"),
            ] {
                v.push((RIFE_ZIP.to_string(), format!("{RIFE_IN}{entry}"), dest.to_string()));
            }
            for m in [RIFE_BEST, RIFE_FAST] {
                for f in ["flownet.bin", "flownet.param"] {
                    v.push((RIFE_ZIP.to_string(), format!("{RIFE_IN}{m}/{f}"), format!("rife/{m}/{f}")));
                }
            }
        }
        _ => {
            for (entry, dest) in [
                ("realesrgan-ncnn-vulkan.exe", "esrgan/realesrgan-ncnn-vulkan.exe"),
                ("vcomp140.dll", "esrgan/vcomp140.dll"),
                ("models/realesr-animevideov3-x2.bin", "esrgan/models/realesr-animevideov3-x2.bin"),
                ("models/realesr-animevideov3-x2.param", "esrgan/models/realesr-animevideov3-x2.param"),
            ] {
                v.push((ESRGAN_ZIP.to_string(), entry.to_string(), dest.to_string()));
            }
            for ext in ["bin", "param"] {
                v.push((format!("{GENERAL_MODEL}.{ext}"), String::new(), format!("esrgan/models/{GENERAL_NAME}.{ext}")));
            }
        }
    }
    v
}

pub fn installed(tool: &str) -> bool {
    files_for(tool).iter().all(|(_, _, d)| dir().join(d).metadata().map(|m| m.len() > 0).unwrap_or(false))
}

// ------------------------------------------------------------------ download (zip entries by range)

struct ZipEntry {
    method: u16,
    csize: u64,
    usize: u64,
    local: u64,
}

fn le16(b: &[u8], at: usize) -> u64 {
    u16::from_le_bytes([b[at], b[at + 1]]) as u64
}
fn le32(b: &[u8], at: usize) -> u64 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap()) as u64
}
fn le64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

async fn get_range(client: &reqwest::Client, url: &str, range: String) -> Result<(Vec<u8>, Option<u64>), String> {
    let r = client.get(url).header("Range", range).send().await.map_err(|e| e.to_string())?;
    if r.status().as_u16() != 206 {
        return Err(format!("the download server didn't allow a partial download ({})", r.status()));
    }
    let total = r
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|s| s.parse().ok());
    Ok((r.bytes().await.map_err(|e| e.to_string())?.to_vec(), total))
}

/// The central directory of a remote zip.
async fn zip_index(client: &reqwest::Client, url: &str) -> Result<HashMap<String, ZipEntry>, String> {
    // (no suffix ranges: GitHub's file servers refuse "bytes=-N")
    let total = get_range(client, url, "bytes=0-0".into()).await?.1.ok_or("no size from the download server")?;
    let tail_start = total.saturating_sub(65558);
    let (tail, _) = get_range(client, url, format!("bytes={}-{}", tail_start, total - 1)).await?;
    let eocd = (0..tail.len().saturating_sub(21)).rev().find(|&i| tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06]).ok_or("not a zip file")?;
    let (mut cd_size, mut cd_off) = (le32(&tail, eocd + 12), le32(&tail, eocd + 16));
    if cd_size == 0xFFFF_FFFF || cd_off == 0xFFFF_FFFF {
        // zip64: the locator sits right before the end record
        let loc = eocd.checked_sub(20).ok_or("bad zip64")?;
        let rec = le64(&tail, loc + 8);
        let (r, _) = get_range(client, url, format!("bytes={}-{}", rec, rec + 55)).await?;
        cd_size = le64(&r, 40);
        cd_off = le64(&r, 48);
    }
    let cd = if cd_off >= tail_start {
        tail[(cd_off - tail_start) as usize..(cd_off - tail_start + cd_size) as usize].to_vec()
    } else {
        get_range(client, url, format!("bytes={}-{}", cd_off, cd_off + cd_size - 1)).await?.0
    };
    let mut out = HashMap::new();
    let mut p = 0usize;
    while p + 46 <= cd.len() && cd[p..p + 4] == [0x50, 0x4b, 0x01, 0x02] {
        let (nlen, elen, clen) = (le16(&cd, p + 28) as usize, le16(&cd, p + 30) as usize, le16(&cd, p + 32) as usize);
        let name = String::from_utf8_lossy(&cd[p + 46..p + 46 + nlen]).to_string();
        let mut e = ZipEntry { method: le16(&cd, p + 10) as u16, csize: le32(&cd, p + 20), usize: le32(&cd, p + 24), local: le32(&cd, p + 42) };
        // zip64 extra field: only the values that overflowed, in this order
        let extra = &cd[p + 46 + nlen..p + 46 + nlen + elen];
        let mut q = 0;
        while q + 4 <= extra.len() {
            let (id, len) = (le16(extra, q), le16(extra, q + 2) as usize);
            if id == 1 {
                let mut at = q + 4;
                for v in [&mut e.usize, &mut e.csize, &mut e.local] {
                    if *v == 0xFFFF_FFFF && at + 8 <= q + 4 + len {
                        *v = le64(extra, at);
                        at += 8;
                    }
                }
            }
            q += 4 + len;
        }
        out.insert(name, e);
        p += 46 + nlen + elen + clen;
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallProgress {
    pub tool: String,
    pub done: u64,
    pub total: u64,
}

async fn fetch_to(client: &reqwest::Client, url: &str, range: Option<String>, mut on_bytes: impl FnMut(u64)) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let mut req = client.get(url);
    if let Some(r) = range {
        req = req.header("Range", r);
    }
    let r = req.send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("download failed ({})", r.status()));
    }
    let mut buf = vec![];
    let mut s = r.bytes_stream();
    while let Some(c) = s.next().await {
        let c = c.map_err(|e| e.to_string())?;
        on_bytes(c.len() as u64);
        buf.extend_from_slice(&c);
    }
    Ok(buf)
}

/// Downloads one tool (only what it needs), reporting progress.
pub async fn install(tool: &str, progress: impl Fn(InstallProgress) + Send + Sync) -> Result<(), String> {
    let client = reqwest::Client::builder().user_agent("QuinGallery").timeout(Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let files = files_for(tool);
    let mut indexes: HashMap<String, HashMap<String, ZipEntry>> = HashMap::new();
    for (src, entry, _) in &files {
        if !entry.is_empty() && !indexes.contains_key(src) {
            indexes.insert(src.clone(), zip_index(&client, src).await?);
        }
    }
    let total: u64 = files
        .iter()
        .map(|(src, entry, _)| if entry.is_empty() { 2_500_000 } else { indexes[src].get(entry).map(|e| e.csize).unwrap_or(0) })
        .sum();
    let mut done = 0u64;
    let tool_s = tool.to_string();
    for (src, entry, dest) in &files {
        let dest = dir().join(dest);
        if dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            continue;
        }
        let mut tick = |n: u64| {
            done += n;
            progress(InstallProgress { tool: tool_s.clone(), done: done.min(total), total });
        };
        let data = if entry.is_empty() {
            fetch_to(&client, src, None, &mut tick).await?
        } else {
            let e = indexes[src].get(entry).ok_or_else(|| format!("{entry} is missing from the download"))?;
            let (h, _) = get_range(&client, src, format!("bytes={}-{}", e.local, e.local + 29)).await?;
            let start = e.local + 30 + le16(&h, 26) + le16(&h, 28);
            let raw = fetch_to(&client, src, Some(format!("bytes={}-{}", start, start + e.csize - 1)), &mut tick).await?;
            let data = match e.method {
                0 => raw,
                8 => {
                    let mut out = Vec::with_capacity(e.usize as usize);
                    flate2::read::DeflateDecoder::new(&raw[..]).read_to_end(&mut out).map_err(|e| e.to_string())?;
                    out
                }
                m => return Err(format!("unsupported compression {m}")),
            };
            if data.len() as u64 != e.usize {
                return Err(format!("{entry}: the download was damaged"));
            }
            data
        };
        if data.is_empty() {
            return Err("an empty file was downloaded".into());
        }
        std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        let part = dest.with_extension("part");
        std::fs::write(&part, &data).map_err(|e| e.to_string())?;
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }
    if tool == "esrgan" {
        let _ = std::fs::write(
            dir().join("esrgan").join("LICENSE.txt"),
            "Real-ESRGAN ncnn Vulkan — Copyright (c) 2021, Xintao Wang. BSD 3-Clause License.\nhttps://github.com/xinntao/Real-ESRGAN\nGeneral video model (realesr-general-x4v3) by Xintao Wang, ncnn conversion from the Upscayl project.\n",
        );
    }
    *GPU.lock().unwrap() = None; // check again with the new tool
    Ok(())
}

// ------------------------------------------------------------------ graphics card check

static GPU: Mutex<Option<Option<String>>> = Mutex::new(None);

fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}

/// The Vulkan graphics card the tools will use (None: there is none — RIFE then runs on the
/// processor, slowly, and Real-ESRGAN can't run). Found with a tiny test run, then remembered.
pub fn gpu() -> Option<String> {
    if let Some(g) = GPU.lock().unwrap().clone() {
        return g;
    }
    let found = (|| {
        if !installed("rife") {
            return None;
        }
        let t = std::env::temp_dir().join(format!("qg-ai-gpu-{}", std::process::id()));
        let (i, o) = (t.join("in"), t.join("out"));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&i).ok()?;
        std::fs::create_dir_all(&o).ok()?;
        for (n, v) in [(1u8, 40u8), (2, 200)] {
            image::RgbImage::from_pixel(64, 64, image::Rgb([v, v, v])).save(i.join(format!("{n:08}.png"))).ok()?;
        }
        let out = no_window(Command::new(rife_exe()).args(["-n", "4", "-g", "0", "-f", "%08d.png", "-m"]).arg(dir().join("rife").join(RIFE_FAST)).arg("-i").arg(&i).arg("-o").arg(&o))
            .stdin(Stdio::null())
            .output()
            .ok()?;
        let made = std::fs::read_dir(&o).map(|d| d.count()).unwrap_or(0);
        let _ = std::fs::remove_dir_all(&t);
        if made != 4 {
            return None;
        }
        let err = String::from_utf8_lossy(&out.stderr);
        let name = err.lines().find_map(|l| l.strip_prefix("[0 ").and_then(|r| r.split(']').next()).map(|s| s.to_string()));
        Some(name.unwrap_or_else(|| "graphics card".into()))
    })();
    *GPU.lock().unwrap() = Some(found.clone());
    found
}

// ------------------------------------------------------------------ the job

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// "smooth" or "sharpen"
    pub mode: String,
    /// smooth: frames per original frame (2..4)
    pub factor: u32,
    /// smooth: "best" (RIFE 4.26) or "fast" (RIFE 4.6)
    pub quality: String,
    /// sharpen: "real" or "anime"
    pub content: String,
    /// sharpen: make it 2× bigger (else: same size, sharper)
    pub upscale: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self { mode: "smooth".into(), factor: 2, quality: "best".into(), content: "real".into(), upscale: false }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// as FFmpeg writes it ("30000/1001")
    pub fps_expr: String,
    pub duration_ms: i64,
    pub frames: u64,
    pub color_matrix: String,
    pub has_audio: bool,
}

pub fn probe(path: &Path) -> Result<SourceInfo, String> {
    let out = no_window(Command::new(crate::tools::ffprobe()).args(["-v", "error", "-print_format", "json", "-show_streams", "-show_format"]).arg(path))
        .output()
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| "this file can't be read".to_string())?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let s = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1).ok_or("no video in this file")?;
    let (mut w, mut h) = (s["width"].as_u64().unwrap_or(0) as u32, s["height"].as_u64().unwrap_or(0) as u32);
    let rot = s["side_data_list"]
        .as_array()
        .and_then(|l| l.iter().find_map(|d| d["rotation"].as_f64()))
        .or_else(|| s["tags"]["rotate"].as_str().and_then(|r| r.parse().ok()))
        .unwrap_or(0.0);
    if (rot.abs() as i64) % 180 == 90 {
        std::mem::swap(&mut w, &mut h);
    }
    let ratio = |r: &str| -> Option<f64> {
        let (a, b) = r.split_once('/')?;
        let (a, b): (f64, f64) = (a.parse().ok()?, b.parse().ok()?);
        (b > 0.0 && a > 0.0).then(|| a / b)
    };
    let (fps_expr, fps) = [s["avg_frame_rate"].as_str(), s["r_frame_rate"].as_str()]
        .into_iter()
        .flatten()
        .find_map(|r| ratio(r).filter(|f| *f >= 1.0 && *f <= 240.0).map(|f| (r.to_string(), f)))
        .unwrap_or(("30".into(), 30.0));
    let duration = v["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).or_else(|| s["duration"].as_str().and_then(|d| d.parse().ok())).unwrap_or(0.0);
    let matrix = match s["color_space"].as_str() {
        Some("bt709") => "bt709",
        Some("bt470bg") | Some("smpte170m") => "bt601",
        _ if h >= 720 => "bt709",
        _ => "bt601",
    };
    if w == 0 || h == 0 || duration <= 0.0 {
        return Err("this video's size or length can't be read".into());
    }
    Ok(SourceInfo {
        width: w,
        height: h,
        fps,
        fps_expr,
        duration_ms: (duration * 1000.0) as i64,
        frames: (duration * fps).round().max(1.0) as u64,
        color_matrix: matrix.into(),
        has_audio: streams.iter().any(|s| s["codec_type"] == "audio"),
    })
}

fn even(x: f64) -> u32 {
    ((x / 2.0).round() as u32).max(1) * 2
}

/// The frame size the tool reads, and the final size.
pub fn sizes(info: &SourceInfo, o: &Options) -> ((u32, u32), (u32, u32)) {
    let (w, h) = (info.width as f64, info.height as f64);
    if o.mode == "smooth" {
        return ((even(w), even(h)), (even(w), even(h)));
    }
    // sharpen: the tool always gets half the target size (2× model: exactly the target; 4× general
    // model: twice the target, scaled down by the encoder — supersampled)
    let mut target = if o.upscale { (w * 2.0, h * 2.0) } else { (w, h) };
    let cap = (3840.0 / target.0.max(target.1)).min(1.0);
    target = (target.0 * cap, target.1 * cap);
    ((even(target.0 / 2.0), even(target.1 / 2.0)), (even(target.0), even(target.1)))
}

pub fn output_fps(info: &SourceInfo, o: &Options) -> (String, f64) {
    if o.mode == "smooth" {
        let m = o.factor.clamp(2, 4);
        (format!("({})*{m}", info.fps_expr), info.fps * m as f64)
    } else {
        (info.fps_expr.clone(), info.fps)
    }
}

fn wait_tool(mut child: Child, cancel: &Cancel) -> Result<String, String> {
    let mut err = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(reader.join().unwrap_or_default())
}

fn clear_dir(d: &Path) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(d);
    std::fs::create_dir_all(d).map_err(|e| e.to_string())
}

fn write_png(path: &Path, rgb: &[u8], w: u32, h: u32) -> Result<(), String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    let f = std::io::BufWriter::new(std::fs::File::create(path).map_err(|e| e.to_string())?);
    PngEncoder::new_with_quality(f, CompressionType::Fast, FilterType::Sub)
        .write_image(rgb, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())
}

struct Encoder {
    child: Child,
    stdin: Option<ChildStdin>,
    size: (u32, u32),
}

/// Runs a whole job. `progress` gets 0..100.
pub fn run(src: &Path, out: &Path, tmp: &Path, o: &Options, cancel: &Cancel, mut progress: impl FnMut(f64)) -> Result<(), String> {
    let info = probe(src)?;
    let sharpen = o.mode == "sharpen";
    if sharpen && !installed("esrgan") || !sharpen && !installed("rife") {
        return Err("the AI tool isn't downloaded yet".into());
    }
    let gpu = gpu();
    if sharpen && gpu.is_none() {
        return Err("sharpening needs a graphics card with Vulkan, and none was found".into());
    }
    let m = if sharpen { 1 } else { o.factor.clamp(2, 4) as usize };
    let ((iw, ih), (ow, oh)) = sizes(&info, o);
    let frame_len = (iw * ih * 3) as usize;
    // chunk: about 150 MB of frames on disk
    let k = std::env::var("QG_AI_CHUNK").ok().and_then(|v| v.parse().ok()).unwrap_or((150_000_000 / (iw as usize * ih as usize)).clamp(16, 240));
    let (in_dir, out_dir) = (tmp.join("in"), tmp.join("out"));
    let (out_fps_expr, _) = output_fps(&info, o);

    // decoder: constant frame rate, rgb frames on stdout
    let vf = format!("scale={iw}:{ih}:flags={}:in_color_matrix={},format=rgb24", if sharpen { "area" } else { "bicubic" }, info.color_matrix);
    let mut dec = no_window(Command::new(crate::tools::ffmpeg()).args(["-v", "error", "-nostdin", "-i"]).arg(src).args(["-map", "0:v:0", "-vf", &vf, "-fps_mode", "cfr", "-r", &info.fps_expr, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut dec_out = std::io::BufReader::with_capacity(frame_len * 2, dec.stdout.take().unwrap());
    let mut read_frame = || -> Option<Vec<u8>> {
        let mut b = vec![0u8; frame_len];
        dec_out.read_exact(&mut b).ok().map(|_| b)
    };

    let mut enc: Option<Encoder> = None;
    let start_encoder = |size: (u32, u32)| -> Result<Encoder, String> {
        let m709 = info.color_matrix == "bt709";
        let vf = format!("scale={ow}:{oh}:flags=lanczos:out_color_matrix={},format=yuv420p", info.color_matrix);
        let mut c = Command::new(crate::tools::ffmpeg());
        c.args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", &format!("{}x{}", size.0, size.1), "-framerate", &out_fps_expr, "-i", "pipe:0", "-i"])
            .arg(src)
            .args(["-map", "0:v:0", "-map", "1:a:0?", "-vf", &vf, "-c:v", "libx264", "-preset", "medium", "-crf", "18"])
            .args(if m709 { ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"] } else { ["-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "smpte170m"] })
            .args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])
            .arg(out);
        let mut child = no_window(&mut c).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        let stdin = child.stdin.take();
        Ok(Encoder { child, stdin, size })
    };
    let feed = |enc: &mut Option<Encoder>, file: &Path| -> Result<(), String> {
        let img = image::open(file).map_err(|e| format!("a frame from the AI tool can't be read: {e}"))?.to_rgb8();
        let size = img.dimensions();
        if enc.is_none() {
            *enc = Some(start_encoder(size)?);
        }
        let e = enc.as_mut().unwrap();
        if e.size != size {
            return Err("the AI tool returned frames of different sizes".into());
        }
        e.stdin.as_mut().unwrap().write_all(img.as_raw()).map_err(|_| "the video encoder stopped".to_string())
    };

    let result = (|| -> Result<(), String> {
        let mut carried: Option<Vec<u8>> = None;
        let mut consumed: u64 = 0;
        let mut eof = false;
        while !eof {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let mut frames: Vec<Vec<u8>> = carried.take().into_iter().collect();
            let want = if sharpen { k } else { k + 1 };
            while frames.len() < want {
                match read_frame() {
                    Some(f) => {
                        frames.push(f);
                        consumed += 1;
                    }
                    None => {
                        eof = true;
                        break;
                    }
                }
            }
            if frames.is_empty() {
                break;
            }
            clear_dir(&in_dir)?;
            clear_dir(&out_dir)?;
            if !sharpen && frames.len() == 1 {
                // the very last frame alone (or a one-frame video): it's repeated, like the tool does at the end
                for n in 0..m {
                    write_png(&out_dir.join(format!("{:08}.png", n + 1)), &frames[0], iw, ih)?;
                }
            } else {
                for (n, f) in frames.iter().enumerate() {
                    write_png(&in_dir.join(format!("{:08}.png", n + 1)), f, iw, ih)?;
                }
                let expected = if sharpen { frames.len() } else { frames.len() * m };
                let mut cmd = if sharpen {
                    let mut c = Command::new(esrgan_exe());
                    let (name, scale) = if o.content == "anime" { (ANIME_NAME, "2") } else { (GENERAL_NAME, "4") };
                    c.arg("-i").arg(&in_dir).arg("-o").arg(&out_dir).arg("-m").arg(dir().join("esrgan").join("models")).args(["-n", name, "-s", scale, "-g", "0", "-f", "png"]);
                    c
                } else {
                    let mut c = Command::new(rife_exe());
                    let model = if o.quality == "fast" { RIFE_FAST } else { RIFE_BEST };
                    c.arg("-i").arg(&in_dir).arg("-o").arg(&out_dir).arg("-m").arg(dir().join("rife").join(model));
                    c.args(["-n", &expected.to_string(), "-g", if gpu.is_some() { "0" } else { "-1" }, "-f", "%08d.png"]);
                    c
                };
                let child = no_window(&mut cmd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("the AI tool can't start: {e}"))?;
                let log = wait_tool(child, cancel)?;
                let made = std::fs::read_dir(&out_dir).map(|d| d.count()).unwrap_or(0);
                if made != expected {
                    let tail: Vec<&str> = log.lines().rev().take(3).collect();
                    return Err(format!("the AI tool made {made} of {expected} frames ({})", tail.into_iter().rev().collect::<Vec<_>>().join(" / ")));
                }
            }
            // keep: all frames at the end; otherwise up to (not including) the carried frame
            let mut outs: Vec<PathBuf> = std::fs::read_dir(&out_dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok().map(|e| e.path())).collect();
            outs.sort();
            let keep = if sharpen || eof { outs.len() } else { (frames.len() - 1) * m };
            for f in &outs[..keep] {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                feed(&mut enc, f)?;
            }
            if !sharpen && !eof {
                carried = frames.pop();
            }
            progress((consumed as f64 / info.frames.max(1) as f64 * 99.0).min(99.0));
        }
        Ok(())
    })();

    let _ = dec.kill();
    let _ = dec.wait();
    let _ = std::fs::remove_dir_all(tmp);
    let mut enc = enc.ok_or_else(|| result.clone().err().unwrap_or_else(|| "no frames were decoded".into()))?;
    drop(enc.stdin.take());
    if let Err(e) = result {
        let _ = enc.child.kill();
        let _ = enc.child.wait();
        let _ = std::fs::remove_file(out);
        return Err(e);
    }
    let mut err = String::new();
    if let Some(mut s) = enc.child.stderr.take() {
        let _ = s.read_to_string(&mut err);
    }
    let status = enc.child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = std::fs::remove_file(out);
        return Err(format!("encoding failed: {}", err.lines().last().unwrap_or("")));
    }
    progress(100.0);
    Ok(())
}

/// "<name> (60 fps).mp4" / "<name> (AI sharp).mp4" next to the source, never overwriting.
pub fn output_path(src: &Path, info: &SourceInfo, o: &Options) -> PathBuf {
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "video".into());
    let tag = if o.mode == "smooth" {
        format!("{} fps", output_fps(info, o).1.round() as i64)
    } else if o.upscale {
        "AI 2x".to_string()
    } else {
        "AI sharp".to_string()
    };
    let dir = src.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut p = dir.join(format!("{stem} ({tag}).mp4"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({tag}) ({n}).mp4"));
        n += 1;
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(w: u32, h: u32, fps: f64) -> SourceInfo {
        SourceInfo { width: w, height: h, fps, fps_expr: format!("{fps}"), duration_ms: 1000, frames: fps as u64, color_matrix: "bt709".into(), has_audio: true }
    }

    #[test]
    fn sizes_follow_the_mode() {
        let s = Options::default();
        assert_eq!(sizes(&info(1280, 720, 30.0), &s), ((1280, 720), (1280, 720)));
        let mut sh = Options { mode: "sharpen".into(), ..Default::default() };
        assert_eq!(sizes(&info(1280, 720, 30.0), &sh), ((640, 360), (1280, 720)));
        sh.upscale = true;
        assert_eq!(sizes(&info(1280, 720, 30.0), &sh), ((1280, 720), (2560, 1440)));
        // capped at 4K on the long side
        assert_eq!(sizes(&info(3840, 2160, 30.0), &sh).1, (3840, 2160));
        assert_eq!(sizes(&info(1081, 607, 30.0), &Options::default()).0, (1082, 608));
    }

    #[test]
    fn output_rate_and_name() {
        let o = Options { factor: 2, ..Default::default() };
        assert_eq!(output_fps(&info(640, 360, 30.0), &o).1, 60.0);
        assert_eq!(output_fps(&info(640, 360, 24.0), &Options { factor: 3, ..Default::default() }).1, 72.0);
        let d = std::env::temp_dir().join("qg-ai-name-test");
        let _ = std::fs::create_dir_all(&d);
        let p = output_path(&d.join("clip.mp4"), &info(640, 360, 30.0), &o);
        assert_eq!(p.file_name().unwrap(), "clip (60 fps).mp4");
    }

    /// Downloads the real tools and runs every mode on a small clip (network + a Vulkan GPU):
    /// cargo test --lib ai::tests::real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_install_and_run() {
        let base = std::env::temp_dir().join("qg-ai-it");
        let _ = std::fs::create_dir_all(&base);
        std::env::set_var("QG_DATA_DIR", base.join("data"));
        std::env::set_var("QG_AI_CHUNK", "16");
        crate::tools::init();
        let rt = tokio::runtime::Runtime::new().unwrap();
        for t in ["rife", "esrgan"] {
            let t0 = std::time::Instant::now();
            rt.block_on(install(t, |_| {})).unwrap();
            println!("installed {t} in {:?}", t0.elapsed());
            assert!(installed(t));
        }
        println!("gpu: {:?}", gpu());
        assert!(gpu().is_some());
        let ff = crate::tools::ffmpeg();
        let clip = base.join("clip.mp4");
        let st = Command::new(&ff)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
            .arg(&clip)
            .status()
            .unwrap();
        assert!(st.success());
        let frames = |f: &Path, w: u32, h: u32| -> Vec<Vec<u8>> {
            let out = Command::new(&ff).args(["-v", "error", "-i"]).arg(f).args(["-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).output().unwrap().stdout;
            out.chunks((w * h * 3) as usize).map(|c| c.to_vec()).collect()
        };
        let mad = |a: &[u8], b: &[u8]| a.iter().zip(b).map(|(x, y)| (*x as i32 - *y as i32).abs() as f64).sum::<f64>() / a.len() as f64;
        let cancel = crate::editor::runner::new_cancel();
        let src = frames(&clip, 320, 180);
        assert_eq!(src.len(), 60);
        for (o, check) in [
            (Options { mode: "smooth".into(), factor: 2, quality: "best".into(), ..Default::default() }, "smooth2"),
            (Options { mode: "smooth".into(), factor: 3, quality: "fast".into(), ..Default::default() }, "smooth3"),
            (Options { mode: "sharpen".into(), content: "real".into(), upscale: false, ..Default::default() }, "sharp"),
            (Options { mode: "sharpen".into(), content: "anime".into(), upscale: true, ..Default::default() }, "anime2x"),
        ] {
            let out = base.join(format!("{check}.mp4"));
            let t0 = std::time::Instant::now();
            run(&clip, &out, &base.join("tmp"), &o, &cancel, |_| {}).unwrap();
            let i = probe(&out).unwrap();
            println!("{check}: {}x{} {:.2} fps {} ms audio={} in {:?}", i.width, i.height, i.fps, i.duration_ms, i.has_audio, t0.elapsed());
            assert!(i.has_audio);
            assert!((i.duration_ms - 2000).abs() < 120, "{check} duration {}", i.duration_ms);
            match check {
                "smooth2" | "smooth3" => {
                    let m = if check == "smooth2" { 2 } else { 3 };
                    assert!((i.fps - 30.0 * m as f64).abs() < 0.1);
                    let got = frames(&out, 320, 180);
                    assert_eq!(got.len(), 60 * m, "{check} frame count");
                    // originals land on every m-th frame, also around the chunk joins (16, 32, 48)
                    for j in [0usize, 15, 16, 17, 31, 32, 47, 48, 59] {
                        let d = mad(&got[j * m], &src[j]);
                        assert!(d < 4.0, "{check} frame {j}: {d}");
                    }
                    // and the in-between frames are new pictures, between their neighbours
                    for j in [15usize, 16, 31, 32] {
                        let mid = &got[j * m + 1];
                        let (a, b) = (mad(mid, &src[j]), mad(mid, &src[j + 1]));
                        let ab = mad(&src[j], &src[j + 1]);
                        println!("  join {j}: mid-a {a:.2} mid-b {b:.2} a-b {ab:.2}");
                        assert!(a > 0.3 && b > 0.3 && a < ab && b < ab, "{check} in-between at {j}");
                    }
                }
                "sharp" => assert_eq!((i.width, i.height), (320, 180)),
                _ => assert_eq!((i.width, i.height), (640, 360)),
            }
        }
    }

    #[test]
    fn zip64_extra_fields_parse() {
        // the little-endian readers
        let b = [1u8, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(le32(&b, 0), 1);
        assert_eq!(le64(&b, 4), 2);
        assert_eq!(le16(&b, 4), 2);
    }
}
