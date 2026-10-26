//! The embedded browser: real web pages inside the gallery window.
//!
//! Each tab is a native child WebView2 (the Chromium engine of Microsoft Edge)
//! placed over the browser view's content area (the React UI supplies the
//! rectangle). Tabs belong to a **profile**; every profile is its own data
//! folder (cookies, logins, cache, history, bookmarks) under `data/browser/`,
//! so sessions never mix, and private tabs use a folder that is deleted again.
//! uBlock Origin is loaded in every profile, and every network response is
//! watched by `sniff` so any video the page loads can be played or downloaded.
//!
//! Websites get no access to the app's commands: the child webviews have no IPC
//! permission (see `capabilities/`). Each frame does run the page agent
//! (`agent.js`), which can only post plain messages that `media` validates.

pub mod extensions;
pub mod manifest;
pub mod media;
pub mod profiles;
pub mod sniff;
pub mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

use sniff::Sniffed;

#[derive(Debug, Clone, Copy, Default)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub id: String,
    pub profile: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub favicon: String,
    pub private: bool,
    pub pinned: bool,
    pub audible: bool,
    /// Has a real webview (a restored or new-tab-page tab gets one when first needed).
    pub live: bool,
    /// The new-tab page: nothing loaded yet.
    pub newtab: bool,
    pub zoom: f64,
    pub can_back: bool,
    pub can_forward: bool,
}

#[derive(Default)]
struct Browser {
    tabs: Mutex<Vec<TabState>>,
    bounds: Mutex<Bounds>,
    active: Mutex<Option<String>>,
    sniffed: Mutex<HashMap<String, Vec<Sniffed>>>,
    counter: AtomicU32,
    /// Recently closed tabs per profile, for "reopen closed tab".
    closed: Mutex<HashMap<String, Vec<store::SessionTab>>>,
    /// Throw-away data folders of private tabs.
    private_dirs: Mutex<HashMap<String, PathBuf>>,
    /// The tab whose page is showing something in HTML5 fullscreen (video): it fills the whole window.
    fullscreen: Mutex<Option<String>>,
}

fn browser() -> &'static Browser {
    static B: OnceLock<Browser> = OnceLock::new();
    B.get_or_init(Browser::default)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn urlencode(q: &str) -> String {
    url::form_urlencoded::byte_serialize(q.as_bytes()).collect()
}

/// What the address bar accepts: a URL, a bare domain, or a search.
pub fn target_url(input: &str) -> Result<url::Url, String> {
    let t = input.trim();
    if t.is_empty() {
        return url::Url::parse("https://duckduckgo.com/").map_err(|e| e.to_string());
    }
    if let Ok(u) = url::Url::parse(t) {
        if matches!(u.scheme(), "http" | "https") {
            return Ok(u);
        }
    }
    let looks_like_host = !t.contains(' ') && (t.contains('.') || t.starts_with("localhost")) && !t.starts_with('?');
    if looks_like_host {
        if let Ok(u) = url::Url::parse(&format!("https://{t}")) {
            return Ok(u);
        }
    }
    let engine = store::settings().search;
    url::Url::parse(&format!("{}{}", store::search_template(&engine), urlencode(t))).map_err(|e| e.to_string())
}

fn with_tab(id: &str, f: impl FnOnce(&mut TabState)) -> Option<TabState> {
    let mut tabs = browser().tabs.lock().unwrap();
    let tab = tabs.iter_mut().find(|t| t.id == id)?;
    f(tab);
    Some(tab.clone())
}

fn emit_tab(app: &AppHandle, tab: &TabState) {
    let _ = app.emit("browser://tab", tab.clone());
}

pub fn tab(id: &str) -> Option<TabState> {
    browser().tabs.lock().unwrap().iter().find(|t| t.id == id).cloned()
}

/// Called for every media response the sniffer accepts.
pub fn record_sniffed(
    app: &AppHandle,
    tab_id: &str,
    url: String,
    kind: String,
    mime: String,
    size: Option<u64>,
    hint: Option<String>,
    request_headers: Vec<(String, String)>,
) {
    let (page_url, page_title) = tab(tab_id).map(|t| (t.url, t.title)).unwrap_or_default();

    // What a download of this exact URL must send to be accepted.
    let mut headers: Vec<(String, String)> = vec![];
    for (k, v) in request_headers {
        let lk = k.to_ascii_lowercase();
        if matches!(lk.as_str(), "referer" | "user-agent" | "cookie" | "origin") && !v.is_empty() {
            headers.push((k, v));
        }
    }
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("referer")) && !page_url.is_empty() {
        headers.push(("Referer".into(), page_url.clone()));
    }

    let key = sniff::dedupe_key(&url);
    let item = {
        let mut map = browser().sniffed.lock().unwrap();
        let list = map.entry(tab_id.to_string()).or_default();
        if let Some(existing) = list.iter_mut().find(|s| sniff::dedupe_key(&s.url) == key) {
            existing.url = url;
            existing.size = size.max(existing.size);
            existing.headers = headers;
            existing.time = now_ms();
            existing.clone()
        } else {
            let item = Sniffed {
                id: uuid::Uuid::new_v4().simple().to_string(),
                url,
                kind,
                mime,
                size,
                headers,
                page_url,
                page_title,
                time: now_ms(),
                hint,
            };
            list.push(item.clone());
            if list.len() > 80 {
                list.remove(0);
            }
            item
        }
    };
    let _ = app.emit("browser://sniff", serde_json::json!({ "tab": tab_id, "item": item }));
    media::on_sniffed(app, tab_id, &item);
}

pub fn sniffed(tab: &str) -> Vec<Sniffed> {
    browser().sniffed.lock().unwrap().get(tab).cloned().unwrap_or_default()
}

pub fn clear_sniffed(app: &AppHandle, tab: &str) {
    browser().sniffed.lock().unwrap().remove(tab);
    media::reset_tab(app, tab);
    let _ = app.emit("browser://sniff-cleared", tab.to_string());
}

pub fn tabs() -> Vec<TabState> {
    browser().tabs.lock().unwrap().clone()
}

fn webview_of(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(id).ok_or_else(|| "that tab is not loaded".to_string())
}

fn apply_bounds(app: &AppHandle) {
    let mut b = *browser().bounds.lock().unwrap();
    let fs_tab = browser().fullscreen.lock().unwrap().clone();
    if let (Some(_), Some(win)) = (&fs_tab, app.get_window("main")) {
        if let Ok(size) = win.inner_size() {
            let l = size.to_logical::<f64>(win.scale_factor().unwrap_or(1.0));
            b = Bounds { x: 0.0, y: 0.0, w: l.width, h: l.height };
        }
    }
    for t in tabs() {
        if fs_tab.as_deref().map(|f| f != t.id).unwrap_or(false) {
            continue;
        }
        if let Some(w) = app.get_webview(&t.id) {
            let _ = w.set_position(LogicalPosition::new(b.x, b.y));
            let _ = w.set_size(LogicalSize::new(b.w.max(1.0), b.h.max(1.0)));
        }
    }
}

pub fn set_bounds(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) {
    *browser().bounds.lock().unwrap() = Bounds { x, y, w, h };
    apply_bounds(app);
}

/// Shows `id` and hides every other tab (a tab without a webview yet gets one now).
pub fn activate(app: &AppHandle, id: &str) {
    *browser().active.lock().unwrap() = Some(id.to_string());
    if let Some(t) = tab(id) {
        if !t.live && !t.url.is_empty() {
            let _ = create_webview(app, id);
        }
    }
    apply_bounds(app);
    for t in tabs() {
        if let Some(w) = app.get_webview(&t.id) {
            let _ = if t.id == id { w.show() } else { w.hide() };
        }
    }
}

pub fn hide_all(app: &AppHandle) {
    for t in tabs() {
        if let Some(w) = app.get_webview(&t.id) {
            let _ = w.hide();
        }
    }
}

/// Re-shows whichever tab was active (after a dialog or the lock screen).
pub fn show_active(app: &AppHandle) {
    let id = browser().active.lock().unwrap().clone();
    if let Some(id) = id {
        activate(app, &id);
    }
}

fn session_of(profile: &str) -> store::Session {
    let tabs = tabs();
    let mine: Vec<&TabState> = tabs.iter().filter(|t| t.profile == profile && !t.private && !t.url.is_empty()).collect();
    let active = browser().active.lock().unwrap().clone();
    let active_idx = mine.iter().position(|t| Some(&t.id) == active.as_ref()).unwrap_or(0);
    store::Session { tabs: mine.iter().map(|t| store::SessionTab { url: t.url.clone(), title: t.title.clone(), pinned: t.pinned }).collect(), active: active_idx }
}

fn save_session(profile: &str) {
    if !profile.is_empty() {
        store::save_session(profile, session_of(profile));
    }
}

pub fn close_tab(app: &AppHandle, id: &str) {
    let closed = tab(id);
    if let Some(w) = app.get_webview(id) {
        let _ = w.close();
    }
    browser().tabs.lock().unwrap().retain(|t| t.id != id);
    browser().sniffed.lock().unwrap().remove(id);
    media::forget_tab(id);
    if let Some(t) = &closed {
        if !t.private && !t.url.is_empty() {
            let mut map = browser().closed.lock().unwrap();
            let stack = map.entry(t.profile.clone()).or_default();
            stack.push(store::SessionTab { url: t.url.clone(), title: t.title.clone(), pinned: t.pinned });
            if stack.len() > 25 {
                stack.remove(0);
            }
        }
    }
    if let Some(dir) = browser().private_dirs.lock().unwrap().remove(id) {
        profiles::wipe_dir(dir);
    }
    {
        let mut active = browser().active.lock().unwrap();
        if active.as_deref() == Some(id) {
            *active = None;
        }
    }
    if let Some(t) = &closed {
        save_session(&t.profile);
    }
    let _ = app.emit("browser://closed", id.to_string());
}

/// Closes every tab of a profile (the profile is being deleted or wiped).
pub fn close_profile_tabs(app: &AppHandle, profile: &str) {
    for t in tabs().into_iter().filter(|t| t.profile == profile) {
        close_tab(app, &t.id);
    }
    browser().closed.lock().unwrap().remove(profile);
}

pub fn reopen_closed(app: &AppHandle, profile: &str) -> Result<String, String> {
    let popped = browser().closed.lock().unwrap().get_mut(profile).and_then(|s| s.pop());
    let t = popped.ok_or("no closed tab to reopen")?;
    let id = open_tab(app, profile, &t.url, false)?;
    if t.pinned {
        set_pinned(app, &id, true);
    }
    Ok(id)
}

pub fn navigate(app: &AppHandle, id: &str, input: &str) -> Result<(), String> {
    let url = target_url(input)?;
    clear_sniffed(app, id);
    tab(id).ok_or("that tab is gone")?;
    let updated = with_tab(id, |t| {
        t.url = url.to_string();
        t.newtab = false;
        t.loading = true;
    });
    if let Some(u) = &updated {
        emit_tab(app, u);
    }
    if app.get_webview(id).is_some() {
        return webview_of(app, id)?.navigate(url).map_err(|e| e.to_string());
    }
    // a new-tab page (or restored tab) gets its webview on the first navigation
    create_webview(app, id)?;
    let active = browser().active.lock().unwrap().clone();
    if active.as_deref() == Some(id) {
        activate(app, id);
    }
    Ok(())
}

pub fn script(app: &AppHandle, id: &str, js: &str) -> Result<(), String> {
    webview_of(app, id)?.eval(js).map_err(|e| e.to_string())
}

pub fn set_pinned(app: &AppHandle, id: &str, pinned: bool) {
    if let Some(t) = with_tab(id, |t| t.pinned = pinned) {
        // pinned tabs sit first
        {
            let mut tabs = browser().tabs.lock().unwrap();
            if let Some(i) = tabs.iter().position(|x| x.id == id) {
                let item = tabs.remove(i);
                let at = if pinned { tabs.iter().take_while(|x| x.pinned).count() } else { tabs.iter().filter(|x| x.pinned).count() };
                let at = at.min(tabs.len());
                tabs.insert(at, item);
            }
        }
        emit_tab(app, &t);
        save_session(&t.profile);
        let _ = app.emit("browser://order", ordered_ids());
    }
}

fn ordered_ids() -> Vec<String> {
    tabs().into_iter().map(|t| t.id).collect()
}

/// New order of the tabs (drag and drop in the strip).
pub fn reorder(app: &AppHandle, ids: &[String]) {
    {
        let mut tabs = browser().tabs.lock().unwrap();
        let mut sorted: Vec<TabState> = Vec::with_capacity(tabs.len());
        for id in ids {
            if let Some(i) = tabs.iter().position(|t| &t.id == id) {
                sorted.push(tabs.remove(i));
            }
        }
        sorted.extend(tabs.drain(..));
        *tabs = sorted;
    }
    let _ = app.emit("browser://order", ordered_ids());
    if let Some(t) = ids.first().and_then(|i| tab(i)) {
        save_session(&t.profile);
    }
}

const ZOOM_STEPS: &[f64] = &[0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];

/// "in" | "out" | "reset"
pub fn zoom(app: &AppHandle, id: &str, op: &str) -> Result<f64, String> {
    let cur = tab(id).map(|t| t.zoom).unwrap_or(1.0);
    let next = match op {
        "in" => ZOOM_STEPS.iter().copied().find(|z| *z > cur + 0.001).unwrap_or(5.0),
        "out" => ZOOM_STEPS.iter().rev().copied().find(|z| *z < cur - 0.001).unwrap_or(0.25),
        _ => 1.0,
    };
    webview_of(app, id)?.set_zoom(next).map_err(|e| e.to_string())?;
    if let Some(t) = with_tab(id, |t| t.zoom = next) {
        emit_tab(app, &t);
    }
    Ok(next)
}

/// Page-agent report: the title / icon / address of the page as it is now (single-page
/// apps change these without a navigation), and whether it is playing sound.
pub fn on_page_info(app: &AppHandle, id: &str, url: &str, title: &str, icon: &str, audible: bool) {
    let mut changed_url = false;
    let updated = with_tab(id, |t| {
        if !title.is_empty() {
            t.title = title.to_string();
        }
        if url.starts_with("http") && t.url != url {
            t.url = url.to_string();
            changed_url = true;
        }
        if icon.is_empty() || icon.starts_with("http") {
            t.favicon = icon.to_string();
        }
        t.audible = audible;
    });
    if let Some(t) = updated {
        if !t.private {
            if changed_url {
                store::add_history(&t.profile, &t.url, &t.title);
            } else {
                store::set_history_title(&t.profile, &t.url, &t.title);
            }
        }
        emit_tab(app, &t);
    }
}

/// Chromium switches for the browsing profiles.
fn browser_args() -> String {
    let mut args = String::from(
        // Tauri's defaults, plus: keep Manifest V2 extensions (uBlock Origin) alive
        // in case the runtime has started phasing them out.
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ExtensionManifestV2Unsupported,ExtensionManifestV2Disabled",
    );
    // Test hook: lets an external tool drive the page over the DevTools protocol.
    if let Ok(port) = std::env::var("QG_BROWSER_DEBUG_PORT") {
        args.push_str(&format!(" --remote-debugging-port={port} --remote-allow-origins=*"));
    }
    args
}

/// Data folder of a tab: its profile's, or a throw-away one for private tabs.
fn data_dir_for(t: &TabState) -> Result<PathBuf, String> {
    if t.private {
        let mut map = browser().private_dirs.lock().unwrap();
        let dir = map.entry(t.id.clone()).or_insert_with(|| crate::paths::private_dir().join(uuid::Uuid::new_v4().simple().to_string()));
        std::fs::create_dir_all(&*dir).map_err(|e| e.to_string())?;
        return Ok(dir.clone());
    }
    profiles::dir(&t.profile).ok_or_else(|| "bad profile".to_string())
}

fn new_state(id: String, profile: &str, url: String, title: String, private: bool, pinned: bool) -> TabState {
    TabState {
        id,
        profile: profile.to_string(),
        newtab: url.is_empty(),
        loading: !url.is_empty() && private,
        url,
        title,
        favicon: String::new(),
        private,
        pinned,
        audible: false,
        live: false,
        zoom: 1.0,
        can_back: false,
        can_forward: false,
    }
}

/// Opens a tab in `profile`. An empty `input` is the new-tab page (no webview until needed).
pub fn open_tab(app: &AppHandle, profile: &str, input: &str, private: bool) -> Result<String, String> {
    if !private && profiles::get(profile).is_none() {
        return Err("no such profile".into());
    }
    let url = if input.trim().is_empty() { String::new() } else { target_url(input)?.to_string() };
    let n = browser().counter.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("browser-{n}");
    let mut state = new_state(id.clone(), profile, url.clone(), String::new(), private, false);
    state.loading = !url.is_empty();
    browser().tabs.lock().unwrap().push(state.clone());
    if !private {
        profiles::touch(profile);
    }
    if url.is_empty() {
        emit_tab(app, &state);
    } else {
        create_webview(app, &id)?;
    }
    save_session(profile);
    Ok(id)
}

/// Restores a profile's tabs from its saved session: cheap, no webviews until a tab is shown.
pub fn restore_session(app: &AppHandle, profile: &str) -> Vec<String> {
    let s = store::session(profile);
    let mut ids = vec![];
    for st in s.tabs.iter().take(40) {
        let n = browser().counter.fetch_add(1, Ordering::Relaxed) + 1;
        let id = format!("browser-{n}");
        let state = new_state(id.clone(), profile, st.url.clone(), st.title.clone(), false, st.pinned);
        browser().tabs.lock().unwrap().push(state.clone());
        emit_tab(app, &state);
        ids.push(id);
    }
    ids
}

/// Builds the native webview of a tab.
fn create_webview(app: &AppHandle, id: &str) -> Result<(), String> {
    let t = tab(id).ok_or("that tab is gone")?;
    if app.get_webview(id).is_some() {
        return Ok(());
    }
    let url = url::Url::parse(&t.url).map_err(|e| e.to_string())?;
    let window = app.get_window("main").ok_or("no main window")?;
    let data_dir = data_dir_for(&t)?;

    let (a_nav, a_load, a_title, a_new, a_dl) = (app.clone(), app.clone(), app.clone(), app.clone(), app.clone());
    let (i_nav, i_load, i_title, i_dl, i_new) = (id.to_string(), id.to_string(), id.to_string(), id.to_string(), id.to_string());

    // The engine registers extensions asynchronously when a profile's browser process starts, so the
    // very first page of a cold profile would load before they are ready. Start that one on a blank
    // page and go to the real address a moment later.
    let ext_dir = extensions::root();
    let has_ext = std::fs::read_dir(&ext_dir).map(|mut d| d.next().is_some()).unwrap_or(false);
    let cold = has_ext && !tabs().iter().any(|x| x.id != id && x.live && x.profile == t.profile && x.private == t.private);
    let first_url = if cold { url::Url::parse("about:blank").map_err(|e| e.to_string())? } else { url.clone() };

    let mut builder = WebviewBuilder::new(id, WebviewUrl::External(first_url))
        .data_directory(data_dir)
        .additional_browser_args(&browser_args())
        .incognito(t.private)
        .devtools(true)
        .on_navigation(move |u| {
            if matches!(u.scheme(), "http" | "https") {
                if let Some(t) = with_tab(&i_nav, |t| {
                    t.url = u.to_string();
                    t.loading = true;
                    t.newtab = false;
                }) {
                    emit_tab(&a_nav, &t);
                }
            }
            true
        })
        .on_page_load(move |wv, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            if payload.url().scheme() == "about" {
                return;
            }
            if loading {
                // A new page: what was sniffed on the previous one no longer applies.
                clear_sniffed(&a_load, &i_load);
            }
            let page_url = payload.url().to_string();
            let updated = with_tab(&i_load, |t| {
                t.url = page_url.clone();
                t.loading = loading;
                if loading {
                    t.audible = false;
                }
            });
            if let Some(t) = updated {
                if !loading && !t.private {
                    store::add_history(&t.profile, &t.url, &t.title);
                }
                emit_tab(&a_load, &t);
                if !loading {
                    save_session(&t.profile);
                    refresh_history_flags(&a_load, &i_load, &wv);
                }
            }
        })
        .on_document_title_changed(move |_, title| {
            if let Some(t) = with_tab(&i_title, |t| t.title = title.clone()) {
                if !t.private {
                    store::set_history_title(&t.profile, &t.url, &t.title);
                }
                emit_tab(&a_title, &t);
            }
        })
        // window.open() with a size (login / OAuth popups) is a real window with an opener;
        // target=_blank links become tabs in the same profile.
        .on_new_window(move |u, features| {
            if features.size().is_some() {
                return NewWindowResponse::Allow;
            }
            let app = a_new.clone();
            let target = u.to_string();
            let from = i_new.clone();
            std::thread::spawn(move || {
                if let Some(t) = tab(&from) {
                    if let Ok(id) = open_tab(&app, &t.profile, &target, t.private) {
                        activate(&app, &id);
                        let _ = app.emit("browser://focus-tab", id);
                    }
                }
            });
            NewWindowResponse::Deny
        })
        // A click on a download link goes to the gallery's downloader instead.
        .on_download(move |_, event| match event {
            DownloadEvent::Requested { url, .. } => {
                let referer = tab(&i_dl).map(|t| t.url).unwrap_or_default();
                let _ = a_dl.emit("browser://download-request", serde_json::json!({ "url": url.to_string(), "referer": referer }));
                false
            }
            _ => true,
        });

    // Extensions (uBlock Origin and whatever was added) apply to every profile, private tabs included
    if has_ext {
        builder = builder.browser_extensions_enabled(true).extensions_path(ext_dir);
    }

    let b = *browser().bounds.lock().unwrap();
    let (w, h) = if b.w < 2.0 { (800.0, 600.0) } else { (b.w, b.h) };
    let webview = window.add_child(builder, LogicalPosition::new(b.x, b.y), LogicalSize::new(w, h)).map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        let (app2, id2) = (app.clone(), id.to_string());
        let _ = webview.with_webview(move |pw| unsafe {
            if let Err(e) = install_sniffer(&pw.controller(), app2.clone(), id2.clone()) {
                eprintln!("could not attach the video sniffer: {e}");
            }
            if let Err(e) = install_agent(&pw.controller(), app2, id2) {
                eprintln!("could not attach the page agent: {e}");
            }
        });
    }
    #[cfg(not(windows))]
    let _ = webview;

    if cold {
        let (app3, id3, want) = (app.clone(), id.to_string(), t.url.clone());
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1300));
            // still the same address (nobody navigated meanwhile) and the tab still exists
            if tab(&id3).map(|x| x.url) == Some(want.clone()) {
                if let (Some(w), Ok(u)) = (app3.get_webview(&id3), url::Url::parse(&want)) {
                    let _ = w.navigate(u);
                }
            }
        });
    }

    if let Some(t) = with_tab(id, |t| t.live = true) {
        emit_tab(app, &t);
    }
    Ok(())
}

/// Back / forward availability after a page load.
fn refresh_history_flags(app: &AppHandle, id: &str, wv: &tauri::Webview) {
    #[cfg(windows)]
    {
        let (app2, id2) = (app.clone(), id.to_string());
        let _ = wv.with_webview(move |pw| unsafe {
            use windows::core::BOOL;
            if let Ok(core) = pw.controller().CoreWebView2() {
                let (mut b, mut f) = (BOOL::default(), BOOL::default());
                let _ = core.CanGoBack(&mut b);
                let _ = core.CanGoForward(&mut f);
                if let Some(t) = with_tab(&id2, |t| {
                    t.can_back = b.as_bool();
                    t.can_forward = f.as_bool();
                }) {
                    emit_tab(&app2, &t);
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, id, wv);
}

/// A page entered / left HTML5 fullscreen (a video): the window follows, like in a normal browser.
fn set_page_fullscreen(app: &AppHandle, tab: &str, on: bool) {
    *browser().fullscreen.lock().unwrap() = on.then(|| tab.to_string());
    let Some(win) = app.get_window("main") else { return };
    let _ = win.set_fullscreen(on);
    let _ = app.emit("browser://fullscreen", serde_json::json!({ "tab": tab, "on": on }));
    let app2 = app.clone();
    // the window needs a moment to reach its new size
    std::thread::spawn(move || {
        for ms in [120u64, 400, 900] {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            apply_bounds(&app2);
        }
    });
}

/// Closes the pages of a profile and brings the shown tab back: the engine reads the extensions
/// folder when it starts a profile, so this makes a newly added / switched-off extension take effect.
pub fn reload_profile(app: &AppHandle, profile: &str) {
    let mine: Vec<TabState> = tabs().into_iter().filter(|t| t.profile == profile && t.live).collect();
    for t in &mine {
        if let Some(w) = app.get_webview(&t.id) {
            let _ = w.close();
        }
        if let Some(u) = with_tab(&t.id, |x| x.live = false) {
            emit_tab(app, &u);
        }
    }
    let active = browser().active.lock().unwrap().clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        // the browser process of the profile needs a moment to shut down before it can start again
        std::thread::sleep(std::time::Duration::from_millis(2500));
        if let Some(id) = active {
            activate(&app2, &id);
        }
    });
}

/// Called when the app quits: close every page so the engine flushes its data to disk.
pub fn shutdown(app: &AppHandle) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        for t in tabs() {
            if let Some(w) = app.get_webview(&t.id) {
                let _ = w.close();
            }
        }
        store::flush_all();
        // give the browser processes a moment to write cookies / local storage
        std::thread::sleep(std::time::Duration::from_millis(1500));
    });
}

/// The cookies the tab's profile would send to `url`, as a `Cookie:` header value. Media behind a
/// login (private videos, signed CDN links) can only be fetched by the downloader with them.
/// Blocks for a moment: never call this from the engine's own callback thread.
pub fn cookie_header(app: &AppHandle, tab: &str, url: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use std::time::Duration;
        let wv = app.get_webview(tab)?;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let url = url.to_string();
        wv.with_webview(move |pw| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
            use webview2_com::{take_pwstr, GetCookiesCompletedHandler};
            use windows::core::{Interface, HSTRING, PWSTR};
            let fail = |tx: &std::sync::mpsc::Sender<String>| {
                let _ = tx.send(String::new());
            };
            let Ok(core) = pw.controller().CoreWebView2() else { return fail(&tx) };
            let Ok(core2) = core.cast::<ICoreWebView2_2>() else { return fail(&tx) };
            let Ok(manager) = core2.CookieManager() else { return fail(&tx) };
            let tx2 = tx.clone();
            let handler = GetCookiesCompletedHandler::create(Box::new(move |_, list| {
                let mut pairs: Vec<String> = Vec::new();
                if let Some(list) = list {
                    let mut n = 0u32;
                    let _ = list.Count(&mut n);
                    for i in 0..n {
                        if let Ok(c) = list.GetValueAtIndex(i) {
                            let (mut name, mut value) = (PWSTR::null(), PWSTR::null());
                            if c.Name(&mut name).is_ok() && c.Value(&mut value).is_ok() {
                                pairs.push(format!("{}={}", take_pwstr(name), take_pwstr(value)));
                            }
                        }
                    }
                }
                let _ = tx2.send(pairs.join("; "));
                Ok(())
            }));
            if manager.GetCookies(&HSTRING::from(url.as_str()), &handler).is_err() {
                fail(&tx);
            }
        })
        .ok()?;
        return rx.recv_timeout(Duration::from_secs(3)).ok().filter(|s| !s.is_empty());
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tab, url);
        None
    }
}

/// Removes leftovers of private tabs from a previous run.
pub fn startup_cleanup() {
    if let Ok(rd) = std::fs::read_dir(crate::paths::private_dir()) {
        for e in rd.filter_map(Result::ok) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(windows)]
unsafe fn install_sniffer(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    app: AppHandle,
    tab: String,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use webview2_com::{take_pwstr, WebResourceResponseReceivedEventHandler};
    use windows::core::{Interface, BOOL, PWSTR};

    let core = controller.CoreWebView2()?;
    let core2: ICoreWebView2_2 = core.cast()?;
    let handler = WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let request = args.Request()?;
        let response = args.Response()?;

        let mut uri = PWSTR::null();
        request.Uri(&mut uri)?;
        let uri = take_pwstr(uri);
        if !uri.starts_with("http") {
            return Ok(());
        }
        let mut status = 0i32;
        response.StatusCode(&mut status)?;

        // Response headers we care about.
        let (mut mime, mut length, mut range_total, mut disposition) = (String::new(), None::<u64>, None::<u64>, None::<String>);
        if let Ok(headers) = response.Headers().and_then(|h| h.GetIterator()) {
            let mut has = BOOL::default();
            headers.HasCurrentHeader(&mut has)?;
            while has.as_bool() {
                let (mut k, mut v) = (PWSTR::null(), PWSTR::null());
                headers.GetCurrentHeader(&mut k, &mut v)?;
                let (k, v) = (take_pwstr(k).to_ascii_lowercase(), take_pwstr(v));
                match k.as_str() {
                    "content-type" => mime = v,
                    "content-length" => length = v.trim().parse().ok(),
                    "content-range" => range_total = v.rsplit('/').next().and_then(|t| t.trim().parse().ok()),
                    "content-disposition" => disposition = Some(v),
                    _ => {}
                }
                headers.MoveNext(&mut has)?;
            }
        }
        let Some((kind, size, hint)) = sniff::classify(&uri, &mime, length, range_total, disposition.as_deref(), status) else {
            return Ok(());
        };

        // Request headers (Referer, User-Agent, Cookie) so a download can replay them.
        let mut req_headers: Vec<(String, String)> = vec![];
        if let Ok(headers) = request.Headers().and_then(|h| h.GetIterator()) {
            let mut has = BOOL::default();
            headers.HasCurrentHeader(&mut has)?;
            while has.as_bool() {
                let (mut k, mut v) = (PWSTR::null(), PWSTR::null());
                headers.GetCurrentHeader(&mut k, &mut v)?;
                req_headers.push((take_pwstr(k), take_pwstr(v)));
                headers.MoveNext(&mut has)?;
            }
        }
        record_sniffed(&app, &tab, uri, kind, mime, size, hint, req_headers);
        Ok(())
    }));
    let mut token = 0i64;
    core2.add_WebResourceResponseReceived(&handler, &mut token)?;
    Ok(())
}

/// Injects the page agent into every frame of every page of the tab, and listens
/// for the plain messages it posts back. Also turns on the everyday browser
/// features of the engine (saved passwords, autofill) and follows zoom changes.
#[cfg(windows)]
unsafe fn install_agent(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    app: AppHandle,
    tab: String,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    use webview2_com::{take_pwstr, AddScriptToExecuteOnDocumentCreatedCompletedHandler, ContainsFullScreenElementChangedEventHandler, ExecuteScriptCompletedHandler, WebMessageReceivedEventHandler, ZoomFactorChangedEventHandler};
    use windows::core::{Interface, HSTRING, PWSTR};

    let core = controller.CoreWebView2()?;
    match core.Settings() {
        Ok(settings) => {
            let set = settings.SetIsWebMessageEnabled(true);
            let mut on = windows::core::BOOL::default();
            let got = settings.IsWebMessageEnabled(&mut on);
            debug_log(&format!("[agent {tab}] web messages: set={set:?} get={got:?} enabled={}", on.as_bool()));
            if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
                let _ = s4.SetIsPasswordAutosaveEnabled(true);
                let _ = s4.SetIsGeneralAutofillEnabled(true);
            }
        }
        Err(e) => debug_log(&format!("[agent {tab}] no settings: {e}")),
    }
    // One nonce per tab: frames of the same page use it to talk to each other.
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let script = HSTRING::from(media::agent_source().replace("__QG_NONCE__", &nonce));
    // The tab's first page may already be loading by the time the script is registered:
    // run it there too (the agent ignores a second start).
    let run_now = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
    let core_now = core.clone();
    let script_now = script.clone();
    let done = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |_, _| {
        let _ = core_now.ExecuteScript(&script_now, &run_now);
        Ok(())
    }));
    core.AddScriptToExecuteOnDocumentCreated(&script, &done)?;

    let (app_z, tab_z) = (app.clone(), tab.clone());
    let zoom_handler = ZoomFactorChangedEventHandler::create(Box::new(move |ctrl, _| {
        if let Some(c) = ctrl {
            let mut z = 1.0f64;
            if c.ZoomFactor(&mut z).is_ok() {
                if let Some(t) = with_tab(&tab_z, |t| t.zoom = z) {
                    emit_tab(&app_z, &t);
                }
            }
        }
        Ok(())
    }));
    let mut ztoken = 0i64;
    let _ = controller.add_ZoomFactorChanged(&zoom_handler, &mut ztoken);

    let (app_f, tab_f) = (app.clone(), tab.clone());
    let fs_handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(core) = sender {
            let mut on = windows::core::BOOL::default();
            if core.ContainsFullScreenElement(&mut on).is_ok() {
                set_page_fullscreen(&app_f, &tab_f, on.as_bool());
            }
        }
        Ok(())
    }));
    let mut ftoken = 0i64;
    let _ = core.add_ContainsFullScreenElementChanged(&fs_handler, &mut ftoken);

    let tab_log = tab.clone();
    let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut json = PWSTR::null();
        match args.TryGetWebMessageAsString(&mut json) {
            Ok(()) => {
                let text = take_pwstr(json);
                if std::env::var_os("QG_DEBUG_AGENT").is_some() {
                    debug_log(&format!("[agent {tab}] {}", text.chars().take(160).collect::<String>()));
                }
                media::on_message(&app, &tab, &text);
            }
            Err(e) => {
                if std::env::var_os("QG_DEBUG_AGENT").is_some() {
                    debug_log(&format!("[agent {tab}] unreadable message: {e}"));
                }
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    let r = core.add_WebMessageReceived(&handler, &mut token);
    debug_log(&format!("[agent {tab_log}] message handler registered: {r:?}"));
    r?;
    Ok(())
}

/// Diagnostics for the page agent, written into the data folder when QG_DEBUG_AGENT is set.
fn debug_log(line: &str) {
    if std::env::var_os("QG_DEBUG_AGENT").is_none() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(crate::paths::tmp_dir().join("qg-agent.log")) {
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_bar_input_becomes_a_url_or_a_search() {
        assert_eq!(target_url("https://example.com/a?b=1").unwrap().as_str(), "https://example.com/a?b=1");
        assert_eq!(target_url("example.com/path").unwrap().as_str(), "https://example.com/path");
        assert_eq!(target_url("localhost:3000").unwrap().host_str(), Some("localhost"));
        let s = target_url("cute cats video").unwrap();
        assert!(s.query().unwrap().contains("cute+cats+video") || s.query().unwrap().contains("cute%20cats"));
        // javascript: and friends never become a navigation
        assert!(target_url("javascript:alert(1)").unwrap().scheme() == "https");
        assert_ne!(target_url("javascript:alert(1)").unwrap().host_str(), Some("alert(1)"));
        // what is typed is encoded, not injected
        let q = target_url("a&b=c#d").unwrap();
        assert_eq!(q.query_pairs().next().unwrap().1, "a&b=c#d");
    }
}
