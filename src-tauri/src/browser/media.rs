//! Media discovery for the embedded browser.
//!
//! Two views of a page are merged into one list:
//!
//! * what the **page agent** (`agent.js`, running in every frame) sees — the
//!   `<video>`/`<audio>` elements, their state, thumbnails, which one is the
//!   active player, DRM presence;
//! * what the **network sniffer** (`sniff.rs`) caught — files and manifests,
//!   with the headers a download needs.
//!
//! The merged list feeds the corner popup inside the page, the side panel in
//! the app, and the download / play actions. Everything a page sends is
//! untrusted: it is size-limited and validated here, and actions only ever
//! refer to ids this module issued itself.

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncReadExt;

use super::manifest::{self, ManifestInfo};
use super::sniff::{self, dedupe_key, Sniffed};
use crate::online::Headers;

pub const AGENT_JS: &str = include_str!("agent.js");
const AGENT_POPUP_JS: &str = include_str!("agent_popup.js");
const AGENT_PLAYER_JS: &str = include_str!("agent_player.js");
const AGENT_FAB_JS: &str = include_str!("agent_fab.js");

/// The script injected into every frame: the core plus the popup, the player skin and the floating buttons.
pub fn agent_source() -> String {
    AGENT_JS.replace("/*@@MODULES@@*/", &[AGENT_POPUP_JS, AGENT_PLAYER_JS, AGENT_FAB_JS].join("\n"))
}

/* ------------------------------------------------------------------ settings --- */

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaConfig {
    /// "auto" | "gestures" | "site" | "off"
    pub mode: String,
    /// Per-site override of `mode`, keyed by host (without "www.").
    pub origins: HashMap<String, String>,
    pub seek: u32,
    /// "br" | "bl" | "tr" | "tl"
    pub corner: String,
    pub long_press: bool,
    pub preload: bool,
    pub popup_key: String,
    /// The floating Quin Player / Download buttons under videos.
    pub fab: bool,
    /// The corner badge of the media popup.
    pub badge: bool,
}

impl Default for MediaConfig {
    fn default() -> Self {
        Self { mode: "auto".into(), origins: HashMap::new(), seek: 10, corner: "br".into(), long_press: true, preload: true, popup_key: "Alt+M".into(), fab: true, badge: true }
    }
}

/// "Alt+M", "Ctrl+Shift+V", "F8": modifiers plus one letter / digit, or a function key.
pub fn valid_shortcut(spec: &str) -> bool {
    let parts: Vec<&str> = spec.split('+').collect();
    let Some((last, mods)) = parts.split_last() else { return false };
    let is_fkey = last.len() >= 2 && last.starts_with('F') && last[1..].parse::<u8>().map(|n| (1..=12).contains(&n)).unwrap_or(false);
    let is_char = last.len() == 1 && last.chars().all(|c| c.is_ascii_alphanumeric());
    let mods_ok = mods.iter().all(|m| matches!(*m, "Alt" | "Ctrl" | "Shift")) && mods.iter().enumerate().all(|(i, m)| !mods[..i].contains(m));
    mods_ok && (is_fkey || (is_char && !mods.is_empty()))
}

fn valid_mode(m: &str) -> bool {
    matches!(m, "auto" | "gestures" | "site" | "off")
}

impl MediaConfig {
    pub fn sanitized(mut self) -> Self {
        if !valid_mode(&self.mode) {
            self.mode = "auto".into();
        }
        if !matches!(self.corner.as_str(), "br" | "bl" | "tr" | "tl") {
            self.corner = "br".into();
        }
        self.seek = self.seek.clamp(1, 120);
        let key_ok = valid_shortcut(&self.popup_key);
        if !key_ok {
            self.popup_key = "Alt+M".into();
        }
        self.origins.retain(|h, m| valid_mode(m) && h.len() < 256);
        if self.origins.len() > 500 {
            self.origins.clear();
        }
        self
    }

    pub fn mode_for(&self, host: &str) -> String {
        let host = host.trim_start_matches("www.");
        self.origins.get(host).cloned().unwrap_or_else(|| self.mode.clone())
    }

    /// What the agent in a page on `host` needs to know.
    pub fn for_agent(&self, host: &str) -> Value {
        json!({
            "mode": self.mode_for(host),
            "seek": self.seek,
            "corner": self.corner,
            "longPress": self.long_press,
            "preload": self.preload,
            "popupKey": self.popup_key,
            "fab": self.fab,
            "badge": self.badge,
        })
    }
}

fn config_cell() -> &'static Mutex<MediaConfig> {
    static C: OnceLock<Mutex<MediaConfig>> = OnceLock::new();
    C.get_or_init(Default::default)
}

pub fn config() -> MediaConfig {
    config_cell().lock().unwrap().clone()
}

pub fn set_config(app: &AppHandle, cfg: MediaConfig) {
    *config_cell().lock().unwrap() = cfg.sanitized();
    for t in super::tabs() {
        send_config(app, &t.id);
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

pub fn send_config(app: &AppHandle, tab: &str) {
    let url = super::tabs().into_iter().find(|t| t.id == tab).map(|t| t.url).unwrap_or_default();
    let json = config().for_agent(&host_of(&url));
    eval_top(app, tab, &format!("window.__qg&&window.__qg.config({json})"));
}

fn eval_top(app: &AppHandle, tab: &str, js: &str) {
    if let Some(w) = app.get_webview(tab) {
        let _ = w.eval(js);
    }
}

/* ------------------------------------------------------------- what pages report --- */

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DomMedia {
    pub id: String,
    pub frame_url: String,
    pub tag: String,
    pub current_src: String,
    pub src_object: String,
    pub duration: Option<f64>,
    pub live: bool,
    pub current_time: f64,
    pub paused: bool,
    pub muted: bool,
    pub volume: f64,
    pub rate: f64,
    pub ready_state: u8,
    pub buffered_ahead: f64,
    pub buffer_state: String,
    pub seek_start: Option<f64>,
    pub seek_end: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub rect_w: f64,
    pub rect_h: f64,
    pub visible: f64,
    pub fullscreen: bool,
    pub pip: bool,
    pub encrypted: bool,
    pub key_system: String,
    pub score: f64,
    pub title: String,
    pub rebuffers: u32,
    pub seek_ms: Option<f64>,
    /// Base64 JPEG (validated).
    pub thumb: Option<String>,
}

fn cut(s: &mut String, max: usize) {
    if s.chars().count() > max {
        *s = s.chars().take(max).collect();
    }
}

fn finite(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

fn valid_dom_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix('f') else { return false };
    let Some((frame, n)) = rest.split_once('-') else { return false };
    (1..=10).contains(&frame.len()) && frame.chars().all(|c| c.is_ascii_alphanumeric()) && (1..=8).contains(&n.len()) && n.chars().all(|c| c.is_ascii_digit())
}

/// Base64 of a JPEG, small enough to be a thumbnail. Anything else is dropped.
fn valid_thumb(t: &str) -> bool {
    t.len() >= 200 && t.len() <= 60_000 && t.starts_with("/9j/") && t.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

/// Everything the page said is data: trim it, drop what is malformed.
pub fn sanitize_dom(mut d: DomMedia) -> Option<DomMedia> {
    if !valid_dom_id(&d.id) || !matches!(d.tag.as_str(), "video" | "audio") {
        return None;
    }
    cut(&mut d.frame_url, 2048);
    cut(&mut d.current_src, 4096);
    cut(&mut d.src_object, 40);
    cut(&mut d.title, 200);
    cut(&mut d.key_system, 30);
    cut(&mut d.buffer_state, 12);
    d.duration = d.duration.filter(|x| x.is_finite() && *x >= 0.0);
    d.seek_start = d.seek_start.filter(|x| x.is_finite());
    d.seek_end = d.seek_end.filter(|x| x.is_finite());
    d.seek_ms = d.seek_ms.filter(|x| x.is_finite() && *x >= 0.0);
    d.current_time = finite(d.current_time);
    d.volume = finite(d.volume).clamp(0.0, 1.0);
    d.rate = finite(d.rate);
    d.buffered_ahead = finite(d.buffered_ahead);
    d.rect_w = finite(d.rect_w);
    d.rect_h = finite(d.rect_h);
    d.visible = finite(d.visible).clamp(0.0, 1.0);
    d.score = finite(d.score).clamp(-200.0, 300.0);
    d.width = d.width.min(20_000);
    d.height = d.height.min(20_000);
    if d.thumb.as_deref().map(|t| !valid_thumb(t)).unwrap_or(false) {
        d.thumb = None;
    }
    Some(d)
}

/* ---------------------------------------------------------------------- registry --- */

#[derive(Debug, Clone, Default)]
struct Enriched {
    manifest: Option<ManifestInfo>,
    duration: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    thumb: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopupState {
    pub open: bool,
    pub group: String,
    pub selected: String,
}

#[derive(Default)]
struct TabMedia {
    dom: HashMap<String, (DomMedia, i64)>,
    info: HashMap<String, Enriched>,
    sent_thumbs: HashSet<String>,
    /// Qualities asked from the video engine for page-owned players, by item id.
    formats: HashMap<String, Vec<Variant>>,
    probing: HashSet<String>,
    /// Page-source candidates already checked (by dedupe key).
    scanned: HashSet<String>,
    last_json: String,
    pending: bool,
    popup: PopupState,
    last_act: Option<Instant>,
    /// The top frame's id for the page currently shown; messages from an older page are ignored.
    doc: String,
    /// Player ids wearing the Quin Player skin (reported by the page agent).
    skins: Vec<String>,
}

fn registry() -> &'static Mutex<HashMap<String, TabMedia>> {
    static R: OnceLock<Mutex<HashMap<String, TabMedia>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A new page in the tab: forget everything the old one had.
pub fn reset_tab(app: &AppHandle, tab: &str) {
    registry().lock().unwrap().remove(tab);
    let _ = app.emit("browser://media-items", json!({ "tab": tab, "items": Vec::<Value>::new() }));
}

pub fn forget_tab(tab: &str) {
    registry().lock().unwrap().remove(tab);
}

/* ------------------------------------------------------------------- merged items --- */

/// One quality choice of an item ("1080p").
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Variant {
    pub height: u32,
    pub label: String,
}

fn variants_from_heights(heights: &[u32]) -> Vec<Variant> {
    heights.iter().map(|h| Variant { height: *h, label: format!("{h}p") }).collect()
}

/// A file name made of a title: no path characters, no trailing dots, bounded length.
pub fn safe_filename(title: &str) -> String {
    let cleaned: String = title.chars().map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { ' ' } else { c }).collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(110).collect::<String>().trim().trim_matches('.').trim().to_string();
    trimmed
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    /// The page player this entry belongs to (for the floating buttons on the video).
    pub dom_id: Option<String>,
    /// Quality choices (from the manifest, or asked from the video engine for page-owned players).
    pub variants: Vec<Variant>,
    /// Suggested file name (without extension).
    pub filename: String,
    /// "video" | "audio" | "other"
    pub group: String,
    /// "MP4", "HLS", "DASH", "Blob/MSE", ...
    pub format: String,
    /// What to play / download; `None` for a player that owns its stream (blob/MSE).
    pub url: Option<String>,
    pub headers: Vec<(String, String)>,
    pub title: String,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub size: Option<u64>,
    pub live: bool,
    pub dvr: bool,
    /// Name of the DRM system protecting it ("DRM" when unknown).
    pub protected: Option<String>,
    pub aes: bool,
    /// Base64 JPEG.
    pub thumb: Option<String>,
    pub active: bool,
    pub playing: bool,
    pub buffer: Option<String>,
    /// No URL of its own: play / download go through the page address.
    pub via_page: bool,
    pub can_play: bool,
    pub can_download: bool,
    pub note: Option<String>,
    /// "network" | "page" | "both"
    pub source: String,
    pub page_url: String,
    pub page_title: String,
    pub time: i64,
}

fn file_name(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.path_segments().and_then(|s| s.filter(|x| !x.is_empty()).last().map(str::to_string)))
        .map(|n| percent_decode(&n))
        .unwrap_or_default()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// "index.m3u8", "master.mpd", "video.mp4"... say nothing about the content.
fn generic_name(name: &str) -> bool {
    let stem = name.rsplit_once('.').map(|(a, _)| a).unwrap_or(name).to_ascii_lowercase();
    stem.is_empty() || stem.chars().all(|c| c.is_ascii_digit()) || matches!(stem.as_str(), "index" | "master" | "playlist" | "manifest" | "video" | "stream" | "main" | "media" | "v" | "play" | "output")
}

fn best_dom<'a>(list: impl Iterator<Item = &'a DomMedia>) -> Option<&'a DomMedia> {
    list.max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal))
}

fn is_tiny(d: &DomMedia) -> bool {
    if d.tag == "audio" {
        d.duration.map(|x| x < 1.5).unwrap_or(false)
    } else {
        d.rect_w * d.rect_h < 100.0 * 56.0
    }
}

fn is_manifest(kind: &str) -> bool {
    matches!(kind, "hls" | "dash" | "smooth")
}

/// Adds the referer a download of a page-provided URL needs.
fn page_headers(page_url: &str) -> Vec<(String, String)> {
    if page_url.is_empty() {
        vec![]
    } else {
        vec![("Referer".into(), page_url.to_string())]
    }
}

pub fn build_items(tab: &str) -> Vec<MediaItem> {
    let sniffed = super::sniffed(tab);
    let (page_url, page_title) = super::tabs().into_iter().find(|t| t.id == tab).map(|t| (t.url, t.title)).unwrap_or_default();
    let (dom, info, formats): (Vec<DomMedia>, HashMap<String, Enriched>, HashMap<String, Vec<Variant>>) = {
        let reg = registry().lock().unwrap();
        match reg.get(tab) {
            Some(t) => (t.dom.values().map(|(d, _)| d.clone()).collect(), t.info.clone(), t.formats.clone()),
            None => (vec![], HashMap::new(), HashMap::new()),
        }
    };

    let manifest_of = |s: &Sniffed| info.get(&dedupe_key(&s.url)).and_then(|e| e.manifest.as_ref());
    let has_manifest = sniffed.iter().any(|s| is_manifest(&s.kind));
    let mut variants: HashSet<String> = HashSet::new();
    for s in &sniffed {
        if let Some(m) = manifest_of(s) {
            variants.extend(m.children.iter().map(|c| dedupe_key(c)));
        }
    }
    let active_id = best_dom(dom.iter().filter(|d| d.score > 0.0)).map(|d| d.id.clone());
    // The blob/MSE player (if any) is fed by the newest top-level manifest.
    let main_blob = best_dom(dom.iter().filter(|d| d.tag == "video" && d.current_src.starts_with("blob:") && !is_tiny(d)));
    let paired_manifest = sniffed
        .iter()
        .filter(|s| is_manifest(&s.kind) && !variants.contains(&dedupe_key(&s.url)))
        .max_by_key(|s| s.time)
        .map(|s| dedupe_key(&s.url));

    let mut consumed: HashSet<String> = HashSet::new();
    let mut items: Vec<MediaItem> = Vec::new();

    for s in &sniffed {
        let key = dedupe_key(&s.url);
        let enr = info.get(&key);
        let mf = manifest_of(s);
        let manifest_kind = is_manifest(&s.kind);

        let by_url = dom.iter().filter(|d| !d.current_src.is_empty() && !d.current_src.starts_with("blob:") && dedupe_key(&d.current_src) == key);
        let matched: Option<&DomMedia> = best_dom(by_url).or_else(|| if manifest_kind && paired_manifest.as_deref() == Some(&key) { main_blob } else { None });
        if let Some(m) = matched {
            consumed.insert(m.id.clone());
        }

        let mut group = match s.kind.as_str() {
            "audio" => "audio",
            _ => "video",
        };
        let mut note: Option<String> = None;
        if matched.map(is_tiny).unwrap_or(false) {
            group = "other";
            note = Some("Very small player, probably decoration or an ad".into());
        } else if variants.contains(&key) {
            group = "other";
            note = Some("A rendition of a master playlist (the master is listed instead)".into());
        } else if !manifest_kind && s.kind != "mjpeg" && has_manifest && sniff::segment_like(&s.url) {
            group = "other";
            note = Some("A streaming segment (the playlist is listed instead)".into());
        }

        let fname = file_name(&s.url);
        let title = matched
            .map(|m| m.title.clone())
            .filter(|t| !t.is_empty())
            .or_else(|| if (manifest_kind || generic_name(&fname)) && !page_title.is_empty() && group != "other" { Some(page_title.clone()) } else { None })
            .or_else(|| Some(fname.clone()).filter(|f| !f.is_empty()))
            .unwrap_or_else(|| host_of(&s.url));

        let protected = mf
            .and_then(|m| m.drm.clone())
            .or_else(|| matched.filter(|m| m.encrypted).map(|m| if m.key_system.is_empty() { "DRM".to_string() } else { m.key_system.clone() }))
            .or_else(|| (s.hint.as_deref() == Some("DRM")).then(|| "DRM".to_string()));
        let live = mf.map(|m| m.live).unwrap_or(false) || matched.map(|m| m.live).unwrap_or(false) || s.kind == "mjpeg";
        let format = match s.kind.as_str() {
            "hls" => "HLS".to_string(),
            "dash" => "DASH".to_string(),
            "smooth" => "Smooth".to_string(),
            "mjpeg" => "MJPEG".to_string(),
            _ => sniff::container_label(&s.url, &s.mime),
        };
        let can_play = protected.is_none() && !matches!(s.kind.as_str(), "smooth" | "mjpeg");
        let can_download = protected.is_none() && s.kind != "mjpeg";
        if note.is_none() {
            note = match (&protected, s.kind.as_str()) {
                (Some(_), _) => Some("Protected (DRM): the site's own player is the only thing that can play it".into()),
                (_, "mjpeg") => Some("Camera stream: no timeline, cannot be saved as a file".into()),
                (_, "smooth") => Some("Smooth Streaming: download is attempted through the video engine".into()),
                _ if live => Some("Live: the download records until you cancel it".into()),
                _ => None,
            };
        }
        let height = matched.map(|m| m.height).filter(|h| *h > 0).or(enr.and_then(|e| e.height)).or_else(|| mf.and_then(|m| m.heights.first().copied()));
        let variants = formats.get(&s.id).cloned().unwrap_or_else(|| variants_from_heights(mf.map(|m| m.heights.as_slice()).unwrap_or(&[])));
        items.push(MediaItem {
            id: s.id.clone(),
            dom_id: matched.map(|m| m.id.clone()),
            variants,
            filename: safe_filename(&title),
            group: group.into(),
            format,
            url: Some(s.url.clone()),
            headers: s.headers.clone(),
            title,
            duration: matched.and_then(|m| m.duration).or(mf.and_then(|m| m.duration)).or(enr.and_then(|e| e.duration)),
            width: matched.map(|m| m.width).filter(|w| *w > 0).or(enr.and_then(|e| e.width)),
            height,
            size: s.size,
            live,
            dvr: mf.map(|m| m.dvr).unwrap_or(false),
            protected,
            aes: mf.map(|m| m.aes128).unwrap_or(false),
            thumb: matched.and_then(|m| m.thumb.clone()).or(enr.and_then(|e| e.thumb.clone())),
            active: matched.map(|m| Some(&m.id) == active_id.as_ref()).unwrap_or(false),
            playing: matched.map(|m| !m.paused).unwrap_or(false),
            buffer: matched.filter(|m| !m.buffer_state.is_empty()).map(|m| m.buffer_state.clone()),
            via_page: false,
            can_play,
            can_download,
            note,
            source: if matched.is_some() { "both" } else { "network" }.into(),
            page_url: s.page_url.clone(),
            page_title: s.page_title.clone(),
            time: s.time,
        });
    }

    // Players the sniffer did not see a request for: a src that came from cache,
    // blob/MSE players, live MediaStreams.
    for d in &dom {
        if consumed.contains(&d.id) || (d.current_src.is_empty() && d.src_object.is_empty()) {
            continue;
        }
        let http = d.current_src.starts_with("http://") || d.current_src.starts_with("https://");
        let stream = d.src_object == "MediaStream";
        let blob = d.current_src.starts_with("blob:");
        if !http && !blob && !stream {
            continue; // data: URIs and other exotic schemes
        }
        let tiny = is_tiny(d);
        let group = if tiny {
            "other"
        } else if d.tag == "audio" {
            "audio"
        } else {
            "video"
        };
        let protected = d.encrypted.then(|| if d.key_system.is_empty() { "DRM".to_string() } else { d.key_system.clone() });
        let live = d.live || stream;
        let via_page = !http;
        let can_play = protected.is_none() && !stream;
        let can_download = protected.is_none() && !stream;
        let note = if stream {
            Some("A live camera / call stream: nothing to download".to_string())
        } else if protected.is_some() {
            Some("Protected (DRM): the site's own player is the only thing that can play it".to_string())
        } else if via_page {
            Some("The page owns this stream: it is fetched through the page address (works on sites the video engine knows)".to_string())
        } else if tiny {
            Some("Very small player, probably decoration or an ad".to_string())
        } else {
            None
        };
        let url = http.then(|| d.current_src.clone());
        let title = if !d.title.is_empty() {
            d.title.clone()
        } else if let Some(u) = url.as_ref().map(|u| file_name(u)).filter(|f| d.tag == "audio" && !f.is_empty() && !generic_name(f)) {
            u
        } else if !page_title.is_empty() && !tiny {
            page_title.clone()
        } else if let Some(u) = &url {
            file_name(u)
        } else {
            host_of(&page_url)
        };
        let seen = registry().lock().unwrap().get(tab).and_then(|t| t.dom.get(&d.id).map(|(_, ms)| *ms)).unwrap_or(0);
        let item_id = format!("dom-{}", d.id);
        items.push(MediaItem {
            variants: formats.get(&item_id).cloned().unwrap_or_default(),
            filename: safe_filename(&title),
            dom_id: Some(d.id.clone()),
            id: item_id,
            group: group.into(),
            format: if stream {
                "Live stream".into()
            } else if blob {
                "Blob/MSE".into()
            } else {
                sniff::container_label(&d.current_src, "")
            },
            url: url.clone(),
            headers: page_headers(&page_url),
            title,
            duration: d.duration,
            width: Some(d.width).filter(|w| *w > 0),
            height: Some(d.height).filter(|h| *h > 0),
            size: None,
            live,
            dvr: false,
            protected,
            aes: false,
            thumb: d.thumb.clone(),
            active: Some(&d.id) == active_id.as_ref(),
            playing: !d.paused,
            buffer: Some(d.buffer_state.clone()).filter(|b| !b.is_empty()),
            via_page,
            can_play,
            can_download,
            note,
            source: "page".into(),
            page_url: page_url.clone(),
            page_title: page_title.clone(),
            time: seen,
        });
    }

    let group_rank = |g: &str| match g {
        "video" => 0,
        "audio" => 1,
        _ => 2,
    };
    items.sort_by(|a, b| {
        group_rank(&a.group)
            .cmp(&group_rank(&b.group))
            .then(a.protected.is_some().cmp(&b.protected.is_some()))
            .then(b.active.cmp(&a.active))
            .then(b.time.cmp(&a.time))
    });
    items
}

/* ---------------------------------------------------------------- pushing to UIs --- */

pub fn schedule_push(app: &AppHandle, tab: &str) {
    {
        let mut reg = registry().lock().unwrap();
        let tm = reg.entry(tab.to_string()).or_default();
        if tm.pending {
            return;
        }
        tm.pending = true;
    }
    let (app, tab) = (app.clone(), tab.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        flush(&app, &tab);
    });
}

fn flush(app: &AppHandle, tab: &str) {
    let items = build_items(tab);
    let mut page_items = serde_json::to_value(&items).unwrap_or(Value::Null);
    let mut thumbs = serde_json::Map::new();
    let mut fresh_thumbs = false;
    let changed;
    {
        let mut reg = registry().lock().unwrap();
        let Some(tm) = reg.get_mut(tab) else { return };
        tm.pending = false;
        if let Some(arr) = page_items.as_array_mut() {
            for it in arr.iter_mut() {
                let id = it["id"].as_str().unwrap_or("").to_string();
                if let Some(t) = it["thumb"].as_str().map(str::to_string) {
                    let mark = format!("{id}:{}", t.len());
                    if tm.sent_thumbs.insert(mark) {
                        thumbs.insert(id, Value::String(t));
                        fresh_thumbs = true;
                    }
                    it["thumb"] = Value::Null;
                }
            }
        }
        let now_json = page_items.to_string();
        changed = now_json != tm.last_json;
        tm.last_json = now_json;
    }
    if !changed && !fresh_thumbs {
        return;
    }
    let _ = app.emit("browser://media-items", json!({ "tab": tab, "items": items }));
    if changed {
        eval_top(app, tab, &format!("window.__qg&&window.__qg.items({page_items})"));
    }
    if fresh_thumbs {
        eval_top(app, tab, &format!("window.__qg&&window.__qg.thumbs({})", Value::Object(thumbs)));
    }
}

pub fn popup_command(app: &AppHandle, tab: &str, op: &str) {
    eval_top(app, tab, &format!("window.__qg&&window.__qg.popup({})", Value::String(op.to_string())));
    schedule_push(app, tab);
}

pub fn popup_notice(app: &AppHandle, tab: &str, text: &str) {
    eval_top(app, tab, &format!("window.__qg&&window.__qg.notice({})", Value::String(text.chars().take(120).collect())));
}

/* ------------------------------------------------------------------- page messages --- */

pub fn on_message(app: &AppHandle, tab: &str, raw: &str) {
    if raw.len() > 400_000 {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(raw) else { return };
    let t = v.get("t").and_then(Value::as_str).unwrap_or("");
    let doc: String = v.get("doc").and_then(Value::as_str).unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    {
        let mut reg = registry().lock().unwrap();
        let tm = reg.entry(tab.to_string()).or_default();
        if t == "hello" {
            // a new page: nothing reported before this belongs to it
            tm.doc = doc;
            tm.dom.clear();
            tm.formats.clear();
            tm.probing.clear();
            tm.scanned.clear();
            tm.sent_thumbs.clear();
            tm.last_json.clear();
            tm.popup = PopupState::default();
        } else if !tm.doc.is_empty() && tm.doc != doc {
            return;
        }
    }
    match t {
        "hello" => {
            send_config(app, tab);
            schedule_push(app, tab);
        }
        "media" => {
            let Some(list) = v.get("items").and_then(Value::as_array) else { return };
            {
                let mut reg = registry().lock().unwrap();
                let tm = reg.entry(tab.to_string()).or_default();
                for raw_item in list.iter().take(40) {
                    let Ok(d) = serde_json::from_value::<DomMedia>(raw_item.clone()) else { continue };
                    let Some(mut d) = sanitize_dom(d) else { continue };
                    // The agent only sends a thumbnail once; keep the one we have.
                    if d.thumb.is_none() {
                        d.thumb = tm.dom.get(&d.id).and_then(|(old, _)| old.thumb.clone());
                    }
                    if tm.dom.len() >= 60 && !tm.dom.contains_key(&d.id) {
                        continue;
                    }
                    tm.dom.insert(d.id.clone(), (d, now_ms()));
                }
            }
            schedule_push(app, tab);
        }
        "gone" => {
            if let Some(ids) = v.get("ids").and_then(Value::as_array) {
                let mut reg = registry().lock().unwrap();
                if let Some(tm) = reg.get_mut(tab) {
                    for id in ids.iter().filter_map(Value::as_str).take(100) {
                        tm.dom.remove(id);
                    }
                }
            }
            schedule_push(app, tab);
        }
        "page" => {
            let s = |k: &str, max: usize| -> String { v.get(k).and_then(Value::as_str).unwrap_or("").chars().take(max).collect() };
            super::on_page_info(app, tab, &s("url", 2048), &s("title", 300), &s("icon", 2048), v.get("audible").and_then(Value::as_bool).unwrap_or(false));
        }
        "skins" => {
            let ids: Vec<String> = v.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).take(20).map(str::to_string).collect()).unwrap_or_default();
            let mut reg = registry().lock().unwrap();
            reg.entry(tab.to_string()).or_default().skins = ids;
        }
        "key" => {
            let k = v.get("k").and_then(Value::as_str).unwrap_or("");
            if SHORTCUTS.contains(&k) {
                let _ = app.emit("browser://shortcut", json!({ "tab": tab, "key": k }));
            }
        }
        "found" => {
            let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let count = v.get("count").and_then(Value::as_u64).unwrap_or(0).min(1_000_000);
            let _ = app.emit("browser://find", json!({ "tab": tab, "ok": ok, "count": count }));
        }
        "scan" => {
            let urls: Vec<String> = v.get("urls").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).filter(|u| u.len() <= 2048).take(40).map(str::to_string).collect()).unwrap_or_default();
            for url in urls {
                candidate(app, tab, url);
            }
        }
        "formats" => {
            let id = v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            probe_formats(app, tab, id);
        }
        "popup" => {
            let mut reg = registry().lock().unwrap();
            let tm = reg.entry(tab.to_string()).or_default();
            tm.popup = PopupState {
                open: v["open"].as_bool().unwrap_or(false),
                group: v["group"].as_str().filter(|g| matches!(*g, "video" | "audio" | "other")).unwrap_or("video").to_string(),
                selected: v["selected"].as_str().unwrap_or("").chars().take(80).collect(),
            };
            let open = tm.popup.open;
            drop(reg);
            if open {
                schedule_push(app, tab);
            }
        }
        "act" => {
            let op = v["op"].as_str().unwrap_or("");
            let id = v["id"].as_str().unwrap_or("");
            let group = v["group"].as_str().unwrap_or("video");
            let quality = v["quality"].as_u64().filter(|q| (1..=8640).contains(q)).map(|q| q as u32);
            let name = v["name"].as_str().map(safe_filename).filter(|n| !n.is_empty());
            let task = v["task"].as_str().unwrap_or("");
            let result = match op {
                // the floating Download button on a video
                "fab-download" => fab_download(app, tab, v["dom"].as_str().unwrap_or(""), quality),
                "cancel" | "reveal" => task_action(app, tab, op, task),
                _ => perform(app, tab, op, id, group, quality, name),
            };
            if let Err(e) = result {
                popup_notice(app, tab, &e);
            }
        }
        "cmd" => {
            let op = v["op"].as_str().unwrap_or("");
            if !matches!(op, "playPause" | "seekBy" | "seekTo" | "setRate" | "setVolume" | "toggleMute" | "toggleFullscreen" | "togglePip" | "goLive") {
                return;
            }
            let val = v["val"].as_f64().filter(|x| x.is_finite()).unwrap_or(0.0);
            command(app, tab, op, val);
        }
        _ => {}
    }
}

/// Sends a player command to the active player of the tab (which may live in an iframe).
pub fn command(app: &AppHandle, tab: &str, op: &str, val: f64) {
    let target = active_dom_id(tab);
    let arg = target.map(|t| Value::String(t)).unwrap_or(Value::Null);
    eval_top(app, tab, &format!("window.__qg&&window.__qg.cmd({}, {val}, {arg})", Value::String(op.to_string())));
}

pub fn active_dom_id(tab: &str) -> Option<String> {
    let reg = registry().lock().unwrap();
    let tm = reg.get(tab)?;
    best_dom(tm.dom.values().map(|(d, _)| d).filter(|d| d.score > 0.0)).map(|d| d.id.clone())
}

pub fn dom_snapshot(tab: &str) -> Vec<DomMedia> {
    let reg = registry().lock().unwrap();
    reg.get(tab).map(|t| t.dom.values().map(|(d, _)| DomMedia { thumb: d.thumb.as_ref().map(|t| format!("{} bytes", t.len())), ..d.clone() }).collect()).unwrap_or_default()
}

pub fn skinned(tab: &str) -> Vec<String> {
    registry().lock().unwrap().get(tab).map(|t| t.skins.clone()).unwrap_or_default()
}

pub fn popup_state(tab: &str) -> PopupState {
    registry().lock().unwrap().get(tab).map(|t| t.popup.clone()).unwrap_or_default()
}

/* ------------------------------------------------------------------------ actions --- */

/// An action asked for from the popup or the panel. The item is looked up by id in
/// the list this module built, so a page cannot make the app fetch anything it did not itself offer.
pub fn perform(app: &AppHandle, tab: &str, op: &str, id: &str, group: &str, quality: Option<u32>, name: Option<String>) -> Result<(), String> {
    {
        let mut reg = registry().lock().unwrap();
        let tm = reg.entry(tab.to_string()).or_default();
        if tm.last_act.map(|t| t.elapsed() < Duration::from_millis(200)).unwrap_or(false) {
            return Err("Slow down".into());
        }
        tm.last_act = Some(Instant::now());
    }
    let items = build_items(tab);
    match op {
        "download" | "play" | "copy" => {
            let item = items.iter().find(|i| i.id == id).ok_or("That item is gone")?;
            if op == "download" && !item.can_download {
                return Err(item.note.clone().unwrap_or_else(|| "Cannot be downloaded".into()));
            }
            if op == "play" && !item.can_play {
                return Err(item.note.clone().unwrap_or_else(|| "Cannot be played here".into()));
            }
            // Fetching may need the page's login: hand the downloader the profile's cookies for that address.
            let (app2, tab2, op2, mut item2) = (app.clone(), tab.to_string(), op.to_string(), item.clone());
            std::thread::spawn(move || {
                if op2 != "copy" {
                    attach_cookies(&app2, &tab2, &mut item2);
                }
                let _ = app2.emit("browser://media-action", json!({ "tab": tab2, "op": op2, "item": item2, "quality": quality, "name": name }));
            });
            Ok(())
        }
        "copy-links" => {
            let group = if matches!(group, "video" | "audio") { group } else { "video" };
            let text: Vec<String> = items.iter().filter(|i| i.group == group).filter_map(|i| i.url.clone()).collect();
            if text.is_empty() {
                return Err("No links to copy".into());
            }
            let _ = app.emit("browser://media-action", json!({ "tab": tab, "op": "copy-text", "text": text.join("
") }));
            Ok(())
        }
        "downloadAll" => {
            let group = if matches!(group, "video" | "audio") { group } else { "video" };
            let mut seen = HashSet::new();
            let chosen: Vec<&MediaItem> = items
                .iter()
                .filter(|i| i.group == group && i.can_download && i.protected.is_none() && !i.live && seen.insert(i.url.clone().unwrap_or_else(|| i.id.clone())))
                .collect();
            if chosen.is_empty() {
                return Err("Nothing to download here".into());
            }
            let _ = app.emit("browser://media-action", json!({ "tab": tab, "op": "downloadAll", "items": chosen }));
            Ok(())
        }
        _ => Err("Unknown action".into()),
    }
}

/// Keys the page forwards to the app (the browser's own shortcuts).
const SHORTCUTS: &[&str] = &[
    "Ctrl+T", "Ctrl+W", "Ctrl+Shift+T", "Ctrl+L", "Ctrl+F", "Ctrl+D", "Ctrl+H", "Ctrl+J", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+N", "Ctrl+Shift+N", "Ctrl+1", "Ctrl+2", "Ctrl+3",
    "Ctrl+4", "Ctrl+5", "Ctrl+6", "Ctrl+7", "Ctrl+8", "Ctrl+9", "Alt+Home", "Escape",
];

/// The floating "Download" button under a video: download that player's best source now,
/// and show the popup on it so progress and other qualities are right there.
fn fab_download(app: &AppHandle, tab: &str, dom_id: &str, quality: Option<u32>) -> Result<(), String> {
    let items = build_items(tab);
    let item = items
        .iter()
        .find(|i| i.dom_id.as_deref() == Some(dom_id) && i.group != "other")
        .or_else(|| items.iter().find(|i| i.active && i.group == "video"))
        .or_else(|| items.iter().find(|i| i.group == "video" && i.can_download))
        .ok_or("No downloadable video found yet: press play, then try again")?;
    if !item.can_download {
        return Err(item.note.clone().unwrap_or_else(|| "This video cannot be downloaded".into()));
    }
    let (app2, tab2, mut item2) = (app.clone(), tab.to_string(), item.clone());
    std::thread::spawn(move || {
        attach_cookies(&app2, &tab2, &mut item2);
        let _ = app2.emit("browser://media-action", json!({ "tab": tab2, "op": "download", "item": item2, "quality": quality, "name": Value::Null }));
    });
    eval_top(app, tab, &format!("window.__qg&&window.__qg.select({})", Value::String(item.id.clone())));
    popup_command(app, tab, "open");
    Ok(())
}

/// Adds a `Cookie` header (the profile's cookies for the item's address) unless it already has one.
fn attach_cookies(app: &AppHandle, tab: &str, item: &mut MediaItem) {
    if item.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("cookie")) {
        return;
    }
    let target = item.url.clone().unwrap_or_else(|| item.page_url.clone());
    if let Some(cookie) = super::cookie_header(app, tab, &target) {
        item.headers.push(("Cookie".into(), cookie));
    }
}

/* -------------------------------------------------------------------- download tasks --- */

fn tasks() -> &'static Mutex<HashMap<String, (String, String, Instant)>> {
    static T: OnceLock<Mutex<HashMap<String, (String, String, Instant)>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// Remembers which popup row a download belongs to, so its progress shows up there.
pub fn register_task(tab: &str, item: &str, task: &str) {
    tasks().lock().unwrap().insert(task.to_string(), (tab.to_string(), item.to_string(), Instant::now() - Duration::from_secs(1)));
}

/// Called on every download update: mirror it into the popup row.
pub fn task_progress(app: &AppHandle, t: &crate::online::download::DownloadTask) {
    let (tab, item) = {
        let mut map = tasks().lock().unwrap();
        let Some(entry) = map.get_mut(&t.id) else { return };
        let terminal = matches!(t.status.as_str(), "done" | "error" | "cancelled");
        if !terminal && entry.2.elapsed() < Duration::from_millis(250) {
            return;
        }
        entry.2 = Instant::now();
        (entry.0.clone(), entry.1.clone())
    };
    let file_name = t.file.as_deref().and_then(|f| std::path::Path::new(f).file_name()).map(|n| n.to_string_lossy().to_string());
    let payload = json!({
        "task": t.id, "status": t.status, "percent": t.percent, "speed": t.speed, "eta": t.eta,
        "downloaded": t.downloaded, "total": t.total, "file": file_name, "error": t.error,
        "verified": t.verified, "warning": t.warning,
    });
    eval_top(app, &tab, &format!("window.__qg&&window.__qg.progress({}, {payload})", Value::String(item)));
}

/// "cancel" | "reveal" for a download started from this tab's popup.
fn task_action(app: &AppHandle, tab: &str, op: &str, task: &str) -> Result<(), String> {
    let owned = tasks().lock().unwrap().get(task).map(|(t, _, _)| t == tab).unwrap_or(false);
    if !owned {
        return Err("That download is gone".into());
    }
    match op {
        "cancel" => crate::online::download::cancel(task),
        _ => {
            let file = crate::online::download::list().into_iter().find(|t| t.id == task).and_then(|t| t.file).ok_or("The file is not ready yet")?;
            let _ = app.emit("browser://media-action", json!({ "tab": tab, "op": "reveal", "file": file }));
        }
    }
    Ok(())
}

/* ------------------------------------------------------- page-source candidates --- */

/// A URL the page's own source mentions (a `<source>`, an og:video, a JSON blob...): it is
/// only listed once a quick request proves it really is playable media.
fn candidate(app: &AppHandle, tab: &str, url: String) {
    let parsed = match url::Url::parse(&url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => u,
        _ => return,
    };
    let key = dedupe_key(&url);
    {
        let mut reg = registry().lock().unwrap();
        let tm = reg.entry(tab.to_string()).or_default();
        if tm.scanned.len() >= 200 || !tm.scanned.insert(key.clone()) {
            return;
        }
    }
    if super::sniffed(tab).iter().any(|s| dedupe_key(&s.url) == key) {
        return;
    }
    let (app, tab) = (app.clone(), tab.to_string());
    let page_url = super::tab(&tab).map(|t| t.url).unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);
        let Ok(_p) = SLOTS.acquire().await else { return };
        let mut req = crate::online::http().get(parsed).header("Range", "bytes=0-2047").timeout(Duration::from_secs(10));
        if !page_url.is_empty() {
            req = req.header("Referer", page_url.as_str());
        }
        let Ok(resp) = req.send().await else { return };
        let status = resp.status().as_u16() as i32;
        let hv = |k: &str| resp.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
        let (ct, cl, cr, cd) = (hv("content-type").unwrap_or_default(), hv("content-length").and_then(|v| v.parse::<u64>().ok()), hv("content-range"), hv("content-disposition"));
        let total = cr.as_deref().and_then(|c| c.rsplit('/').next()).and_then(|t| t.trim().parse::<u64>().ok());
        let Some((kind, size, hint)) = sniff::classify(&url, &ct, cl, total, cd.as_deref(), status) else { return };
        if matches!(kind.as_str(), "hls" | "dash" | "smooth") {
            let Ok(bytes) = resp.bytes().await else { return };
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_string();
            let h = head.trim_start_matches('\u{feff}').trim_start();
            if !(h.starts_with("#EXTM3U") || h.contains("<MPD") || h.contains("<SmoothStreamingMedia")) {
                return;
            }
        }
        let mut headers = vec![("User-Agent".to_string(), crate::online::BROWSER_UA.to_string())];
        if !page_url.is_empty() {
            headers.push(("Referer".to_string(), page_url));
        }
        super::record_sniffed(&app, &tab, url, kind, ct, size, hint, headers);
    });
}

/// Asks the video engine (yt-dlp) which qualities a page-owned player's video has.
fn probe_formats(app: &AppHandle, tab: &str, item_id: String) {
    let items = build_items(tab);
    let Some(item) = items.iter().find(|i| i.id == item_id) else { return };
    if !item.variants.is_empty() || item.page_url.is_empty() {
        return;
    }
    {
        let mut reg = registry().lock().unwrap();
        let tm = reg.entry(tab.to_string()).or_default();
        if !tm.probing.insert(item_id.clone()) {
            return;
        }
    }
    let (app, tab, page) = (app.clone(), tab.to_string(), item.page_url.clone());
    tauri::async_runtime::spawn(async move {
        let req = crate::online::resolve::PrepareRequest { url: page, headers: None, quality: None, force_pipe: None };
        let variants: Vec<Variant> = match crate::online::resolve::prepare(req).await {
            Ok(info) => {
                crate::online::server::forget(&info.id);
                info.qualities.iter().filter(|q| q.height > 0).map(|q| Variant { height: q.height as u32, label: q.label.clone() }).collect()
            }
            Err(_) => vec![],
        };
        {
            let mut reg = registry().lock().unwrap();
            if let Some(tm) = reg.get_mut(&tab) {
                tm.probing.remove(&item_id);
                // an empty answer still means "asked": one variant-less entry ends the spinner
                tm.formats.insert(item_id.clone(), if variants.is_empty() { vec![Variant { height: 0, label: "Best".into() }] } else { variants });
            }
        }
        schedule_push(&app, &tab);
    });
}

/* -------------------------------------------------------------------- enrichment --- */

/// Called for every media response the sniffer accepts.
pub fn on_sniffed(app: &AppHandle, tab: &str, item: &Sniffed) {
    schedule_push(app, tab);
    if sniff::segment_like(&item.url) && !is_manifest(&item.kind) {
        return;
    }
    if !matches!(item.kind.as_str(), "video" | "audio" | "hls" | "dash" | "smooth") {
        return;
    }
    let key = dedupe_key(&item.url);
    {
        let mut reg = registry().lock().unwrap();
        let tm = reg.entry(tab.to_string()).or_default();
        if tm.info.contains_key(&key) || tm.info.len() >= 24 {
            return;
        }
        tm.info.insert(key.clone(), Enriched::default());
    }
    let (app, tab, item) = (app.clone(), tab.to_string(), item.clone());
    tauri::async_runtime::spawn(async move { enrich(app, tab, item, key).await });
}

fn store(tab: &str, key: &str, f: impl FnOnce(&mut Enriched)) {
    let mut reg = registry().lock().unwrap();
    if let Some(tm) = reg.get_mut(tab) {
        f(tm.info.entry(key.to_string()).or_default());
    }
}

async fn enrich(app: AppHandle, tab: String, item: Sniffed, key: String) {
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let Ok(_permit) = SLOTS.acquire().await else { return };
    let headers: Headers = item.headers.clone();

    if is_manifest(&item.kind) {
        if let Some(text) = fetch_text(&item.url, &headers).await {
            let info = manifest::analyze(&text, &item.url);
            store(&tab, &key, |e| e.manifest = info);
            schedule_push(&app, &tab);
        }
    }
    let protected = registry()
        .lock()
        .unwrap()
        .get(&tab)
        .and_then(|t| t.info.get(&key).and_then(|e| e.manifest.as_ref().and_then(|m| m.drm.clone())))
        .is_some()
        || item.hint.as_deref() == Some("DRM");
    if protected || item.kind == "smooth" {
        return;
    }

    let probe = match crate::online::resolve::ffprobe(&item.url, &headers).await {
        Ok(p) => p,
        Err(_) => return,
    };
    store(&tab, &key, |e| {
        e.duration = probe.duration;
        e.width = probe.width;
        e.height = probe.height;
    });
    schedule_push(&app, &tab);

    if item.kind == "audio" || probe.vcodec.is_none() {
        return;
    }
    // Let the page's own frame (if it has one) win; otherwise take one with FFmpeg.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let page_has_thumb = registry()
        .lock()
        .unwrap()
        .get(&tab)
        .map(|t| t.dom.values().any(|(d, _)| d.thumb.is_some() && !d.current_src.is_empty() && dedupe_key(&d.current_src) == key))
        .unwrap_or(false);
    if page_has_thumb {
        return;
    }
    let at = probe.duration.map(|d| (d * 0.1).min(10.0)).unwrap_or(0.0);
    if let Some(jpg) = grab_frame(&item.url, &headers, at).await {
        store(&tab, &key, |e| e.thumb = Some(jpg));
        schedule_push(&app, &tab);
    }
}

async fn fetch_text(url: &str, headers: &Headers) -> Option<String> {
    let mut req = crate::online::http().get(url).timeout(Duration::from_secs(8));
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if matches!(lk.as_str(), "referer" | "cookie" | "origin" | "user-agent" | "authorization") {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() || resp.content_length().map(|l| l > 2_000_000).unwrap_or(false) {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    Some(String::from_utf8_lossy(&bytes[..bytes.len().min(600_000)]).into_owned())
}

/// One small JPEG frame of a media URL as base64, or None.
async fn grab_frame(url: &str, headers: &Headers, at: f64) -> Option<String> {
    use base64::Engine;
    let mut args: Vec<String> = ["-v", "error", "-nostdin", "-rw_timeout", "20000000"].iter().map(|s| s.to_string()).collect();
    if let Some(block) = crate::online::resolve::header_block(url, headers) {
        args.extend(["-headers".into(), block]);
    }
    args.extend(["-ss".into(), format!("{at:.2}"), "-i".into(), url.to_string()]);
    args.extend(["-frames:v", "1", "-vf", "scale=192:-2", "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"].iter().map(|s| s.to_string()));
    let mut cmd = tokio::process::Command::new(crate::tools::ffmpeg());
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let read = async {
        let mut out = Vec::new();
        stdout.read_to_end(&mut out).await.ok()?;
        Some(out)
    };
    let bytes = tokio::time::timeout(Duration::from_secs(25), read).await.ok()??;
    let _ = child.wait().await;
    if bytes.len() < 200 || bytes.len() > 45_000 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sn(id: &str, url: &str, kind: &str, time: i64) -> Sniffed {
        Sniffed {
            id: id.into(),
            url: url.into(),
            kind: kind.into(),
            mime: String::new(),
            size: None,
            headers: vec![],
            page_url: "https://site.example/watch".into(),
            page_title: "The Watch Page".into(),
            time,
            hint: None,
        }
    }

    fn dom(id: &str, src: &str) -> DomMedia {
        DomMedia { id: id.into(), tag: "video".into(), current_src: src.into(), duration: Some(90.0), width: 1280, height: 720, rect_w: 640.0, rect_h: 360.0, visible: 1.0, score: 80.0, volume: 1.0, rate: 1.0, ..Default::default() }
    }

    /// Runs `f` against a private tab id with the given sniffed/dom/enrichment state.
    fn with_tab<R>(name: &str, sniffed: Vec<Sniffed>, doms: Vec<DomMedia>, info: Vec<(&str, Enriched)>, f: impl FnOnce(&str) -> R) -> R {
        let tab = format!("test-{name}");
        super::super::browser().sniffed.lock().unwrap().insert(tab.clone(), sniffed);
        super::super::browser().tabs.lock().unwrap().push(super::super::new_state(tab.clone(), "default", "https://site.example/watch".into(), "The Watch Page".into(), false, false));
        {
            let mut reg = registry().lock().unwrap();
            let tm = reg.entry(tab.clone()).or_default();
            for d in doms {
                tm.dom.insert(d.id.clone(), (d, 5));
            }
            for (k, e) in info {
                tm.info.insert(k.to_string(), e);
            }
        }
        let r = f(&tab);
        super::super::browser().sniffed.lock().unwrap().remove(&tab);
        super::super::browser().tabs.lock().unwrap().retain(|t| t.id != tab);
        registry().lock().unwrap().remove(&tab);
        r
    }

    #[test]
    fn a_played_file_merges_the_page_view_and_the_network_view() {
        let mut d = dom("fabc-1", "https://cdn.example/media/holiday.mp4?sig=1");
        d.thumb = Some("/9j/".to_string() + &"A".repeat(300));
        d.title = "Holiday clip".into();
        let items = with_tab("merge", vec![sn("s1", "https://cdn.example/media/holiday.mp4?sig=2", "video", 10)], vec![d], vec![], |t| build_items(t));
        assert_eq!(items.len(), 1, "one file, one entry: {items:#?}");
        let i = &items[0];
        assert_eq!((i.source.as_str(), i.group.as_str(), i.format.as_str()), ("both", "video", "MP4"));
        assert_eq!(i.title, "Holiday clip");
        assert_eq!(i.duration, Some(90.0));
        assert_eq!(i.height, Some(720));
        assert!(i.thumb.is_some() && i.active && i.can_download && i.can_play);
        assert_eq!(i.id, "s1", "network ids stay stable");
    }

    #[test]
    fn renditions_and_segments_go_to_other_and_the_master_stays() {
        let master = ManifestInfo { format: "HLS".into(), master: true, heights: vec![1080, 360], children: vec!["https://cdn.example/v/360/index.m3u8".into()], ..Default::default() };
        let info = vec![("cdn.example/v/master.m3u8", Enriched { manifest: Some(master), ..Default::default() })];
        let items = with_tab(
            "hls",
            vec![
                sn("m", "https://cdn.example/v/master.m3u8", "hls", 1),
                sn("r", "https://cdn.example/v/360/index.m3u8", "hls", 2),
                sn("seg", "https://cdn.example/v/360/seg-004.m4s", "video", 3),
            ],
            vec![],
            info,
            |t| build_items(t),
        );
        let by = |id: &str| items.iter().find(|i| i.id == id).unwrap();
        assert_eq!(by("m").group, "video");
        assert_eq!(by("m").title, "The Watch Page", "a generic playlist name falls back to the page title");
        assert_eq!(by("m").height, Some(1080));
        assert_eq!(by("r").group, "other");
        assert_eq!(by("seg").group, "other");
        assert_eq!(items[0].id, "m", "videos are listed first");
    }

    #[test]
    fn a_blob_player_takes_the_newest_top_level_manifest() {
        let mpd = ManifestInfo { format: "DASH".into(), duration: Some(634.0), heights: vec![720], ..Default::default() };
        let info = vec![("cdn.example/x/stream.mpd", Enriched { manifest: Some(mpd), ..Default::default() })];
        let mut blob = dom("fzz-1", "blob:https://site.example/uuid");
        blob.duration = Some(634.5);
        let items = with_tab("mse", vec![sn("d", "https://cdn.example/x/stream.mpd", "dash", 1)], vec![blob], info, |t| build_items(t));
        assert_eq!(items.len(), 1, "{items:#?}");
        assert_eq!(items[0].source, "both");
        assert_eq!(items[0].duration, Some(634.5));
        assert!(items[0].active);
    }

    #[test]
    fn protected_streams_are_listed_last_and_cannot_be_saved() {
        let mpd = ManifestInfo { format: "DASH".into(), drm: Some("Widevine".into()), ..Default::default() };
        let info = vec![("cdn.example/drm/stream.mpd", Enriched { manifest: Some(mpd), ..Default::default() })];
        let items = with_tab(
            "drm",
            vec![sn("d", "https://cdn.example/drm/stream.mpd", "dash", 9), sn("f", "https://cdn.example/free.mp4", "video", 1)],
            vec![],
            info,
            |t| build_items(t),
        );
        assert_eq!(items[0].id, "f");
        let d = &items[1];
        assert_eq!(d.protected.as_deref(), Some("Widevine"));
        assert!(!d.can_download && !d.can_play);
        assert!(d.note.as_deref().unwrap().contains("DRM"));
    }

    #[test]
    fn a_page_reporting_encryption_marks_a_blob_player_protected() {
        let mut blob = dom("fq-1", "blob:https://site.example/uuid");
        blob.encrypted = true;
        blob.key_system = "PlayReady".into();
        let items = with_tab("enc", vec![], vec![blob], vec![], |t| build_items(t));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].protected.as_deref(), Some("PlayReady"));
        assert!(items[0].via_page && !items[0].can_download);
    }

    #[test]
    fn audio_tiny_players_and_live_streams_are_sorted_out() {
        let mut audio = dom("fa-1", "https://cdn.example/song.mp3");
        audio.tag = "audio".into();
        audio.duration = Some(200.0);
        audio.rect_w = 0.0;
        audio.rect_h = 0.0;
        let mut ad = dom("fa-2", "https://ads.example/pixel.mp4");
        ad.rect_w = 40.0;
        ad.rect_h = 30.0;
        ad.width = 40;
        ad.score = -30.0;
        let mut cam = dom("fa-3", "");
        cam.src_object = "MediaStream".into();
        cam.live = true;
        let items = with_tab("misc", vec![], vec![audio, ad, cam], vec![], |t| build_items(t));
        let by = |suffix: &str| items.iter().find(|i| i.id.ends_with(suffix)).unwrap();
        assert_eq!(by("fa-1").group, "audio");
        assert_eq!(by("fa-1").format, "MP3");
        assert_eq!(by("fa-2").group, "other");
        let c = by("fa-3");
        assert!(c.live && !c.can_download && !c.can_play);
        assert_eq!(c.format, "Live stream");
    }

    #[test]
    fn a_sniffed_file_played_in_a_tiny_player_is_not_a_video_entry() {
        let mut d = dom("fad-1", "https://ads.example/promo.mp4");
        d.rect_w = 40.0;
        d.rect_h = 30.0;
        d.width = 640; // intrinsic size is big, the box on the page is not
        let items = with_tab("tinynet", vec![sn("a", "https://ads.example/promo.mp4", "video", 1)], vec![d], vec![], |t| build_items(t));
        assert_eq!(items[0].group, "other");
    }

    #[test]
    fn what_a_page_says_is_validated() {
        let ok = sanitize_dom(DomMedia { id: "fab12-7".into(), tag: "video".into(), volume: 5.0, duration: Some(f64::INFINITY), ..Default::default() }).unwrap();
        assert_eq!(ok.volume, 1.0);
        assert_eq!(ok.duration, None);
        assert!(sanitize_dom(DomMedia { id: "../../etc".into(), tag: "video".into(), ..Default::default() }).is_none());
        assert!(sanitize_dom(DomMedia { id: "fab-1".into(), tag: "script".into(), ..Default::default() }).is_none());
        let long = sanitize_dom(DomMedia { id: "fab-1".into(), tag: "video".into(), title: "x".repeat(5000), current_src: "y".repeat(9000), ..Default::default() }).unwrap();
        assert_eq!((long.title.len(), long.current_src.len()), (200, 4096));

        let good = "/9j/".to_string() + &"B".repeat(400);
        assert!(valid_thumb(&good));
        assert!(!valid_thumb(&format!("<script>{good}")), "markup is not a thumbnail");
        assert!(!valid_thumb("iVBORw0KGgo=".repeat(40).as_str()), "only JPEG");
        assert!(!valid_thumb(&("/9j/".to_string() + &"B".repeat(70_000))), "size cap");
        let bad = sanitize_dom(DomMedia { id: "fab-1".into(), tag: "video".into(), thumb: Some("data:image/svg+xml,<svg onload=1>".into()), ..Default::default() }).unwrap();
        assert!(bad.thumb.is_none());
    }

    #[test]
    fn settings_are_clamped_and_resolved_per_site() {
        let mut c = MediaConfig { mode: "weird".into(), seek: 9999, corner: "middle".into(), popup_key: "Alt+<script>".into(), ..Default::default() };
        c.origins.insert("news.example".into(), "site".into());
        c.origins.insert("bad.example".into(), "hack".into());
        let c = c.sanitized();
        assert_eq!((c.mode.as_str(), c.seek, c.corner.as_str(), c.popup_key.as_str()), ("auto", 120, "br", "Alt+M"));
        assert_eq!(c.mode_for("www.news.example"), "site");
        assert_eq!(c.mode_for("bad.example"), "auto");
        assert_eq!(c.for_agent("other.example")["mode"], "auto");
        let ok = MediaConfig { popup_key: "Ctrl+Shift+V".into(), ..Default::default() }.sanitized();
        assert_eq!(ok.popup_key, "Ctrl+Shift+V");
    }

    #[test]
    fn shortcuts_and_file_names_are_validated() {
        for ok in ["Alt+M", "Ctrl+Shift+V", "F8", "Shift+F2", "Alt+1"] {
            assert!(valid_shortcut(ok), "{ok}");
        }
        for bad in ["M", "Alt+", "Alt+Alt+M", "Ctrl+<", "Win+M", "Alt+MM", "F13", "", "Ctrl+Shift+Alt+A+B"] {
            assert!(!valid_shortcut(bad), "{bad}");
        }
        assert_eq!(safe_filename("  My: \"video\" / part 1?.. "), "My video part 1");
        assert_eq!(safe_filename("a\\b<c>d|e"), "a b c d e");
        assert_eq!(safe_filename("x".repeat(300).as_str()).chars().count(), 110);
        assert_eq!(safe_filename("..."), "");
    }

    #[test]
    fn items_carry_their_page_player_quality_choices_and_a_file_name() {
        let mpd = ManifestInfo { format: "DASH".into(), heights: vec![1080, 720, 360], ..Default::default() };
        let info = vec![("cdn.example/x/stream.mpd", Enriched { manifest: Some(mpd), ..Default::default() })];
        let mut blob = dom("fzz-1", "blob:https://site.example/uuid");
        blob.duration = Some(60.0);
        let items = with_tab("variants", vec![sn("d", "https://cdn.example/x/stream.mpd", "dash", 1)], vec![blob], info, |t| build_items(t));
        let i = &items[0];
        assert_eq!(i.dom_id.as_deref(), Some("fzz-1"));
        assert_eq!(i.variants.iter().map(|v| v.height).collect::<Vec<_>>(), vec![1080, 720, 360]);
        assert_eq!(i.filename, "The Watch Page");
    }

    #[test]
    fn percent_decoding_keeps_unicode_names() {
        assert_eq!(percent_decode("Phim%20Hay%20%C4%91%E1%BA%B9p.mp4"), "Phim Hay đẹp.mp4");
        assert_eq!(percent_decode("100%.mp4"), "100%.mp4");
        assert_eq!(percent_decode("%"), "%");
    }
}
