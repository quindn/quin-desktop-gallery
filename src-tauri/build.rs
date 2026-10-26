//! Build script. Two jobs:
//!
//! 1. Pack the helper programs (FFmpeg, FFprobe, yt-dlp) with zstd into
//!    `OUT_DIR`. `src/tools.rs` embeds them with `include_bytes!`, so the app
//!    ships as ONE executable and unpacks them on first run.
//! 2. Keep the exe's icon resource fresh (see the notes below).

use std::fs;
use std::io;
use std::path::PathBuf;

const TOOLS: &[(&str, &str)] = &[
    ("ffmpeg", "ffmpeg-x86_64-pc-windows-msvc.exe"),
    ("ffprobe", "ffprobe-x86_64-pc-windows-msvc.exe"),
    ("yt-dlp", "yt-dlp-x86_64-pc-windows-msvc.exe"),
];

fn pack(out_dir: &PathBuf, manifest_dir: &PathBuf, name: &str, file: &str) -> io::Result<()> {
    let src = manifest_dir.join("bin").join(file);
    let dst = out_dir.join(format!("{name}.zst"));
    fs::create_dir_all(out_dir)?;
    println!("cargo:rerun-if-changed={}", src.display());

    if !src.exists() {
        // Builds without the helpers still compile; the app then looks for the
        // tool on PATH / next to the exe at run time.
        println!("cargo:warning={} not found in src-tauri/bin — it will not be embedded", file);
        fs::write(&dst, [])?;
        return Ok(());
    }
    // Reuse the previous output when it is newer than the source (compressing
    // ~150 MB takes a while).
    if let (Ok(s), Ok(d)) = (fs::metadata(&src), fs::metadata(&dst)) {
        if d.len() > 0 && matches!((s.modified(), d.modified()), (Ok(sm), Ok(dm)) if dm > sm) {
            return Ok(());
        }
    }
    let mut input = fs::File::open(&src)?;
    let out = fs::File::create(&dst)?;
    let mut enc = zstd::stream::Encoder::new(out, 12)?;
    let threads = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(4);
    enc.multithread(threads)?;
    io::copy(&mut input, &mut enc)?;
    enc.finish()?;
    Ok(())
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // One shared cache (not OUT_DIR): check / test / release builds all reuse
    // the same packed files instead of recompressing ~300 MB each.
    let out_dir = manifest_dir.join(".packed");
    for (name, file) in TOOLS {
        pack(&out_dir, &manifest_dir, name, file).unwrap_or_else(|e| panic!("packing {file}: {e}"));
    }
    // The uBlock Origin extension is embedded too (a few MB).
    println!("cargo:rerun-if-changed=resources/ublock-origin.zip");

    // The Windows exe icon is compiled into a resource by tauri-build. Without
    // these, swapping the icon files leaves a stale resource in the build cache
    // and the exe keeps showing its old icon in Explorer.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    tauri_build::build()
}
