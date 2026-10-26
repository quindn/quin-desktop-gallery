//! Download manager: one yt-dlp process per task, live progress, cancel.
//! yt-dlp handles the awkward cases (segmented HLS/DASH, separate audio +
//! video tracks, site-specific extraction) and merges with the bundled
//! FFmpeg; direct file links go through the same path.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::{kill_tree, Headers, BROWSER_UA};

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadRequest {
    pub url: String,
    pub headers: Option<Headers>,
    pub title: Option<String>,
    /// Height cap (720, 1080, ...). `None` = best available.
    pub quality: Option<i64>,
    pub audio_only: Option<bool>,
    pub dir: String,
    /// Length the source is known to have (from a probe): a much shorter file fails the integrity check.
    #[serde(default)]
    pub expected_duration: Option<f64>,
    /// Name for the saved file (without extension), instead of the page's title.
    #[serde(default)]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub title: String,
    /// "queued" | "running" | "done" | "error" | "cancelled"
    pub status: String,
    pub percent: f64,
    pub speed: Option<f64>, // bytes per second
    pub eta: Option<i64>,   // seconds
    pub downloaded: Option<i64>,
    pub total: Option<i64>,
    pub file: Option<String>,
    pub dir: String,
    pub error: Option<String>,
    pub started: i64,
    /// Integrity check of the finished file: `Some(true)` = probed and decoded cleanly.
    pub verified: Option<bool>,
    /// Why the check failed (the file is kept, but flagged).
    pub warning: Option<String>,
}

struct Entry {
    task: DownloadTask,
    cancel: Arc<AtomicBool>,
}

fn tasks() -> &'static Mutex<Vec<Entry>> {
    static T: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

pub fn list() -> Vec<DownloadTask> {
    tasks().lock().unwrap().iter().map(|e| e.task.clone()).collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn update(app: &AppHandle, id: &str, f: impl FnOnce(&mut DownloadTask)) {
    let snapshot = {
        let mut all = tasks().lock().unwrap();
        let Some(e) = all.iter_mut().find(|e| e.task.id == id) else { return };
        f(&mut e.task);
        e.task.clone()
    };
    let _ = app.emit("dl://update", snapshot.clone());
    crate::browser::media::task_progress(app, &snapshot);
}

pub fn cancel(id: &str) {
    if let Some(e) = tasks().lock().unwrap().iter().find(|e| e.task.id == id) {
        e.cancel.store(true, Ordering::Relaxed);
    }
}

pub fn remove(app: &AppHandle, id: &str) {
    cancel(id);
    tasks().lock().unwrap().retain(|e| e.task.id != id);
    let _ = app.emit("dl://removed", id.to_string());
}

pub fn clear_finished(app: &AppHandle) {
    let ids: Vec<String> = tasks()
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e.task.status.as_str(), "done" | "error" | "cancelled"))
        .map(|e| e.task.id.clone())
        .collect();
    for id in ids {
        remove(app, &id);
    }
}

/// `dir/<name>.%(ext)s`, or the page's own title plus id when no name was given.
fn output_template(req: &DownloadRequest) -> String {
    let dir = req.dir.trim_end_matches(['/', '\\']).replace('\\', "/");
    match req.filename.as_deref().map(crate::browser::media::safe_filename).filter(|n| !n.is_empty()) {
        // a literal name: "%" must not be read as a template field
        Some(name) => format!("{dir}/{}.%(ext)s", name.replace('%', "%%")),
        None => format!("{dir}/%(title).120B [%(id).40B].%(ext)s"),
    }
}

/// yt-dlp's arguments for a request.
pub fn build_args(req: &DownloadRequest, ffmpeg_dir: &Path, path_file: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "--cache-dir".into(),
        crate::paths::cache_dir().join("yt-dlp").to_string_lossy().to_string(),
        "--no-playlist".into(),
        "--newline".into(),
        "--no-colors".into(),
        "--windows-filenames".into(),
        "--no-mtime".into(),
        "--concurrent-fragments".into(),
        "4".into(),
        "--retries".into(),
        "6".into(),
        "--fragment-retries".into(),
        "6".into(),
        "--socket-timeout".into(),
        "25".into(),
        "--ffmpeg-location".into(),
        ffmpeg_dir.to_string_lossy().to_string(),
        "-o".into(),
        output_template(req),
        "--progress-template".into(),
        "download:QGP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s".into(),
        "--print-to-file".into(),
        "after_move:filepath".into(),
        path_file.to_string_lossy().to_string(),
    ];
    if req.audio_only.unwrap_or(false) {
        a.extend(["-x".into(), "--audio-format".into(), "mp3".into(), "--audio-quality".into(), "0".into()]);
    } else {
        // H.264/AAC sort first so the merge stays a cheap remux into MP4.
        let cap = req.quality.map(|h| format!("res:{h},")).unwrap_or_default();
        a.extend(["-S".into(), format!("{cap}vcodec:h264,acodec:aac"), "--merge-output-format".into(), "mp4".into()]);
    }
    let mut has_ua = false;
    for (k, v) in req.headers.clone().unwrap_or_default() {
        if k.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
            a.extend(["--user-agent".into(), v]);
        } else if k.eq_ignore_ascii_case("cookie") {
            a.extend(["--add-header".into(), format!("Cookie:{v}")]);
        } else if !k.starts_with(':') && !k.eq_ignore_ascii_case("range") && !k.eq_ignore_ascii_case("accept-encoding") {
            a.extend(["--add-header".into(), format!("{k}:{v}")]);
        }
    }
    if !has_ua {
        a.extend(["--user-agent".into(), BROWSER_UA.into()]);
    }
    a.push(req.url.clone());
    a
}

fn run_tool(exe: &Path, args: &[&str]) -> Result<(bool, String, String), String> {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::editor::runner::hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("could not run {}: {e}", exe.display()))?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))
}

fn fmt_secs(s: f64) -> String {
    let s = s.max(0.0).round() as u64;
    format!("{}:{:02}:{:02}", s / 3600, s % 3600 / 60, s % 60)
}

/// Is this a whole media file? It must open, have streams and a length, decode cleanly
/// to its very end (a cut-off download usually only breaks there) and — when the length
/// of the source is known — not be noticeably shorter. Returns the duration in seconds.
pub fn verify_file(path: &Path, expected: Option<f64>) -> Result<f64, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("the file cannot be read: {e}"))?;
    if meta.len() < 1024 {
        return Err("the file is empty".into());
    }
    let p = path.to_string_lossy().to_string();
    let (ok, out, err) = run_tool(&crate::tools::ffprobe(), &["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &p])?;
    if !ok {
        let why = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("not a valid media file");
        return Err(format!("it does not open as a media file ({})", why.trim()));
    }
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    if v["streams"].as_array().map(|s| s.is_empty()).unwrap_or(true) {
        return Err("it contains no audio or video".into());
    }
    let dur = v["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
    if dur <= 0.0 {
        return Err("it has no readable length".into());
    }
    // decode the last seconds (all of it for short clips)
    let decode: Vec<&str> = if dur > 12.0 {
        vec!["-v", "error", "-nostdin", "-sseof", "-6", "-i", &p, "-f", "null", "-"]
    } else {
        vec!["-v", "error", "-nostdin", "-i", &p, "-f", "null", "-"]
    };
    let (ok, _, err) = run_tool(&crate::tools::ffmpeg(), &decode)?;
    let first = err.lines().find(|l| !l.trim().is_empty());
    if !ok || first.is_some() {
        return Err(format!("decoding fails near the end ({})", first.unwrap_or("error").trim()));
    }
    if let Some(e) = expected.filter(|e| *e > 5.0) {
        if dur < e * 0.95 {
            return Err(format!("it is shorter than the source ({} of {})", fmt_secs(dur), fmt_secs(e)));
        }
    }
    Ok(dur)
}

/// Parses one `QGP|...` progress line.
fn parse_progress(line: &str) -> Option<(String, f64, Option<f64>, Option<i64>, Option<i64>, Option<i64>)> {
    let rest = line.trim().strip_prefix("QGP|")?;
    let f: Vec<&str> = rest.split('|').collect();
    if f.len() < 6 {
        return None;
    }
    let num = |s: &str| s.trim().parse::<f64>().ok();
    let downloaded = num(f[1]).map(|v| v as i64);
    let total = num(f[2]).or_else(|| num(f[3])).map(|v| v as i64);
    let percent = match (downloaded, total) {
        (Some(d), Some(t)) if t > 0 => (d as f64 / t as f64 * 100.0).clamp(0.0, 100.0),
        _ => 0.0,
    };
    Some((f[0].to_string(), percent, num(f[4]), num(f[5]).map(|v| v as i64), downloaded, total))
}

pub fn start(app: AppHandle, req: DownloadRequest) -> Result<String, String> {
    if req.url.trim().is_empty() {
        return Err("no link to download".into());
    }
    std::fs::create_dir_all(&req.dir).map_err(|e| format!("cannot create the download folder: {e}"))?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let task = DownloadTask {
        id: id.clone(),
        url: req.url.clone(),
        title: req.title.clone().unwrap_or_else(|| req.url.clone()),
        status: "queued".into(),
        percent: 0.0,
        speed: None,
        eta: None,
        downloaded: None,
        total: None,
        file: None,
        dir: req.dir.clone(),
        error: None,
        started: now_ms(),
        verified: None,
        warning: None,
    };
    tasks().lock().unwrap().push(Entry { task: task.clone(), cancel: cancel.clone() });
    let _ = app.emit("dl://update", task);

    let job_id = id.clone();
    std::thread::spawn(move || run(app, job_id, req, cancel));
    Ok(id)
}

fn run(app: AppHandle, id: String, req: DownloadRequest, cancel: Arc<AtomicBool>) {
    let paths = crate::tools::paths();
    let ffmpeg_dir: PathBuf = paths.ffmpeg.parent().map(Path::to_path_buf).unwrap_or_default();
    let path_file = crate::paths::tmp_dir().join(format!("qg-dl-{id}.txt"));
    let args = build_args(&req, &ffmpeg_dir, &path_file);

    let mut cmd = Command::new(&paths.ytdlp);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::editor::runner::hide_window(&mut cmd);
    if let Some(dir) = paths.dir.to_str() {
        cmd.env("PATH", format!("{dir};{}", std::env::var("PATH").unwrap_or_default()));
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            update(&app, &id, |t| {
                t.status = "error".into();
                t.error = Some(format!("could not start yt-dlp: {e}"));
            });
            return;
        }
    };
    let pid = child.id();
    update(&app, &id, |t| t.status = "running".into());

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let err_tail = crate::editor::runner::drain_stderr(stderr);

    // Cancel = kill the whole tree.
    let done = Arc::new(AtomicBool::new(false));
    let watcher = {
        let (cancel, done) = (cancel.clone(), done.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    kill_tree(pid);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        })
    };

    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let mut title_seen = false;
    for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&line).to_string();
        if let Some((status, percent, speed, eta, downloaded, total)) = parse_progress(&line) {
            if last_emit.elapsed().as_millis() < 200 && status != "finished" {
                continue;
            }
            last_emit = std::time::Instant::now();
            update(&app, &id, |t| {
                t.percent = percent;
                t.speed = speed;
                t.eta = eta;
                t.downloaded = downloaded;
                t.total = total;
            });
        } else if !title_seen {
            // "[download] Destination: <path>" tells us the real title early.
            if let Some(dest) = line.strip_prefix("[download] Destination: ") {
                if let Some(name) = Path::new(dest.trim()).file_stem().and_then(|n| n.to_str()) {
                    let name = name.to_string();
                    update(&app, &id, |t| t.title = name);
                    title_seen = true;
                }
            }
        }
    }

    let status = child.wait();
    done.store(true, Ordering::Relaxed);
    let _ = watcher.join();
    let stderr_text = err_tail.join().unwrap_or_default();
    let cancelled = cancel.load(Ordering::Relaxed);
    let file = std::fs::read_to_string(&path_file)
        .ok()
        .and_then(|s| s.lines().last().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty());
    let _ = std::fs::remove_file(&path_file);

    if cancelled {
        update(&app, &id, |t| {
            t.status = "cancelled".into();
            t.speed = None;
            t.eta = None;
        });
        return;
    }
    match status {
        Ok(s) if s.success() && file.is_some() => {
            update(&app, &id, |t| {
                t.status = "done".into();
                t.percent = 100.0;
                t.speed = None;
                t.eta = None;
                if let Some(f) = &file {
                    if let Some(name) = Path::new(f).file_stem().and_then(|n| n.to_str()) {
                        t.title = name.to_string();
                    }
                }
                t.file = file.clone();
            });
            // A finished download is only "done" for real once it opens and plays to the end.
            if let Some(f) = &file {
                let verdict = verify_file(Path::new(f), req.expected_duration);
                update(&app, &id, |t| match verdict {
                    Ok(_) => t.verified = Some(true),
                    Err(why) => {
                        t.verified = Some(false);
                        t.warning = Some(why);
                    }
                });
            }
        }
        _ => {
            let msg = stderr_text
                .lines()
                .rev()
                .find(|l| l.contains("ERROR"))
                .or_else(|| stderr_text.lines().rev().find(|l| !l.trim().is_empty()))
                .unwrap_or("download failed")
                .trim()
                .trim_start_matches("ERROR:")
                .trim()
                .to_string();
            update(&app, &id, |t| {
                t.status = "error".into();
                t.error = Some(msg);
                t.speed = None;
                t.eta = None;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_lines() {
        let (st, pct, speed, eta, done, total) = parse_progress("QGP|downloading|500|1000|NA|2048.5|30").unwrap();
        assert_eq!(st, "downloading");
        assert!((pct - 50.0).abs() < 1e-9);
        assert_eq!(speed, Some(2048.5));
        assert_eq!(eta, Some(30));
        assert_eq!((done, total), (Some(500), Some(1000)));
        // Estimated total when the exact one is unknown; NA speed/eta -> None.
        let (_, pct, speed, eta, _, _) = parse_progress("QGP|downloading|250|NA|1000|NA|NA").unwrap();
        assert!((pct - 25.0).abs() < 1e-9);
        assert_eq!((speed, eta), (None, None));
        assert!(parse_progress("[download] 12%").is_none());
    }

    /// A 6 s clip with a real encoder; None (test skipped) when FFmpeg is not available.
    fn make_clip(dir: &Path, name: &str, secs: u32) -> Option<PathBuf> {
        crate::tools::init();
        let ff = crate::tools::ffmpeg();
        if !ff.exists() && Command::new(&ff).arg("-version").output().is_err() {
            return None;
        }
        let out = dir.join(name);
        let st = Command::new(&ff)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("testsrc=size=320x240:rate=25:duration={secs}"), "-f", "lavfi", "-i", &format!("sine=frequency=440:duration={secs}")])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest"])
            .arg(&out)
            .status()
            .ok()?;
        st.success().then_some(out)
    }

    #[test]
    fn integrity_check_accepts_a_whole_file_and_rejects_broken_ones() {
        let dir = std::env::temp_dir().join(format!("qg-verify-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let Some(good) = make_clip(&dir, "good.mp4", 20) else {
            eprintln!("skipped: no ffmpeg");
            return;
        };
        let dur = verify_file(&good, Some(20.0)).expect("a complete file passes");
        assert!((dur - 20.0).abs() < 0.6, "{dur}");

        // the source was longer than what we got
        let short = verify_file(&good, Some(60.0)).unwrap_err();
        assert!(short.contains("shorter"), "{short}");

        // cut off in the middle: the moov box at the end is gone
        let bytes = std::fs::read(&good).unwrap();
        let cut = dir.join("cut.mp4");
        std::fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
        assert!(verify_file(&cut, None).is_err(), "a truncated mp4 must fail");

        // garbage and empty files
        let junk = dir.join("junk.mp4");
        std::fs::write(&junk, vec![7u8; 5000]).unwrap();
        assert!(verify_file(&junk, None).unwrap_err().contains("does not open"));
        let empty = dir.join("empty.mp4");
        std::fs::write(&empty, b"").unwrap();
        assert!(verify_file(&empty, None).unwrap_err().contains("empty"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_chosen_file_name_replaces_the_title_template() {
        let mut req = DownloadRequest { url: "https://a/v.mp4".into(), headers: None, title: None, quality: None, audio_only: None, dir: "C:\\Videos".into(), expected_duration: None, filename: Some("My clip: 100%".into()) };
        assert_eq!(output_template(&req), "C:/Videos/My clip 100%%.%(ext)s");
        req.filename = Some("...".into());
        assert!(output_template(&req).contains("%(title)"));
    }

    #[test]
    fn args_carry_headers_quality_and_output_template() {
        let req = DownloadRequest {
            url: "https://cdn.example/v.m3u8".into(),
            headers: Some(vec![("Referer".into(), "https://site/".into()), ("Cookie".into(), "a=b".into())]),
            title: None,
            quality: Some(720),
            audio_only: None,
            dir: "C:\\Videos\\Downloads".into(),
            expected_duration: None,
            filename: None,
        };
        let a = build_args(&req, Path::new("C:/tools"), Path::new("C:/tmp/p.txt")).join(" ");
        assert!(a.contains("res:720,vcodec:h264,acodec:aac"));
        assert!(a.contains("--add-header Referer:https://site/"));
        assert!(a.contains("--add-header Cookie:a=b"));
        assert!(a.contains("C:/Videos/Downloads/%(title).120B [%(id).40B].%(ext)s"));
        assert!(a.contains("--user-agent Mozilla"));
        assert!(a.ends_with("https://cdn.example/v.m3u8"));

        let audio = DownloadRequest { audio_only: Some(true), quality: None, headers: None, ..req };
        let a = build_args(&audio, Path::new("C:/tools"), Path::new("p")).join(" ");
        assert!(a.contains("-x --audio-format mp3"));
    }
}
