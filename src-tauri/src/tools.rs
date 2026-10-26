//! The helper programs (FFmpeg, FFprobe, yt-dlp) live INSIDE the app's exe,
//! zstd-packed by `build.rs`, so the whole app is a single file. On first run
//! (and after every app update) they are unpacked into
//! `%LOCALAPPDATA%\QuinGallery\bin\<build id>\` — shared by every copy of the
//! app on the machine, never next to the exe — and spawned from there.
//!
//! Unpacking runs on a background thread; the accessors below wait for it, so
//! nothing can start a tool before it exists.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};

static PACKED_FFMPEG: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/.packed/ffmpeg.zst"));
static PACKED_FFPROBE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/.packed/ffprobe.zst"));
static PACKED_YTDLP: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/.packed/yt-dlp.zst"));
static UBLOCK_ZIP: &[u8] = include_bytes!("../resources/ublock-origin.zip");

#[derive(Debug, Clone)]
pub struct Paths {
    pub dir: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub ytdlp: PathBuf,
}

struct Slot {
    value: Mutex<Option<Paths>>,
    ready: Condvar,
}

static SLOT: OnceLock<Slot> = OnceLock::new();

fn slot() -> &'static Slot {
    SLOT.get_or_init(|| Slot { value: Mutex::new(None), ready: Condvar::new() })
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The app's data folder (`data/` next to the exe).
pub fn root_dir() -> PathBuf {
    crate::paths::data_dir().to_path_buf()
}

/// yt-dlp keeps a cache; keep it inside the data folder too.
pub fn ytdlp_cache_args() -> [String; 2] {
    ["--cache-dir".to_string(), crate::paths::cache_dir().join("yt-dlp").to_string_lossy().to_string()]
}

fn build_id() -> String {
    let mut h = blake3::Hasher::new();
    for part in [PACKED_FFMPEG, PACKED_FFPROBE, PACKED_YTDLP, UBLOCK_ZIP] {
        h.update(&(part.len() as u64).to_le_bytes());
        h.update(part);
    }
    h.finalize().to_hex()[..12].to_string()
}

fn write_unpacked(packed: &[u8], dst: &Path) -> io::Result<()> {
    let tmp = dst.with_extension("part");
    {
        let mut out = fs::File::create(&tmp)?;
        zstd::stream::copy_decode(packed, &mut out)?;
    }
    if dst.exists() {
        let _ = fs::remove_file(dst);
    }
    fs::rename(&tmp, dst)
}

fn unpack() -> io::Result<Paths> {
    let dir = crate::paths::tools_dir().join(build_id());
    fs::create_dir_all(&dir)?;
    let mut paths = Paths {
        ffmpeg: dir.join(exe_name("ffmpeg")),
        ffprobe: dir.join(exe_name("ffprobe")),
        ytdlp: dir.join(exe_name("yt-dlp")),
        dir: dir.clone(),
    };
    let done = dir.join(".complete");
    if !done.exists() {
        for (packed, dst) in [
            (PACKED_FFMPEG, &paths.ffmpeg),
            (PACKED_FFPROBE, &paths.ffprobe),
            (PACKED_YTDLP, &paths.ytdlp),
        ] {
            if !packed.is_empty() {
                write_unpacked(packed, dst)?;
            }
        }
        // uBlock Origin, unpacked for the embedded browser.
        let ext = dir.join("extensions");
        let _ = fs::remove_dir_all(&ext);
        if let Err(e) = unzip_ublock(&ext) {
            eprintln!("could not unpack uBlock Origin: {e}");
        }
        fs::write(&done, b"ok")?;
        // Older builds' folders (named by their build id) are dead weight now. Anything else in
        // bin/ — the downloaded AI tools in bin/ai — stays.
        if let Some(parent) = dir.parent() {
            for entry in fs::read_dir(parent).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_build = name.len() == 12 && name.chars().all(|c| c.is_ascii_hexdigit());
                if entry.path() != dir && is_build {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    // A tool that wasn't embedded is looked up on PATH instead.
    for (packed, p, name) in [
        (PACKED_FFMPEG, &mut paths.ffmpeg, "ffmpeg"),
        (PACKED_FFPROBE, &mut paths.ffprobe, "ffprobe"),
        (PACKED_YTDLP, &mut paths.ytdlp, "yt-dlp"),
    ] {
        if packed.is_empty() {
            *p = PathBuf::from(exe_name(name));
        }
    }
    Ok(paths)
}

/// Unpacks `ublock-origin.zip` so that `dst/<name>/manifest.json` exists for
/// every extension.
fn unzip_ublock(dst: &Path) -> io::Result<()> {
    use std::io::Cursor;
    let mut archive = zip::ZipArchive::new(Cursor::new(UBLOCK_ZIP)).map_err(io::Error::other)?;
    fs::create_dir_all(dst)?;
    archive.extract(dst).map_err(io::Error::other)?;
    Ok(())
}

/// Starts unpacking in the background. Call once at startup.
pub fn init() {
    let s = slot();
    std::thread::spawn(move || {
        let paths = unpack().unwrap_or_else(|e| {
            eprintln!("could not unpack the helper tools: {e}");
            // Last resort: whatever is on PATH.
            Paths {
                dir: PathBuf::new(),
                ffmpeg: PathBuf::from(exe_name("ffmpeg")),
                ffprobe: PathBuf::from(exe_name("ffprobe")),
                ytdlp: PathBuf::from(exe_name("yt-dlp")),
            }
        });
        *s.value.lock().unwrap() = Some(paths);
        s.ready.notify_all();
    });
}

/// Waits for the unpack to finish and returns the tool locations.
pub fn paths() -> Paths {
    let s = slot();
    let mut guard = s.value.lock().unwrap();
    while guard.is_none() {
        guard = s.ready.wait(guard).unwrap();
    }
    guard.clone().unwrap()
}

pub fn ffmpeg() -> PathBuf {
    paths().ffmpeg
}

pub fn ffprobe() -> PathBuf {
    paths().ffprobe
}

pub fn ytdlp() -> PathBuf {
    paths().ytdlp
}

/// `"ffmpeg"` / `"ffprobe"` / `"yt-dlp"` -> path.
pub fn path(name: &str) -> PathBuf {
    match name {
        "ffprobe" => ffprobe(),
        "yt-dlp" | "ytdlp" => ytdlp(),
        _ => ffmpeg(),
    }
}

/// Where the unpacked browser extensions live (`<dir>/<extension>/manifest.json`).
pub fn extensions_dir() -> PathBuf {
    paths().dir.join("extensions")
}
