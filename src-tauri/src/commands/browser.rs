use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::browser::{
    self,
    media::{self, DomMedia, MediaConfig, MediaItem, PopupState},
    extensions::{self, ExtInfo},
    profiles::{self, Profile},
    sniff::Sniffed,
    store::{self, Bookmark, BrowserSettings, HistoryEntry, Suggestion},
    TabState,
};

/* ------------------------------------------------------------------------ profiles --- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    #[serde(flatten)]
    pub profile: Profile,
    pub tabs: usize,
    pub bookmarks: usize,
    pub size: u64,
}

#[tauri::command(async)]
pub fn browser_profiles() -> Vec<ProfileInfo> {
    let tabs = browser::tabs();
    profiles::list()
        .into_iter()
        .map(|p| ProfileInfo { tabs: tabs.iter().filter(|t| t.profile == p.id && !t.private).count(), bookmarks: store::bookmarks(&p.id).len(), size: profiles::size_of(&p.id), profile: p })
        .collect()
}

#[tauri::command(async)]
pub fn browser_profile_create(name: String, color: Option<String>) -> Profile {
    profiles::create(&name, color.as_deref().unwrap_or(""))
}

#[tauri::command(async)]
pub fn browser_profile_rename(id: String, name: String, color: Option<String>) -> Result<Profile, String> {
    profiles::rename(&id, &name, color.as_deref())
}

/// Deletes a profile: its tabs close, its folder (cookies, logins, history, bookmarks) is erased.
#[tauri::command(async)]
pub fn browser_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = profiles::dir(&id).ok_or("bad profile id")?;
    profiles::remove_entry(&id)?;
    browser::close_profile_tabs(&app, &id);
    store::drop_profile(&id);
    profiles::wipe_dir(dir);
    Ok(())
}

/// Clears cookies, cache and history of a profile (bookmarks stay).
#[tauri::command(async)]
pub fn browser_profile_clear(app: AppHandle, id: String) -> Result<(), String> {
    let dir = profiles::dir(&id).ok_or("bad profile id")?;
    store::clear_history(&id);
    let live = browser::tabs().into_iter().find(|t| t.profile == id && t.live);
    match live.and_then(|t| app.get_webview(&t.id)) {
        Some(w) => w.clear_all_browsing_data().map_err(|e| e.to_string()),
        None => {
            profiles::wipe_dir(dir.join("EBWebView"));
            Ok(())
        }
    }
}

/* ---------------------------------------------------------------------------- tabs --- */

/// Opens a tab (URL, bare domain or search words; empty = new-tab page) and shows it.
#[tauri::command]
pub async fn browser_open(app: AppHandle, profile: String, url: Option<String>, private: Option<bool>) -> Result<String, String> {
    let id = browser::open_tab(&app, &profile, url.as_deref().unwrap_or(""), private.unwrap_or(false))?;
    browser::activate(&app, &id);
    let _ = app.emit("browser://focus-tab", id.clone());
    Ok(id)
}

#[tauri::command(async)]
pub fn browser_tabs() -> Vec<TabState> {
    browser::tabs()
}

#[derive(Serialize)]
pub struct Restored {
    pub ids: Vec<String>,
    pub active: usize,
}

#[tauri::command(async)]
pub fn browser_restore_session(app: AppHandle, profile: String) -> Restored {
    let active = store::session(&profile).active;
    Restored { ids: browser::restore_session(&app, &profile), active }
}

#[tauri::command(async)]
pub fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    browser::navigate(&app, &id, &url)
}

/// "back" | "forward" | "reload" | "hard-reload" | "stop"
#[tauri::command(async)]
pub fn browser_action(app: AppHandle, id: String, action: String) -> Result<(), String> {
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "hard-reload" => "location.reload(true)",
        "stop" => "window.stop()",
        other => return Err(format!("unknown action {other}")),
    };
    browser::script(&app, &id, js)
}

#[tauri::command(async)]
pub fn browser_close(app: AppHandle, id: String) {
    browser::close_tab(&app, &id);
}

#[tauri::command(async)]
pub fn browser_activate(app: AppHandle, id: String) {
    browser::activate(&app, &id);
    let _ = app.emit("browser://focus-tab", id);
}

#[tauri::command(async)]
pub fn browser_hide_all(app: AppHandle) {
    browser::hide_all(&app);
}

#[tauri::command(async)]
pub fn browser_show_active(app: AppHandle) {
    browser::show_active(&app);
}

/// The browser view's content rectangle, in the window's logical pixels.
#[tauri::command(async)]
pub fn browser_set_bounds(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
    browser::set_bounds(&app, x, y, w, h);
}

#[tauri::command(async)]
pub fn browser_reorder(app: AppHandle, ids: Vec<String>) {
    browser::reorder(&app, &ids);
}

#[tauri::command(async)]
pub fn browser_pin(app: AppHandle, id: String, pinned: bool) {
    browser::set_pinned(&app, &id, pinned);
}

#[tauri::command(async)]
pub fn browser_duplicate(app: AppHandle, id: String) -> Result<String, String> {
    let t = browser::tab(&id).ok_or("that tab is gone")?;
    let new = browser::open_tab(&app, &t.profile, &t.url, t.private)?;
    browser::activate(&app, &new);
    Ok(new)
}

#[tauri::command(async)]
pub fn browser_reopen(app: AppHandle, profile: String) -> Result<String, String> {
    let id = browser::reopen_closed(&app, &profile)?;
    browser::activate(&app, &id);
    Ok(id)
}

/// "in" | "out" | "reset"
#[tauri::command(async)]
pub fn browser_zoom(app: AppHandle, id: String, op: String) -> Result<f64, String> {
    browser::zoom(&app, &id, &op)
}

#[tauri::command(async)]
pub fn browser_devtools(app: AppHandle, id: String) -> Result<(), String> {
    app.get_webview(&id).ok_or("that tab is not loaded")?.open_devtools();
    Ok(())
}

#[tauri::command(async)]
pub fn browser_print(app: AppHandle, id: String) -> Result<(), String> {
    app.get_webview(&id).ok_or("that tab is not loaded")?.print().map_err(|e| e.to_string())
}

/// Find on the page; the answer arrives as the `browser://find` event.
#[tauri::command(async)]
pub fn browser_find(app: AppHandle, id: String, text: String, forward: bool, case_sensitive: bool) -> Result<(), String> {
    let js = format!("window.__qg&&window.__qg.find({}, {forward}, {case_sensitive})", serde_json::Value::String(text.chars().take(200).collect()));
    browser::script(&app, &id, &js)
}

#[tauri::command(async)]
pub fn browser_find_clear(app: AppHandle, id: String) -> Result<(), String> {
    browser::script(&app, &id, "window.__qg&&window.__qg.findClear()")
}

/* ------------------------------------------------------------- bookmarks, history --- */

#[tauri::command(async)]
pub fn browser_bookmarks(profile: String) -> Vec<Bookmark> {
    store::bookmarks(&profile)
}

/// Adds or removes the page; returns whether it is bookmarked now.
#[tauri::command(async)]
pub fn browser_bookmark_toggle(profile: String, url: String, title: String) -> bool {
    store::toggle_bookmark(&profile, &url, &title)
}

#[tauri::command(async)]
pub fn browser_is_bookmarked(profile: String, url: String) -> bool {
    store::is_bookmarked(&profile, &url)
}

#[tauri::command(async)]
pub fn browser_bookmark_remove(profile: String, id: String) {
    store::remove_bookmark(&profile, &id);
}

#[tauri::command(async)]
pub fn browser_bookmark_rename(profile: String, id: String, title: String) {
    store::rename_bookmark(&profile, &id, &title);
}

#[tauri::command(async)]
pub fn browser_history(profile: String, query: Option<String>, limit: Option<usize>) -> Vec<HistoryEntry> {
    store::history(&profile, query.as_deref().unwrap_or(""), limit.unwrap_or(300))
}

#[tauri::command(async)]
pub fn browser_history_remove(profile: String, id: String) {
    store::remove_history(&profile, &id);
}

#[tauri::command(async)]
pub fn browser_history_clear(profile: String) {
    store::clear_history(&profile);
}

#[tauri::command(async)]
pub fn browser_suggest(profile: String, query: String) -> Vec<Suggestion> {
    store::suggest(&profile, &query, 8)
}

#[tauri::command(async)]
pub fn browser_settings() -> BrowserSettings {
    store::settings()
}

#[tauri::command(async)]
pub fn browser_settings_set(settings: BrowserSettings) -> BrowserSettings {
    store::set_settings(settings)
}

/* ------------------------------------------------------------------------- media --- */

#[tauri::command(async)]
pub fn browser_sniffed(id: String) -> Vec<Sniffed> {
    browser::sniffed(&id)
}

#[tauri::command(async)]
pub fn browser_clear_sniffed(app: AppHandle, id: String) {
    browser::clear_sniffed(&app, &id);
}

/// The merged list of media on a tab's page (page agent + network sniffer).
#[tauri::command(async)]
pub fn browser_media_items(id: String) -> Vec<MediaItem> {
    media::build_items(&id)
}

/// Gesture / shortcut / popup settings; applied to every open tab.
#[tauri::command(async)]
pub fn browser_media_config(app: AppHandle, cfg: MediaConfig) {
    media::set_config(&app, cfg);
}

/// "playPause" | "seekBy" | "seekTo" | "setRate" | "setVolume" | "toggleMute" | "toggleFullscreen" | "togglePip" | "goLive"
#[tauri::command(async)]
pub fn browser_media_cmd(app: AppHandle, id: String, op: String, value: Option<f64>) -> Result<(), String> {
    if !matches!(op.as_str(), "playPause" | "seekBy" | "seekTo" | "setRate" | "setVolume" | "toggleMute" | "toggleFullscreen" | "togglePip" | "goLive") {
        return Err(format!("unknown command {op}"));
    }
    media::command(&app, &id, &op, value.unwrap_or(0.0));
    Ok(())
}

/// "download" | "play" | "copy" (with an item id) or "downloadAll" (with a group).
#[tauri::command(async)]
pub fn browser_media_action(app: AppHandle, id: String, op: String, item: Option<String>, group: Option<String>) -> Result<(), String> {
    media::perform(&app, &id, &op, item.as_deref().unwrap_or(""), group.as_deref().unwrap_or("video"), None, None)
}

/// "open" | "close" | "toggle"
#[tauri::command(async)]
pub fn browser_popup(app: AppHandle, id: String, op: String) {
    media::popup_command(&app, &id, &op);
}

#[tauri::command(async)]
pub fn browser_popup_notice(app: AppHandle, id: String, text: String) {
    media::popup_notice(&app, &id, &text);
}

/// Tells the popup which download belongs to which row, so progress shows there.
#[tauri::command(async)]
pub fn browser_popup_task(id: String, item: String, task: String) {
    media::register_task(&id, &item, &task);
}

/// What the page agents last reported (for diagnostics and tests).
#[tauri::command(async)]
pub fn browser_media_debug(id: String) -> serde_json::Value {
    let state: PopupState = media::popup_state(&id);
    let dom: Vec<DomMedia> = media::dom_snapshot(&id);
    serde_json::json!({ "popup": state, "dom": dom, "active": media::active_dom_id(&id), "skins": media::skinned(&id) })
}

/// Quits the app (the same as the tray's Quit): pages are closed first so their data is saved.
#[tauri::command(async)]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/* ------------------------------------------------------------------ extensions --- */

#[tauri::command(async)]
pub fn browser_extensions() -> Vec<ExtInfo> {
    extensions::list()
}

#[tauri::command(async)]
pub fn browser_extension_toggle(id: String, enabled: bool) -> Result<(), String> {
    extensions::set_enabled(&id, enabled)
}

#[tauri::command(async)]
pub fn browser_extension_remove(id: String) -> Result<(), String> {
    extensions::remove(&id)
}

/// A Chrome Web Store link / id, or the path of an unpacked extension folder.
#[tauri::command]
pub async fn browser_extension_install(input: String) -> Result<ExtInfo, String> {
    let t = input.trim().trim_matches('"').to_string();
    if std::path::Path::new(&t).is_dir() {
        return extensions::install_from_folder(std::path::Path::new(&t));
    }
    extensions::install_from_store(&t).await
}

/// Asks for an unpacked extension folder and adds it (None when the dialog is cancelled).
#[tauri::command]
pub async fn browser_extension_install_folder(app: AppHandle) -> Result<Option<ExtInfo>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder()).await.map_err(|e| e.to_string())?;
    match picked {
        Some(p) => extensions::install_from_folder(std::path::Path::new(&p.to_string())).map(Some),
        None => Ok(None),
    }
}

/// Restarts the pages of a profile so extension changes apply.
#[tauri::command(async)]
pub fn browser_reload_engines(app: AppHandle, profile: String) {
    browser::reload_profile(&app, &profile);
}
