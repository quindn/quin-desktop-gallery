//! Turns "some link the user pasted" into something playable.
//!
//! * a media URL (mp4, m3u8, mpd, flv, rtsp://, ...) is probed with FFprobe
//!   and played as-is;
//! * a web page URL is handed to yt-dlp, which knows how to dig the media out
//!   of YouTube, TikTok, Facebook, X, Bilibili, ... (it also reports the
//!   available qualities);
//! * anything else that FFmpeg can open works through the FFmpeg pipe.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;

use super::server::{self, Input, Session};
use super::{http, Headers, BROWSER_UA};

#[derive(Debug, Clone, Deserialize)]
pub struct PrepareRequest {
    pub url: String,
    /// Headers the media needs (Referer, Cookie, ...). Present for links found
    /// by the browser's sniffer: those are already direct media, no page scraping.
    pub headers: Option<Headers>,
    /// Preferred maximum height (720, 1080, ...) for pages with several qualities.
    pub quality: Option<i64>,
    /// Skip the "can the browser play it directly?" shortcut.
    pub force_pipe: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QualityOption {
    pub height: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayInfo {
    pub id: String,
    pub title: String,
    pub duration: Option<f64>,
    /// "direct": `src` is a plain file the browser seeks natively.
    /// "pipe": `src` is FFmpeg's stream — append `?t=<sec>` to (re)start at a time.
    pub mode: String,
    pub src: String,
    pub thumbnail: Option<String>,
    pub page_url: String,
    pub is_live: bool,
    pub quality: Option<i64>,
    pub qualities: Vec<QualityOption>,
    pub source: String, // "media" | "page"
    pub has_video: bool,
    pub has_audio: bool,
    pub extractor: Option<String>,
}

const MEDIA_EXTS: &[&str] = &[
    "mp4", "m4v", "webm", "mov", "mkv", "avi", "flv", "f4v", "wmv", "asf", "ogv", "3gp", "ts", "m2ts", "mts", "mpg", "mpeg", "vob",
    "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "wma", "m3u8", "m3u", "mpd", "ism", "f4m",
];

fn ext_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let name = parsed.path_segments()?.last()?.to_string();
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(ext)
}

fn is_ffmpeg_only_scheme(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["rtsp://", "rtsps://", "rtmp://", "rtmps://", "rtmpe://", "mms://", "mmsh://", "udp://", "rtp://", "srt://", "tcp://", "file://"]
        .iter()
        .any(|p| lower.starts_with(p))
}

/// `example.com/x` -> `https://example.com/x`; leaves real schemes alone.
pub fn normalize(input: &str) -> Result<String, String> {
    let t = input.trim().trim_matches(|c| c == '"' || c == '\'');
    if t.is_empty() {
        return Err("enter a link".into());
    }
    if t.contains("://") {
        return Ok(t.to_string());
    }
    if t.contains(' ') || !t.contains('.') {
        return Err("that does not look like a link".into());
    }
    Ok(format!("https://{t}"))
}

#[derive(Debug, PartialEq)]
enum Kind {
    Media,
    Page,
}

/// Decides between "media file/manifest" and "web page" with as little
/// network as possible.
async fn classify(url: &str, headers: &Headers) -> Kind {
    if is_ffmpeg_only_scheme(url) {
        return Kind::Media;
    }
    let by_ext = ext_of(url).map(|e| MEDIA_EXTS.contains(&e.as_str())).unwrap_or(false);

    let mut rb = http().head(url).timeout(Duration::from_secs(12));
    for (k, v) in headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    let ct = match rb.send().await {
        Ok(r) if r.status().is_success() => r.headers().get("content-type").and_then(|v| v.to_str().ok()).map(str::to_ascii_lowercase),
        _ => None,
    };
    match ct {
        Some(ct) if ct.starts_with("video/") || ct.starts_with("audio/") => Kind::Media,
        Some(ct) if ct.contains("mpegurl") || ct.contains("dash+xml") || ct.contains("vnd.ms-sstr") => Kind::Media,
        Some(ct) if ct.starts_with("text/html") || ct.contains("xhtml") => Kind::Page,
        Some(ct) if ct.starts_with("application/octet-stream") || ct.starts_with("binary/") => {
            if by_ext {
                Kind::Media
            } else {
                Kind::Page
            }
        }
        // No usable HEAD answer: trust the file extension, else treat it as a page.
        _ => {
            if by_ext {
                Kind::Media
            } else {
                Kind::Page
            }
        }
    }
}

#[derive(Debug, Default, Clone)]
pub(crate) struct Probe {
    pub(crate) duration: Option<f64>,
    pub(crate) vcodec: Option<String>,
    pub(crate) acodec: Option<String>,
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
    container: String,
    title: Option<String>,
    is_live: bool,
}

/// The `-headers` block FFmpeg needs to fetch `url` the way the page did (None for non-HTTP inputs).
pub(crate) fn header_block(url: &str, headers: &Headers) -> Option<String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    let mut block = String::new();
    let mut has_ua = false;
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
        }
        block.push_str(&format!("{k}: {v}\r\n"));
    }
    if !has_ua {
        block.push_str(&format!("User-Agent: {BROWSER_UA}\r\n"));
    }
    Some(block)
}

pub(crate) async fn ffprobe(url: &str, headers: &Headers) -> Result<Probe, String> {
    let mut args: Vec<String> = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-rw_timeout", "20000000"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(block) = header_block(url, headers) {
        args.extend(["-headers".into(), block]);
    }
    args.push(url.to_string());

    let mut cmd = tokio::process::Command::new(crate::tools::ffprobe());
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("could not start ffprobe: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let work = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let _ = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        let status = child.wait().await;
        (out, err, status)
    };
    let (out, err, status) = tokio::time::timeout(Duration::from_secs(35), work)
        .await
        .map_err(|_| "timed out while reading the stream".to_string())?;
    if !matches!(status, Ok(s) if s.success()) {
        let msg = String::from_utf8_lossy(&err);
        return Err(msg.lines().last().unwrap_or("could not read that stream").trim().to_string());
    }
    let v: Value = serde_json::from_slice(&out).map_err(|e| e.to_string())?;
    let mut p = Probe::default();
    p.container = v["format"]["format_name"].as_str().unwrap_or("").to_string();
    p.duration = v["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).filter(|d| *d > 0.0);
    p.title = v["format"]["tags"]["title"].as_str().map(str::to_string);
    for s in v["streams"].as_array().cloned().unwrap_or_default() {
        match s["codec_type"].as_str() {
            Some("video") if p.vcodec.is_none() && s["disposition"]["attached_pic"].as_i64() != Some(1) => {
                p.vcodec = s["codec_name"].as_str().map(str::to_string);
                p.width = s["width"].as_u64().map(|w| w as u32).filter(|w| *w > 0);
                p.height = s["height"].as_u64().map(|h| h as u32).filter(|h| *h > 0);
            }
            Some("audio") if p.acodec.is_none() => p.acodec = s["codec_name"].as_str().map(str::to_string),
            _ => {}
        }
    }
    // HLS/DASH without an end marker reports no usable duration.
    p.is_live = p.duration.is_none();
    Ok(p)
}

/// Can Chromium's <video> take this file as it is (over HTTP, with range seeking)?
fn browser_can_play(p: &Probe, ext: Option<&str>) -> bool {
    let container_ok = p.container.contains("mp4") || p.container.contains("webm") || p.container.contains("matroska") && ext == Some("webm")
        || p.container.contains("ogg") || p.container == "mp3" || p.container == "wav" || p.container == "flac";
    container_ok && video_ok(&p.vcodec) && audio_ok(&p.acodec)
}

fn video_ok(c: &Option<String>) -> bool {
    matches!(c.as_deref(), None | Some("h264") | Some("vp8") | Some("vp9") | Some("av1"))
}
fn audio_ok(c: &Option<String>) -> bool {
    matches!(c.as_deref(), None | Some("aac") | Some("mp3") | Some("opus") | Some("vorbis") | Some("flac") | Some("pcm_s16le"))
}

fn title_from_url(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| {
            let last = u.path_segments()?.filter(|s| !s.is_empty()).last().map(str::to_string);
            last.or_else(|| u.host_str().map(str::to_string))
        })
        .unwrap_or_else(|| url.to_string())
}

async fn play_media(url: &str, headers: Headers, force_pipe: bool, title: Option<String>) -> Result<PlayInfo, String> {
    let probe = ffprobe(url, &headers).await?;
    let port = server::ensure_started().await?;
    let ext = ext_of(url);
    let direct = !force_pipe
        && (url.starts_with("http://") || url.starts_with("https://"))
        && !probe.is_live
        && browser_can_play(&probe, ext.as_deref());
    let (has_video, has_audio) = (probe.vcodec.is_some(), probe.acodec.is_some());
    let input = Input { url: url.to_string(), headers };
    let (mode, id, src) = if direct {
        let id = server::register(Session::Proxy(input));
        ("direct", id.clone(), server::proxy_url(port, &id))
    } else {
        let id = server::register(Session::Pipe {
            inputs: vec![input],
            copy_video: matches!(probe.vcodec.as_deref(), Some("h264")),
            copy_audio: matches!(probe.acodec.as_deref(), Some("aac") | Some("mp3")),
            audio_is_aac: matches!(probe.acodec.as_deref(), Some("aac")),
            has_video,
            has_audio,
        });
        ("pipe", id.clone(), server::pipe_url(port, &id))
    };
    Ok(PlayInfo {
        id,
        title: title.or(probe.title).unwrap_or_else(|| title_from_url(url)),
        duration: probe.duration,
        mode: mode.into(),
        src,
        thumbnail: None,
        page_url: url.to_string(),
        is_live: probe.is_live,
        quality: None,
        qualities: vec![],
        source: "media".into(),
        has_video,
        has_audio,
        extractor: None,
    })
}

// ---------------------------------------------------------------- yt-dlp ---

/// Runs yt-dlp `-J` and returns the JSON. Cookies from a real browser session
/// are not available here; the error text says what the site wants.
async fn ytdlp_json(url: &str, extra: &[String]) -> Result<Value, String> {
    let mut args: Vec<String> = ["-J", "--no-playlist", "--no-warnings", "--socket-timeout", "20", "--no-cache-dir"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend(extra.iter().cloned());
    args.push(url.to_string());

    let mut cmd = tokio::process::Command::new(crate::tools::ytdlp());
    cmd.args(crate::tools::ytdlp_cache_args()).args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    if let Some(dir) = crate::tools::paths().dir.to_str() {
        cmd.env("PATH", format!("{dir};{}", std::env::var("PATH").unwrap_or_default()));
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start yt-dlp: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let work = async {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let _ = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        let status = child.wait().await;
        (out, err, status)
    };
    let (out, err, status) = tokio::time::timeout(Duration::from_secs(75), work)
        .await
        .map_err(|_| "the site took too long to answer".to_string())?;
    let err_text = String::from_utf8_lossy(&err).to_string();
    if !matches!(status, Ok(s) if s.success()) || out.is_empty() {
        let line = err_text.lines().rev().find(|l| l.contains("ERROR")).unwrap_or_else(|| err_text.lines().last().unwrap_or("yt-dlp failed"));
        return Err(line.trim().trim_start_matches("ERROR:").trim().to_string());
    }
    serde_json::from_slice::<Value>(&out).map_err(|e| format!("unexpected yt-dlp output: {e}"))
}

#[derive(Debug, Clone)]
struct Fmt {
    url: String,
    protocol: String,
    height: i64,
    vcodec: String,
    acodec: String,
    ext: String,
    tbr: f64,
    headers: Headers,
}

fn parse_formats(v: &Value) -> Vec<Fmt> {
    let mut out = vec![];
    let list = v["formats"].as_array().cloned().unwrap_or_default();
    let list = if list.is_empty() && v["url"].is_string() { vec![v.clone()] } else { list };
    for f in list {
        let Some(url) = f["url"].as_str() else { continue };
        let protocol = f["protocol"].as_str().unwrap_or("https").to_string();
        // Storyboards / images are not playable.
        if f["format_note"].as_str() == Some("storyboard") || protocol.contains("mhtml") {
            continue;
        }
        let headers: Headers = f["http_headers"]
            .as_object()
            .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
            .unwrap_or_default();
        out.push(Fmt {
            url: url.to_string(),
            protocol,
            height: f["height"].as_i64().unwrap_or(0),
            vcodec: f["vcodec"].as_str().unwrap_or("none").to_string(),
            acodec: f["acodec"].as_str().unwrap_or("none").to_string(),
            ext: f["ext"].as_str().unwrap_or("").to_string(),
            tbr: f["tbr"].as_f64().unwrap_or(0.0),
            headers,
        });
    }
    out
}

fn has_v(f: &Fmt) -> bool {
    f.vcodec != "none" && !f.vcodec.is_empty()
}
fn has_a(f: &Fmt) -> bool {
    f.acodec != "none" && !f.acodec.is_empty()
}

/// Rank: H.264 first (copies into fMP4 for free), then bitrate.
fn video_rank(f: &Fmt) -> (i32, i64, i64) {
    let codec = if f.vcodec.starts_with("avc") || f.vcodec == "h264" { 2 } else if f.vcodec.starts_with("vp") || f.vcodec.starts_with("av01") { 1 } else { 0 };
    (codec, f.height, f.tbr as i64)
}
fn audio_rank(f: &Fmt) -> (i32, i64) {
    let codec = if f.acodec.starts_with("mp4a") || f.acodec == "aac" { 2 } else if f.acodec == "opus" { 1 } else { 0 };
    (codec, f.tbr as i64)
}

/// The formats to play for a height cap: one combined format, or a video + audio pair.
fn choose(fmts: &[Fmt], cap: Option<i64>) -> Option<Vec<Fmt>> {
    let cap = cap.unwrap_or(1080);
    let fits = |f: &Fmt| f.height == 0 || f.height <= cap;

    let mut combined: Vec<&Fmt> = fmts.iter().filter(|f| has_v(f) && has_a(f) && fits(f)).collect();
    combined.sort_by_key(|f| (f.height, video_rank(f).0, f.tbr as i64));
    let mut videos: Vec<&Fmt> = fmts.iter().filter(|f| has_v(f) && !has_a(f) && fits(f)).collect();
    videos.sort_by_key(|f| video_rank(f).1 * 10 + video_rank(f).0 as i64);
    let audios: Vec<&Fmt> = {
        let mut a: Vec<&Fmt> = fmts.iter().filter(|f| has_a(f) && !has_v(f)).collect();
        a.sort_by_key(|f| audio_rank(f));
        a
    };

    let best_combined = combined.last().copied();
    let best_video = videos.last().copied();
    // A separate video track beats a combined one only when it is clearly sharper.
    match (best_combined, best_video, audios.last().copied()) {
        (Some(c), Some(v), Some(a)) if v.height > c.height => Some(vec![v.clone(), a.clone()]),
        (Some(c), _, _) => Some(vec![c.clone()]),
        (None, Some(v), Some(a)) => Some(vec![v.clone(), a.clone()]),
        (None, Some(v), None) => Some(vec![v.clone()]),
        (None, None, Some(a)) => Some(vec![a.clone()]),
        _ => None,
    }
}

fn qualities(fmts: &[Fmt]) -> Vec<QualityOption> {
    let mut hs: Vec<i64> = fmts.iter().filter(|f| has_v(f) && f.height > 0).map(|f| f.height).collect();
    hs.sort_unstable();
    hs.dedup();
    hs.reverse();
    hs.into_iter().map(|h| QualityOption { height: h, label: format!("{h}p") }).collect()
}

async fn play_page(url: &str, req: &PrepareRequest) -> Result<PlayInfo, String> {
    let v = ytdlp_json(url, &[]).await?;
    // Pages with several videos come back as a playlist; take the first entry.
    let v = if let Some(first) = v["entries"].as_array().and_then(|e| e.iter().find(|x| x.is_object())) { first.clone() } else { v };
    let fmts = parse_formats(&v);
    if fmts.is_empty() {
        return Err("no playable video found on that page".into());
    }
    let picked = choose(&fmts, req.quality).ok_or("no playable video found on that page")?;
    let port = server::ensure_started().await?;

    let inputs: Vec<Input> = picked.iter().map(|f| Input { url: f.url.clone(), headers: f.headers.clone() }).collect();
    let vf = picked.iter().find(|f| has_v(f));
    let af = picked.iter().find(|f| has_a(f));
    let copy_video = vf.map(|f| f.vcodec.starts_with("avc") || f.vcodec == "h264").unwrap_or(false);
    let copy_audio = af.map(|f| f.acodec.starts_with("mp4a") || f.acodec == "aac" || f.acodec == "mp3").unwrap_or(false);
    // A single progressive mp4/webm the browser can read directly needs no ffmpeg at all.
    let single_direct = inputs.len() == 1
        && !req.force_pipe.unwrap_or(false)
        && picked[0].protocol.starts_with("http")
        && !picked[0].protocol.contains("m3u8")
        && !picked[0].protocol.contains("dash")
        && matches!(picked[0].ext.as_str(), "mp4" | "webm" | "m4v")
        && has_v(&picked[0]) == vf.is_some()
        && (copy_video || vf.map(|f| f.vcodec.starts_with("vp")).unwrap_or(true))
        && (copy_audio || af.map(|f| f.acodec == "opus" || f.acodec == "vorbis").unwrap_or(true));

    let (mode, id, src) = if single_direct {
        let id = server::register(Session::Proxy(inputs[0].clone()));
        ("direct", id.clone(), server::proxy_url(port, &id))
    } else {
        let id = server::register(Session::Pipe {
            inputs,
            copy_video,
            copy_audio,
            audio_is_aac: af.map(|f| f.acodec.starts_with("mp4a") || f.acodec == "aac").unwrap_or(false),
            has_video: vf.is_some(),
            has_audio: af.is_some() || vf.map(|f| has_a(f)).unwrap_or(false),
        });
        ("pipe", id.clone(), server::pipe_url(port, &id))
    };

    Ok(PlayInfo {
        id,
        title: v["title"].as_str().unwrap_or("Untitled").to_string(),
        duration: v["duration"].as_f64().filter(|d| *d > 0.0),
        mode: mode.into(),
        src,
        thumbnail: v["thumbnail"].as_str().map(str::to_string),
        page_url: url.to_string(),
        is_live: v["is_live"].as_bool().unwrap_or(false),
        quality: vf.map(|f| f.height).filter(|h| *h > 0),
        qualities: qualities(&fmts),
        source: "page".into(),
        has_video: vf.is_some(),
        has_audio: af.is_some() || vf.map(|f| has_a(f)).unwrap_or(false),
        extractor: v["extractor_key"].as_str().or(v["extractor"].as_str()).map(str::to_string),
    })
}

pub async fn prepare(req: PrepareRequest) -> Result<PlayInfo, String> {
    let url = normalize(&req.url)?;
    let headers = req.headers.clone().unwrap_or_default();
    let force_pipe = req.force_pipe.unwrap_or(false);

    // Links captured by the browser are direct media by definition.
    let kind = if !headers.is_empty() { Kind::Media } else { classify(&url, &headers).await };
    match kind {
        Kind::Media => match play_media(&url, headers.clone(), force_pipe, None).await {
            Ok(info) => Ok(info),
            // e.g. an extensionless URL that turned out to be an HTML player page.
            Err(media_err) => play_page(&url, &req).await.map_err(|page_err| {
                if headers.is_empty() {
                    format!("{page_err} ({media_err})")
                } else {
                    media_err
                }
            }),
        },
        Kind::Page => play_page(&url, &req).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(h: i64, v: &str, a: &str, ext: &str, tbr: f64) -> Fmt {
        Fmt { url: format!("https://x/{h}{v}{a}"), protocol: "https".into(), height: h, vcodec: v.into(), acodec: a.into(), ext: ext.into(), tbr, headers: vec![] }
    }

    #[test]
    fn normalizes_what_people_paste() {
        assert_eq!(normalize("  youtube.com/watch?v=1 ").unwrap(), "https://youtube.com/watch?v=1");
        assert_eq!(normalize("rtsp://cam/stream").unwrap(), "rtsp://cam/stream");
        assert!(normalize("hello world").is_err());
        assert!(normalize("").is_err());
    }

    #[test]
    fn spots_media_by_extension_and_scheme() {
        assert_eq!(ext_of("https://x.com/a/b/movie.MP4?token=1").as_deref(), Some("mp4"));
        assert!(is_ffmpeg_only_scheme("RTSP://cam"));
        assert!(!is_ffmpeg_only_scheme("https://a"));
    }

    #[test]
    fn picks_a_sharper_split_video_over_a_low_res_combined_one() {
        let f = vec![
            fmt(360, "avc1", "mp4a", "mp4", 500.0),
            fmt(1080, "avc1", "none", "mp4", 3000.0),
            fmt(720, "vp9", "none", "webm", 1500.0),
            fmt(0, "none", "mp4a", "m4a", 128.0),
        ];
        let p = choose(&f, None).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].height, 1080);
        assert!(!has_v(&p[1]));
        // Capped at 720: the VP9 720p wins over the 360p combined one.
        let p = choose(&f, Some(720)).unwrap();
        assert_eq!(p[0].height, 720);
        // Only the combined one fits under 480.
        let p = choose(&f, Some(480)).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].height, 360);
    }

    #[test]
    fn quality_list_is_unique_and_descending() {
        let f = vec![fmt(720, "avc1", "none", "mp4", 1.0), fmt(1080, "avc1", "none", "mp4", 1.0), fmt(720, "vp9", "none", "webm", 1.0)];
        let q: Vec<i64> = qualities(&f).iter().map(|q| q.height).collect();
        assert_eq!(q, vec![1080, 720]);
    }

    #[test]
    fn chromium_playability_rules() {
        let mp4 = Probe { container: "mov,mp4,m4a,3gp,3g2,mj2".into(), vcodec: Some("h264".into()), acodec: Some("aac".into()), ..Default::default() };
        assert!(browser_can_play(&mp4, Some("mp4")));
        let hevc = Probe { vcodec: Some("hevc".into()), ..mp4.clone() };
        assert!(!browser_can_play(&hevc, Some("mp4")));
        let flv = Probe { container: "flv".into(), vcodec: Some("h264".into()), acodec: Some("aac".into()), ..Default::default() };
        assert!(!browser_can_play(&flv, Some("flv")));
    }
}

/// Real-network checks (`cargo test --lib net_ -- --ignored --nocapture`).
#[cfg(test)]
mod net_tests {
    use super::*;

    async fn read_some(url: &str, want: usize) -> Vec<u8> {
        let mut resp = http().get(url).send().await.expect("stream request");
        assert!(resp.status().is_success(), "status {}", resp.status());
        let mut buf = Vec::new();
        while buf.len() < want {
            match resp.chunk().await.expect("chunk") {
                Some(c) => buf.extend_from_slice(&c),
                None => break,
            }
        }
        buf
    }

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    #[tokio::test]
    #[ignore]
    async fn net_direct_mp4_plays_through_the_proxy_with_range_seeking() {
        crate::tools::init();
        let info = prepare(PrepareRequest {
            url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4".into(),
            headers: None,
            quality: None,
            force_pipe: None,
        })
        .await
        .expect("prepare");
        println!("direct: {} | mode {} | dur {:?} | {}", info.title, info.mode, info.duration, info.src);
        assert_eq!(info.source, "media");
        assert!(info.duration.unwrap_or(0.0) > 4.0);
        // Range request through the proxy.
        let resp = http().get(&info.src).header("Range", "bytes=1000-1999").send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 206);
        assert_eq!(resp.bytes().await.unwrap().len(), 1000);
        // Whatever mode was chosen, the pipe path must also work for the same file.
        let piped = prepare(PrepareRequest { url: info.page_url.clone(), headers: None, quality: None, force_pipe: Some(true) })
            .await
            .expect("prepare pipe");
        assert_eq!(piped.mode, "pipe");
        let head = read_some(&format!("{}?t=2", piped.src), 100_000).await;
        assert!(contains(&head, b"ftyp") && contains(&head, b"moof"), "fragmented mp4 expected");
    }

    #[tokio::test]
    #[ignore]
    async fn net_hls_stream_is_remuxed_to_fragmented_mp4_and_can_seek() {
        crate::tools::init();
        let info = prepare(PrepareRequest {
            url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8".into(),
            headers: None,
            quality: None,
            force_pipe: None,
        })
        .await
        .expect("prepare hls");
        println!("hls: mode {} dur {:?} v={} a={}", info.mode, info.duration, info.has_video, info.has_audio);
        assert_eq!(info.mode, "pipe");
        assert!(info.has_video);
        for t in [0, 120] {
            let bytes = read_some(&format!("{}?t={t}", info.src), 400_000).await;
            assert!(contains(&bytes, b"ftyp"), "no mp4 header at t={t}");
            assert!(bytes.len() >= 300_000, "stream stalled at t={t} ({} bytes)", bytes.len());
        }
    }

    #[tokio::test]
    #[ignore]
    async fn net_youtube_page_resolves_through_ytdlp() {
        crate::tools::init();
        let info = prepare(PrepareRequest {
            url: "https://www.youtube.com/watch?v=jNQXAC9IVRw".into(),
            headers: None,
            quality: Some(360),
            force_pipe: None,
        })
        .await
        .expect("prepare youtube");
        println!("youtube: {} | mode {} | q {:?} | {:?}", info.title, info.mode, info.quality, info.qualities.iter().map(|q| q.label.clone()).collect::<Vec<_>>());
        assert_eq!(info.source, "page");
        assert!(info.title.to_lowercase().contains("zoo"));
        assert!(info.duration.unwrap_or(0.0) > 10.0);
        let bytes = read_some(&format!("{}?t=0", info.src), 300_000).await;
        assert!(contains(&bytes, b"ftyp"), "no mp4 data ({} bytes)", bytes.len());
    }
}
