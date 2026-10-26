//! Local streaming server (127.0.0.1, random port) the player pulls media from.
//!
//! `/p/<id>`  proxy of one remote URL with the right headers (Referer, UA,
//!            cookies) and Range support — for files a `<video>` can play as-is.
//! `/f/<token>` a local library file with full Range support — what the viewer plays local videos
//!            from: seeking is a plain byte-range read, much quicker than the webview's
//!            custom-protocol path. Tokens are random and only exist for files the app handed out.
//! `/s/<id>?t=<sec>` FFmpeg pipe: reads the source(s) — HLS, DASH, FLV, RTSP,
//!            MKV, separate video+audio tracks, ... — and streams fragmented
//!            MP4. H.264/AAC are copied (cheap), anything else is transcoded.
//!            `t` restarts the stream at that time, which is how seeking works
//!            beyond what the browser has buffered.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use axum::body::Body;
use axum::extract::{Path, Query};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::StreamExt;
use tokio::sync::OnceCell;
use tokio_util::io::ReaderStream;

use super::{http, Headers, BROWSER_UA};

#[derive(Debug, Clone)]
pub struct Input {
    pub url: String,
    pub headers: Headers,
}

#[derive(Debug, Clone)]
pub enum Session {
    Proxy(Input),
    Pipe {
        inputs: Vec<Input>,
        copy_video: bool,
        copy_audio: bool,
        /// The copied audio is AAC (needs its ADTS framing rewritten for MP4).
        audio_is_aac: bool,
        has_video: bool,
        has_audio: bool,
    },
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

pub fn register(session: Session) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    sessions().lock().unwrap().insert(id.clone(), session);
    id
}

pub fn forget(id: &str) {
    sessions().lock().unwrap().remove(id);
}

fn lookup(id: &str) -> Option<Session> {
    sessions().lock().unwrap().get(id).cloned()
}

static PORT: OnceCell<u16> = OnceCell::const_new();

/// Starts the server on first use; returns its port. It lives on its own
/// runtime thread, so it outlives whichever task happened to start it.
pub async fn ensure_started() -> Result<u16, String> {
    PORT.get_or_try_init(|| async {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<u16, String>>();
        std::thread::Builder::new()
            .name("qg-stream-server".into())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                        return;
                    }
                };
                rt.block_on(async move {
                    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                        Ok(l) => l,
                        Err(e) => {
                            let _ = tx.send(Err(e.to_string()));
                            return;
                        }
                    };
                    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
                    let _ = tx.send(Ok(port));
                    let app = Router::new().route("/p/:id", get(proxy)).route("/s/:id", get(pipe)).route("/f/:id", get(local_file));
                    let _ = axum::serve(listener, app).await;
                });
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    })
    .await
    .copied()
}

/// path -> token, so the same file always gets the same URL (and the webview can reuse what it
/// already buffered); token -> path for serving.
fn files() -> &'static Mutex<(HashMap<std::path::PathBuf, String>, HashMap<String, std::path::PathBuf>)> {
    static F: OnceLock<Mutex<(HashMap<std::path::PathBuf, String>, HashMap<String, std::path::PathBuf>)>> = OnceLock::new();
    F.get_or_init(Default::default)
}

/// A URL the player can stream `path` from (the server is started on first use).
pub async fn local_file_url(path: std::path::PathBuf) -> Result<String, String> {
    let port = ensure_started().await?;
    let token = {
        let mut f = files().lock().unwrap();
        if let Some(t) = f.0.get(&path) {
            t.clone()
        } else {
            let t = uuid::Uuid::new_v4().simple().to_string();
            f.0.insert(path.clone(), t.clone());
            f.1.insert(t.clone(), path);
            t
        }
    };
    Ok(format!("http://127.0.0.1:{port}/f/{token}"))
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` against a file of `len` bytes: the inclusive range, or
/// `None` when it can't be satisfied.
pub(crate) fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            if n == 0 {
                return None;
            }
            (len.saturating_sub(n), len.checked_sub(1)?)
        }
        (s, "") => (s.parse().ok()?, len.checked_sub(1)?),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(len.checked_sub(1)?)),
    };
    (start <= end && start < len).then_some((start, end))
}

async fn local_file(Path(id): Path<String>, req_headers: HeaderMap) -> Response {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let Some(path) = files().lock().unwrap().1.get(&id).cloned() else {
        return status(StatusCode::NOT_FOUND, "unknown file");
    };
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return status(StatusCode::NOT_FOUND, "file is gone"),
    };
    let len = match file.metadata().await {
        Ok(m) => m.len(),
        Err(e) => return status(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();
    let range = req_headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(|h| parse_range(h, len));
    let (code, start, end) = match range {
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
        Some(Some((s, e))) => (StatusCode::PARTIAL_CONTENT, s, e),
        Some(None) => {
            let mut r = status(StatusCode::RANGE_NOT_SATISFIABLE, "bad range");
            r.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{len}")).unwrap());
            return r;
        }
    };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR, "seek failed");
    }
    let count = if len == 0 { 0 } else { end - start + 1 };
    let body = Body::from_stream(ReaderStream::with_capacity(file.take(count), 256 * 1024));
    let mut b = Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, count.to_string())
        .header(header::CACHE_CONTROL, "no-cache");
    if code == StatusCode::PARTIAL_CONTENT {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    match b.body(body) {
        Ok(r) => cors(r),
        Err(e) => status(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

pub fn proxy_url(port: u16, id: &str) -> String {
    format!("http://127.0.0.1:{port}/p/{id}")
}

pub fn pipe_url(port: u16, id: &str) -> String {
    format!("http://127.0.0.1:{port}/s/{id}")
}

fn cors(mut resp: Response) -> Response {
    resp.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    resp.headers_mut().insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("*"));
    resp
}

fn status(code: StatusCode, msg: &str) -> Response {
    cors((code, msg.to_string()).into_response())
}

async fn proxy(Path(id): Path<String>, req_headers: HeaderMap) -> Response {
    let Some(Session::Proxy(input)) = lookup(&id) else {
        return status(StatusCode::NOT_FOUND, "unknown session");
    };
    let mut rb = http().get(&input.url);
    let mut has_ua = false;
    for (k, v) in &input.headers {
        if k.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
        }
        rb = rb.header(k.as_str(), v.as_str());
    }
    if !has_ua {
        rb = rb.header("User-Agent", BROWSER_UA);
    }
    if let Some(range) = req_headers.get(header::RANGE) {
        rb = rb.header(header::RANGE, range.clone());
    }
    let upstream = match rb.send().await {
        Ok(r) => r,
        Err(e) => return status(StatusCode::BAD_GATEWAY, &e.to_string()),
    };
    let mut builder = Response::builder().status(upstream.status().as_u16());
    for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES] {
        if let Some(v) = upstream.headers().get(&name) {
            builder = builder.header(name, v.clone());
        }
    }
    let stream = upstream.bytes_stream().map(|c| c.map_err(std::io::Error::other));
    match builder.body(Body::from_stream(stream)) {
        Ok(r) => cors(r),
        Err(e) => status(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// `-headers` value: `Key: Value\r\n` per header.
fn header_block(h: &Headers) -> String {
    let mut out = String::new();
    let mut has_ua = false;
    for (k, v) in h {
        if k.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
        }
        // Header values must stay on one line.
        let v: String = v.chars().filter(|c| *c != '\r' && *c != '\n').collect();
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    if !has_ua {
        out.push_str(&format!("User-Agent: {BROWSER_UA}\r\n"));
    }
    out
}

pub fn pipe_args(
    inputs: &[Input],
    start_s: f64,
    copy_video: bool,
    copy_audio: bool,
    audio_is_aac: bool,
    has_video: bool,
    has_audio: bool,
) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin"].iter().map(|s| s.to_string()).collect();
    for input in inputs {
        if start_s > 0.5 {
            a.extend(["-ss".into(), format!("{start_s:.2}")]);
        }
        // Header/reconnect options belong to the HTTP protocol only; rtsp://, udp://
        // and friends reject them.
        if input.url.starts_with("http://") || input.url.starts_with("https://") {
            a.extend([
                "-headers".into(),
                header_block(&input.headers),
                "-reconnect".into(),
                "1".into(),
                "-reconnect_streamed".into(),
                "1".into(),
                "-reconnect_delay_max".into(),
                "5".into(),
            ]);
        }
        a.extend(["-i".into(), input.url.clone()]);
    }
    // Two inputs = separate video and audio tracks (DASH-style); one input holds both.
    if inputs.len() >= 2 {
        a.extend(["-map".into(), "0:v:0".into(), "-map".into(), "1:a:0".into()]);
    } else {
        if has_video {
            a.extend(["-map".into(), "0:v:0".into()]);
        }
        if has_audio {
            a.extend(["-map".into(), "0:a:0?".into()]);
        }
    }
    if has_video {
        if copy_video {
            a.extend(["-c:v".into(), "copy".into()]);
        } else {
            a.extend(
                ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "23", "-pix_fmt", "yuv420p", "-g", "48"]
                    .iter()
                    .map(|s| s.to_string()),
            );
        }
    } else {
        a.push("-vn".into());
    }
    if has_audio {
        if copy_audio {
            a.extend(["-c:a".into(), "copy".into()]);
            if audio_is_aac {
                // AAC from HLS/TS is ADTS-framed; MP4 wants raw AAC + extradata.
                a.extend(["-bsf:a".into(), "aac_adtstoasc".into()]);
            }
        } else {
            a.extend(["-c:a", "aac", "-b:a", "160k", "-ac", "2"].iter().map(|s| s.to_string()));
        }
    } else {
        a.push("-an".into());
    }
    a.extend(
        ["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"]
            .iter()
            .map(|s| s.to_string()),
    );
    a
}

async fn pipe(Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(Session::Pipe { inputs, copy_video, copy_audio, audio_is_aac, has_video, has_audio }) = lookup(&id) else {
        return status(StatusCode::NOT_FOUND, "unknown session");
    };
    let start = q.get("t").and_then(|t| t.parse::<f64>().ok()).unwrap_or(0.0).max(0.0);
    let args = pipe_args(&inputs, start, copy_video, copy_audio, audio_is_aac, has_video, has_audio);

    let mut cmd = tokio::process::Command::new(crate::tools::ffmpeg());
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return status(StatusCode::INTERNAL_SERVER_ERROR, &format!("could not start ffmpeg: {e}")),
    };
    let Some(stdout) = child.stdout.take() else {
        return status(StatusCode::INTERNAL_SERVER_ERROR, "no ffmpeg output");
    };
    // Keep the child alive exactly as long as the response body is: dropping
    // the stream (the player navigated away / seeked) kills ffmpeg.
    let stream = ReaderStream::with_capacity(stdout, 64 * 1024).map(move |chunk| {
        let _keep = &child;
        chunk
    });
    let resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .unwrap();
    cors(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(u: &str) -> Input {
        Input { url: u.into(), headers: vec![("Referer".into(), "https://example.com/".into())] }
    }

    #[test]
    fn byte_ranges_are_read_like_a_browser_sends_them() {
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=100-199", 1000), Some((100, 199)));
        assert_eq!(parse_range("bytes=900-5000", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-2", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }

    #[tokio::test]
    async fn a_local_file_is_served_whole_and_by_ranges() {
        let dir = std::env::temp_dir().join(format!("qg-serve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("clip.mp4");
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&f, &data).unwrap();
        let url = local_file_url(f.clone()).await.unwrap();
        assert_eq!(url, local_file_url(f.clone()).await.unwrap(), "the same file keeps its URL");

        let c = reqwest::Client::new();
        let whole = c.get(&url).send().await.unwrap();
        assert_eq!(whole.status(), 200);
        assert_eq!(whole.headers()["content-type"], "video/mp4");
        assert_eq!(whole.bytes().await.unwrap().to_vec(), data);

        let part = c.get(&url).header("Range", "bytes=50000-50999").send().await.unwrap();
        assert_eq!(part.status(), 206);
        assert_eq!(part.headers()["content-range"], "bytes 50000-50999/100000");
        assert_eq!(part.bytes().await.unwrap().to_vec(), data[50000..51000].to_vec());

        let tail = c.get(&url).header("Range", "bytes=-10").send().await.unwrap();
        assert_eq!(tail.bytes().await.unwrap().to_vec(), data[99990..].to_vec());

        let bad = c.get(&url).header("Range", "bytes=200000-").send().await.unwrap();
        assert_eq!(bad.status(), 416);
        let unknown = c.get(url.replace("/f/", "/f/x")).send().await.unwrap();
        assert_eq!(unknown.status(), 404);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pipe_copies_h264_aac_and_seeks_with_ss_before_each_input() {
        let a = pipe_args(&[input("https://x/y.m3u8")], 42.0, true, true, true, true, true);
        let joined = a.join(" ");
        assert!(joined.contains("-c:v copy") && joined.contains("-c:a copy"));
        assert!(joined.contains("-bsf:a aac_adtstoasc"), "ADTS AAC must be rewritten for MP4");
        assert!(joined.contains("-ss 42.00"));
        assert!(joined.contains("frag_keyframe+empty_moov"));
        assert!(a.iter().any(|s| s.contains("Referer: https://example.com/")));
        assert!(a.iter().any(|s| s.contains("User-Agent: Mozilla")), "a browser UA is always sent");
    }

    #[test]
    fn pipe_transcodes_what_the_browser_cannot_play_and_joins_split_tracks() {
        let a = pipe_args(&[input("https://x/v.mp4"), input("https://x/a.m4a")], 0.0, false, false, false, true, true);
        let joined = a.join(" ");
        assert!(joined.contains("libx264") && joined.contains("-c:a aac"));
        assert!(joined.contains("-map 0:v:0 -map 1:a:0"));
        assert!(!joined.contains("-ss "), "no seek at t=0");
    }

    #[test]
    fn audio_only_source_drops_video() {
        let a = pipe_args(&[input("https://x/a.mp3")], 0.0, true, true, false, false, true);
        assert!(a.contains(&"-vn".to_string()));
    }
}
