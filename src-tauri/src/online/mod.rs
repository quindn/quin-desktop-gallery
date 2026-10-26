//! "Open Network Stream" — play (and download) video from a link, VLC-style.
//!
//! * `resolve` figures out what a URL is (a direct media file, a manifest, a
//!   live stream, or a web page that *contains* video, which yt-dlp
//!   understands for ~1000 sites) and registers a playback session.
//! * `server` is a tiny local HTTP server the player streams from: either a
//!   header-adding, range-aware proxy (plain mp4/webm), or an FFmpeg pipe that
//!   remuxes/transcodes anything FFmpeg can read (HLS, DASH, FLV, RTSP, MKV,
//!   HEVC, ...) into fragmented MP4 the browser engine can play.
//! * `download` runs yt-dlp jobs with progress, cancel and file hand-off.

pub mod download;
pub mod resolve;
pub mod server;

use std::sync::OnceLock;
use std::time::Duration;

/// What we present ourselves as. Many CDNs refuse the default library UAs.
pub const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(BROWSER_UA)
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("http client")
    })
}

/// Header list used by both players and downloaders.
pub type Headers = Vec<(String, String)>;

/// Kills a process and everything it started (yt-dlp spawns FFmpeg).
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        crate::editor::runner::hide_window(&mut cmd);
        let _ = cmd.output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}
