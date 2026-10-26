//! Video sniffing for the embedded browser — the "any video link, caught"
//! feature. Every response the page's network stack receives (all frames,
//! iframes, XHR/fetch, media elements) passes through WebView2's
//! `WebResourceResponseReceived`; `classify` decides whether it is media worth
//! offering to the user.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Sniffed {
    pub id: String,
    pub url: String,
    /// "hls" | "dash" | "smooth" | "mjpeg" | "video" | "audio"
    pub kind: String,
    pub mime: String,
    pub size: Option<u64>,
    /// Headers a download of this URL needs (Referer, User-Agent, Cookie).
    pub headers: Vec<(String, String)>,
    pub page_url: String,
    pub page_title: String,
    pub time: i64,
    pub hint: Option<String>,
}

const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov", "flv", "f4v", "avi", "wmv", "3gp", "ogv", "mpg", "mpeg"];
const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "wma"];
/// Streaming pieces: the manifest is reported instead of every segment.
const SEGMENT_EXTS: &[&str] = &["ts", "m4s", "cmfv", "cmfa", "fmp4", "vtt", "srt", "webvtt", "key"];

fn path_ext(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let name = parsed.path_segments()?.last()?.to_string();
    Some(name.rsplit_once('.')?.1.to_ascii_lowercase())
}

/// A media extension named anywhere else: `?file=movie.mp4`, `filename="clip.mkv"`.
fn hidden_ext(url: &str, disposition: Option<&str>) -> Option<String> {
    let all: Vec<&str> = VIDEO_EXTS.iter().chain(AUDIO_EXTS).copied().chain(["m3u8", "mpd"]).collect();
    let find = |text: &str| -> Option<String> {
        let lower = text.to_ascii_lowercase();
        all.iter()
            .filter_map(|e| {
                let needle = format!(".{e}");
                let idx = lower.find(&needle)?;
                // ".mp4" must end the token: not ".mp4box" / ".m3u8x".
                let after = lower[idx + needle.len()..].chars().next();
                if after.map(|c| c.is_ascii_alphanumeric()).unwrap_or(false) {
                    None
                } else {
                    Some(e.to_string())
                }
            })
            .next()
    };
    disposition.and_then(find).or_else(|| url::Url::parse(url).ok().and_then(|u| u.query().and_then(find)))
}

/// Streaming pieces (init / media segments / numbered chunks) as opposed to a whole file.
pub fn segment_like(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    let name = u.path_segments().and_then(|s| s.last()).unwrap_or("").to_ascii_lowercase();
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name.as_str(), ""));
    if matches!(ext, "m4s" | "cmfv" | "cmfa" | "ts" | "fmp4") {
        return true;
    }
    if ["seg", "chunk", "frag", "init"].iter().any(|m| stem.contains(m)) {
        return true;
    }
    let digits = stem.chars().rev().take_while(|c| c.is_ascii_digit()).count();
    let before = stem.chars().rev().nth(digits);
    digits >= 3 && matches!(before, Some('_') | Some('-')) && u.path().to_ascii_lowercase().contains("/dash")
}

/// "MP4", "WebM", "MKV"... for a direct file, from its extension or content type.
pub fn container_label(url: &str, mime: &str) -> String {
    fn label(ext: &str) -> &'static str {
        match ext {
            "mp4" | "m4v" => "MP4",
            "webm" => "WebM",
            "mkv" => "MKV",
            "mov" => "MOV",
            "flv" | "f4v" => "FLV",
            "avi" => "AVI",
            "wmv" | "asf" => "WMV",
            "3gp" => "3GP",
            "ogv" | "ogg" | "oga" => "OGG",
            "mpg" | "mpeg" => "MPEG",
            "ts" => "TS",
            "mp3" => "MP3",
            "m4a" => "M4A",
            "aac" => "AAC",
            "wav" => "WAV",
            "flac" => "FLAC",
            "opus" => "Opus",
            "wma" => "WMA",
            _ => "",
        }
    }
    let m = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    // the path's extension first; `dl.php?file=movie.mp4` names it in the query instead
    let mut by_ext = label(&path_ext(url).unwrap_or_default());
    if by_ext.is_empty() {
        by_ext = label(&hidden_ext(url, None).unwrap_or_default());
    }
    if !by_ext.is_empty() {
        return by_ext.into();
    }
    match m.as_str() {
        x if x.contains("mp4") => "MP4",
        x if x.contains("webm") => "WebM",
        x if x.contains("matroska") => "MKV",
        x if x.contains("quicktime") => "MOV",
        "audio/mpeg" => "MP3",
        x if x.contains("ogg") => "OGG",
        x if x.starts_with("audio/") => "Audio",
        x if x.starts_with("video/") => "Video",
        _ => "Media",
    }
    .into()
}

/// Protected streams are listed but flagged: FFmpeg cannot decode them.
fn looks_encrypted(url: &str) -> bool {
    let l = url.to_ascii_lowercase();
    l.contains("/drm/") || l.contains("cenc") || l.contains("widevine") || l.contains("playready") || l.contains("fairplay")
}

/// "720p", "1080", "_480p", "x1920" ... found in the URL, as a quality hint.
fn quality_hint(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    for h in ["2160", "1440", "1080", "720", "480", "360", "240", "144"] {
        for pat in [format!("{h}p"), format!("_{h}"), format!("-{h}"), format!("/{h}/"), format!("x{h}")] {
            if lower.contains(&pat) {
                return Some(format!("{h}p"));
            }
        }
    }
    None
}

/// Some(kind, size) if this response is media worth listing.
pub fn classify(
    url: &str,
    content_type: &str,
    content_length: Option<u64>,
    content_range_total: Option<u64>,
    disposition: Option<&str>,
    status: i32,
) -> Option<(String, Option<u64>, Option<String>)> {
    if !(status == 200 || status == 206) {
        return None;
    }
    let parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str().unwrap_or("");
    // YouTube's chunked player traffic is useless as raw links; the page entry
    // (extracted by yt-dlp) is the way to get those.
    if host.ends_with("googlevideo.com") {
        return None;
    }
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let path_ext = path_ext(url);
    // No extension in the path? Look in the query string / Content-Disposition.
    let ext_owned = match path_ext.as_deref() {
        Some(e) if VIDEO_EXTS.contains(&e) || AUDIO_EXTS.contains(&e) || e == "m3u8" || e == "mpd" || SEGMENT_EXTS.contains(&e) => Some(e.to_string()),
        _ => hidden_ext(url, disposition).or(path_ext),
    };
    let ext = ext_owned.as_deref().unwrap_or("");
    let size = content_range_total.or(content_length);
    let mut hint = quality_hint(url);
    if looks_encrypted(url) {
        hint = Some("DRM".into());
    }

    // Small streaming pieces are noise (the manifest is listed instead) — but
    // some sites serve a whole track as one `.m4s`/`.ts` file, which is worth having.
    let big_enough = size.map(|s| s >= 3 * 1024 * 1024).unwrap_or(false);
    let segment_like = SEGMENT_EXTS.contains(&ext) || ct == "video/mp2t" || ct == "video/iso.segment";
    if ct.starts_with("text/vtt") || (segment_like && !big_enough) {
        return None;
    }
    if ct.starts_with("multipart/x-mixed-replace") {
        // MJPEG camera streams: no timeline, nothing to seek or save as a file.
        return Some(("mjpeg".into(), None, hint));
    }
    let path_l = parsed.path().to_ascii_lowercase();
    if ct.contains("ms-sstr") || ext == "ismc" || path_l.contains(".ism/manifest") || path_l.contains(".isml/manifest") {
        return Some(("smooth".into(), None, hint));
    }
    if ct.contains("mpegurl") || ext == "m3u8" {
        // Skip tiny probes of non-playlists served with a lying type.
        return Some(("hls".into(), None, hint));
    }
    if ct.contains("dash+xml") || ext == "mpd" {
        return Some(("dash".into(), None, hint));
    }
    let is_video = ct.starts_with("video/") || (VIDEO_EXTS.contains(&ext) && (ct.is_empty() || ct.contains("octet-stream") || ct.starts_with("binary/")));
    let is_audio = ct.starts_with("audio/") || (AUDIO_EXTS.contains(&ext) && (ct.is_empty() || ct.contains("octet-stream")));
    if is_video {
        // Range-chunk fragments and thumbnails-in-video-clothing are noise.
        return match size {
            Some(s) if s >= 150 * 1024 => Some(("video".into(), Some(s), hint)),
            None => Some(("video".into(), None, hint)),
            _ => None,
        };
    }
    if is_audio {
        return match size {
            Some(s) if s >= 400 * 1024 => Some(("audio".into(), Some(s), hint)),
            _ => None,
        };
    }
    None
}

/// Key used to merge repeat hits of the same file (signed URLs change per request).
pub fn dedupe_key(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => format!("{}{}", u.host_str().unwrap_or(""), u.path()),
        Err(_) => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_manifests_regardless_of_content_type() {
        assert_eq!(classify("https://cdn.x/a/master.m3u8?token=1", "application/vnd.apple.mpegurl", None, None, None, 200).unwrap().0, "hls");
        assert_eq!(classify("https://cdn.x/a/index.m3u8", "text/plain", None, None, None, 200).unwrap().0, "hls");
        assert_eq!(classify("https://cdn.x/manifest.mpd", "application/dash+xml", None, None, None, 200).unwrap().0, "dash");
    }

    #[test]
    fn lists_real_files_and_ignores_fragments() {
        assert_eq!(classify("https://a/v.mp4", "video/mp4", Some(5_000_000), None, None, 200).unwrap().0, "video");
        // Range request: the total comes from Content-Range.
        let (k, size, _) = classify("https://a/v.mp4", "video/mp4", Some(65_536), Some(90_000_000), None, 206).unwrap();
        assert_eq!((k.as_str(), size), ("video", Some(90_000_000)));
        assert!(classify("https://a/tiny.mp4", "video/mp4", Some(20_000), None, None, 200).is_none());
        assert!(classify("https://a/seg1.ts", "video/mp2t", Some(900_000), None, None, 200).is_none());
        assert!(classify("https://a/chunk.m4s", "video/mp4", Some(900_000), None, None, 200).is_none());
        assert!(classify("https://a/v.mp4", "video/mp4", Some(5_000_000), None, None, 404).is_none());
        assert!(classify("https://r1---sn.googlevideo.com/videoplayback?x=1", "video/mp4", Some(9_000_000), None, None, 200).is_none());
    }

    #[test]
    fn octet_stream_needs_a_media_extension() {
        assert!(classify("https://a/download.mp4", "application/octet-stream", Some(3_000_000), None, None, 200).is_some());
        assert!(classify("https://a/download.bin", "application/octet-stream", Some(3_000_000), None, None, 200).is_none());
        assert!(classify("https://a/song.mp3", "audio/mpeg", Some(3_000_000), None, None, 200).is_some());
        assert!(classify("https://a/click.mp3", "audio/mpeg", Some(9_000), None, None, 200).is_none(), "UI sounds are ignored");
    }

    #[test]
    fn finds_media_without_an_extension_in_the_path() {
        // `?file=movie.mp4` and a Content-Disposition filename both count.
        let (k, _, _) = classify("https://a/dl.php?file=movie.mp4&t=1", "application/octet-stream", Some(8_000_000), None, None, 200).unwrap();
        assert_eq!(k, "video");
        let (k, _, _) = classify("https://a/get/12345", "application/octet-stream", Some(8_000_000), None, Some("attachment; filename=\"clip.mkv\""), 200).unwrap();
        assert_eq!(k, "video");
        assert!(classify("https://a/get/12345", "application/octet-stream", Some(8_000_000), None, Some("attachment; filename=\"notes.pdf\""), 200).is_none());
        assert!(classify("https://a/x?f=app.mp4box", "application/octet-stream", Some(8_000_000), None, None, 200).is_none());
    }

    #[test]
    fn whole_track_m4s_files_are_kept_but_tiny_segments_are_not() {
        assert!(classify("https://a/seg-12.m4s", "video/mp4", Some(400_000), None, None, 200).is_none());
        let (k, _, _) = classify("https://upos.example/track.m4s", "video/mp4", Some(65_536), Some(45_000_000), None, 206).unwrap();
        assert_eq!(k, "video");
        let (k, _, _) = classify("https://upos.example/audio.m4s", "audio/mp4", Some(65_536), Some(6_000_000), None, 206).unwrap();
        assert_eq!(k, "audio");
    }

    #[test]
    fn encrypted_manifests_are_flagged() {
        let (_, _, hint) = classify("https://vod.example/playlist/drm/cenc,v2/playlist.mpd", "application/dash+xml", None, None, None, 200).unwrap();
        assert_eq!(hint.as_deref(), Some("DRM"));
    }

    #[test]
    fn smooth_streaming_and_mjpeg_are_recognised() {
        assert_eq!(classify("https://a/live.isml/Manifest", "text/xml", None, None, None, 200).unwrap().0, "smooth");
        assert_eq!(classify("https://a/x.ism/manifest(format=mpd-time-csf)", "application/dash+xml", None, None, None, 200).unwrap().0, "smooth");
        assert_eq!(classify("https://cam.local/stream", "multipart/x-mixed-replace; boundary=frame", None, None, None, 200).unwrap().0, "mjpeg");
    }

    #[test]
    fn segment_detection_and_container_labels() {
        assert!(segment_like("https://a/x/seg-12.m4s"));
        assert!(segment_like("https://a/x/chunk_000012.mp4"));
        assert!(segment_like("https://a/x/init.mp4"));
        assert!(segment_like("https://a/dash/video-0004.mp4"));
        assert!(!segment_like("https://a/movies/holiday.mp4"));
        assert!(!segment_like("https://a/clip_2024.mp4"));
        assert_eq!(container_label("https://a/v.MKV", ""), "MKV");
        assert_eq!(container_label("https://a/v", "video/webm"), "WebM");
        assert_eq!(container_label("https://a/dl.php?file=m.mp4", "application/octet-stream"), "MP4");
        assert_eq!(container_label("https://a/s", "audio/mpeg"), "MP3");
    }

    #[test]
    fn dedupes_signed_urls_and_reads_quality_hints() {
        assert_eq!(dedupe_key("https://a.b/x/v.mp4?sig=1"), dedupe_key("https://a.b/x/v.mp4?sig=2"));
        assert_eq!(quality_hint("https://a/video_1080p.mp4").as_deref(), Some("1080p"));
        assert_eq!(quality_hint("https://a/v.mp4"), None);
    }
}
