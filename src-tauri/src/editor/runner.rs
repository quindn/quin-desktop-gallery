//! Runs FFmpeg for edit jobs. Plain `std::process` on a worker thread rather
//! than the Tauri shell API: it needs nothing from the app runtime, so the
//! whole edit engine (including the watermark pipe) can be exercised
//! end-to-end from tests against the real binary, and it gives real
//! backpressure on the raw-frame pipe. Progress comes from FFmpeg's own
//! machine-readable `-progress` stream (`out_time_us=`), not from scraping
//! the human `time=` lines, and a job can be cancelled from any thread.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::EditStep;

/// Set to `true` to abort a running job; every blocking loop here checks it.
pub type Cancel = Arc<AtomicBool>;

pub fn new_cancel() -> Cancel {
    Arc::new(AtomicBool::new(false))
}

/// No console window flashing up for every FFmpeg child on Windows.
pub fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Last few hundred bytes of a stream, snapped to a char boundary.
pub fn tail_of(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.trim().to_string();
    }
    let mut i = s.len() - n;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    s[i..].trim().to_string()
}

/// Drains a child's stderr on its own thread (an unread pipe fills up and
/// stalls the process), keeping only the tail for error messages.
pub fn drain_stderr(mut stderr: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut tail = String::new();
        let mut buf = [0u8; 4096];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if tail.len() > 8000 {
                        let mut cut = tail.len() - 6000;
                        while !tail.is_char_boundary(cut) {
                            cut += 1;
                        }
                        tail.drain(..cut);
                    }
                }
            }
        }
        tail
    })
}

/// Kills `child` as soon as `cancel` flips (or `done` is set, whichever is first).
fn spawn_watcher(child: Arc<Mutex<Child>>, cancel: Cancel, done: Arc<AtomicBool>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while !done.load(Ordering::Relaxed) {
            if cancel.load(Ordering::Relaxed) {
                if let Ok(mut c) = child.lock() {
                    let _ = c.kill();
                }
                break;
            }
            thread::sleep(Duration::from_millis(60));
        }
    })
}

/// The last meaningful line of FFmpeg's stderr — where it says what went wrong.
fn last_error_line(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string()
}

/// Runs one FFmpeg invocation to completion. `on_progress` receives 0..=100
/// mapped into the step's `pct_from..pct_to` slice.
pub fn run_ffmpeg(
    ffmpeg: &Path,
    step: &EditStep,
    on_progress: &mut dyn FnMut(f64),
    cancel: &Cancel,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    if let Some((path, text)) = &step.list_file {
        std::fs::write(path, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    }
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostats".into(), "-progress".into(), "pipe:1".into()];
    args.extend(step.args.iter().cloned());

    let mut cmd = Command::new(ffmpeg);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start ffmpeg ({}): {e}", ffmpeg.display()))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let child = Arc::new(Mutex::new(child));
    let done = Arc::new(AtomicBool::new(false));
    let watcher = spawn_watcher(Arc::clone(&child), Arc::clone(&cancel), Arc::clone(&done));
    let stderr_thread = drain_stderr(stderr);

    let mut last_pct = -1.0_f64;
    for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&line);
        let Some(us) = line.trim().strip_prefix("out_time_us=") else {
            continue;
        };
        let (Ok(us), Some(total_ms)) = (us.trim().parse::<i64>(), step.total_ms) else {
            continue;
        };
        let frac = ((us as f64 / 1000.0) / total_ms.max(1) as f64).clamp(0.0, 1.0);
        let pct = step.pct_from + frac * (step.pct_to - step.pct_from);
        if pct - last_pct >= 0.25 {
            last_pct = pct;
            on_progress(pct);
        }
    }

    let status = child.lock().map_err(|_| "ffmpeg handle poisoned".to_string())?.wait();
    done.store(true, Ordering::Relaxed);
    let _ = watcher.join();
    let stderr_text = stderr_thread.join().unwrap_or_default();

    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    match status {
        Ok(s) if s.success() => {
            on_progress(step.pct_to);
            Ok(())
        }
        Ok(_) => {
            let last = last_error_line(&stderr_text);
            Err(if last.is_empty() { "ffmpeg failed".into() } else { format!("ffmpeg failed: {last}") })
        }
        Err(e) => Err(format!("ffmpeg could not be waited on: {e}")),
    }
}

/// Runs the steps in order; stops at the first failure.
pub fn run_steps(
    ffmpeg: &Path,
    steps: &[EditStep],
    on_progress: &mut dyn FnMut(f64),
    cancel: &Cancel,
) -> Result<(), String> {
    for step in steps {
        run_ffmpeg(ffmpeg, step, on_progress, cancel)?;
    }
    Ok(())
}
