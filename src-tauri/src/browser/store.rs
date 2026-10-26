//! Per-profile browser data kept as small JSON files inside the profile's
//! folder: bookmarks, history and the open-tabs session; plus the browser-wide
//! settings. Writes are batched (a page load must never wait for the disk).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::profiles;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub title: String,
    pub url: String,
    pub created: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    pub time: i64,
    pub visits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub url: String,
    pub title: String,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub tabs: Vec<SessionTab>,
    pub active: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// "history" | "bookmark"
    pub kind: String,
    pub title: String,
    pub url: String,
}

#[derive(Default)]
struct PData {
    bookmarks: Vec<Bookmark>,
    history: Vec<HistoryEntry>,
    session: Session,
    dirty: (bool, bool, bool),
}

const MAX_HISTORY: usize = 6000;

fn cell() -> &'static Mutex<HashMap<String, PData>> {
    static C: OnceLock<Mutex<HashMap<String, PData>>> = OnceLock::new();
    C.get_or_init(|| {
        // the flusher runs for the life of the app
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_millis(1500));
            flush_all();
        });
        Default::default()
    })
}

fn path(profile: &str, name: &str) -> Option<PathBuf> {
    profiles::dir(profile).map(|d| d.join(name))
}

fn read<T: for<'a> Deserialize<'a> + Default>(profile: &str, name: &str) -> T {
    path(profile, name).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write<T: Serialize>(profile: &str, name: &str, value: &T) {
    let Some(p) = path(profile, name) else { return };
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    if let Ok(json) = serde_json::to_vec(value) {
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

fn with<R>(profile: &str, f: impl FnOnce(&mut PData) -> R) -> R {
    let mut map = cell().lock().unwrap();
    let d = map.entry(profile.to_string()).or_insert_with(|| PData {
        bookmarks: read(profile, "bookmarks.json"),
        history: read(profile, "history.json"),
        session: read(profile, "session.json"),
        dirty: (false, false, false),
    });
    f(d)
}

pub fn flush_all() {
    let mut map = cell().lock().unwrap();
    for (profile, d) in map.iter_mut() {
        if d.dirty.0 {
            write(profile, "bookmarks.json", &d.bookmarks);
        }
        if d.dirty.1 {
            write(profile, "history.json", &d.history);
        }
        if d.dirty.2 {
            write(profile, "session.json", &d.session);
        }
        d.dirty = (false, false, false);
    }
}

/// Forget the in-memory copy (the folder is about to be deleted).
pub fn drop_profile(profile: &str) {
    cell().lock().unwrap().remove(profile);
}

/* ------------------------------------------------------------------ bookmarks --- */

pub fn bookmarks(profile: &str) -> Vec<Bookmark> {
    with(profile, |d| d.bookmarks.clone())
}

pub fn is_bookmarked(profile: &str, url: &str) -> bool {
    with(profile, |d| d.bookmarks.iter().any(|b| b.url == url))
}

/// Adds the page, or removes it when it is already there. Returns whether it is bookmarked now.
pub fn toggle_bookmark(profile: &str, url: &str, title: &str) -> bool {
    with(profile, |d| {
        d.dirty.0 = true;
        if let Some(i) = d.bookmarks.iter().position(|b| b.url == url) {
            d.bookmarks.remove(i);
            false
        } else {
            let title = if title.trim().is_empty() { url.to_string() } else { title.chars().take(200).collect() };
            d.bookmarks.insert(0, Bookmark { id: uuid::Uuid::new_v4().simple().to_string(), title, url: url.to_string(), created: now_ms() });
            true
        }
    })
}

pub fn remove_bookmark(profile: &str, id: &str) {
    with(profile, |d| {
        d.bookmarks.retain(|b| b.id != id);
        d.dirty.0 = true;
    });
}

pub fn rename_bookmark(profile: &str, id: &str, title: &str) {
    with(profile, |d| {
        if let Some(b) = d.bookmarks.iter_mut().find(|b| b.id == id) {
            b.title = title.chars().take(200).collect();
            d.dirty.0 = true;
        }
    });
}

/* -------------------------------------------------------------------- history --- */

fn worth_remembering(url: &str) -> bool {
    url::Url::parse(url).map(|u| matches!(u.scheme(), "http" | "https")).unwrap_or(false)
}

pub fn add_history(profile: &str, url: &str, title: &str) {
    if !worth_remembering(url) {
        return;
    }
    with(profile, |d| {
        d.dirty.1 = true;
        let now = now_ms();
        if let Some(e) = d.history.iter_mut().find(|e| e.url == url) {
            e.time = now;
            e.visits += 1;
            if !title.is_empty() {
                e.title = title.chars().take(200).collect();
            }
            // most recent first
            let i = d.history.iter().position(|e| e.url == url).unwrap();
            let e = d.history.remove(i);
            d.history.insert(0, e);
        } else {
            d.history.insert(0, HistoryEntry { id: uuid::Uuid::new_v4().simple().to_string(), url: url.to_string(), title: title.chars().take(200).collect(), time: now, visits: 1 });
            d.history.truncate(MAX_HISTORY);
        }
    });
}

pub fn set_history_title(profile: &str, url: &str, title: &str) {
    if title.is_empty() {
        return;
    }
    with(profile, |d| {
        if let Some(e) = d.history.iter_mut().find(|e| e.url == url) {
            e.title = title.chars().take(200).collect();
            d.dirty.1 = true;
        }
    });
}

pub fn history(profile: &str, query: &str, limit: usize) -> Vec<HistoryEntry> {
    let q = query.trim().to_lowercase();
    with(profile, |d| {
        d.history
            .iter()
            .filter(|e| q.is_empty() || e.url.to_lowercase().contains(&q) || e.title.to_lowercase().contains(&q))
            .take(limit.clamp(1, 2000))
            .cloned()
            .collect()
    })
}

pub fn remove_history(profile: &str, id: &str) {
    with(profile, |d| {
        d.history.retain(|e| e.id != id);
        d.dirty.1 = true;
    });
}

pub fn clear_history(profile: &str) {
    with(profile, |d| {
        d.history.clear();
        d.dirty.1 = true;
    });
}

/// Address-bar suggestions: bookmarks first, then history by visit count / recency.
pub fn suggest(profile: &str, query: &str, limit: usize) -> Vec<Suggestion> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    with(profile, |d| {
        let mut out: Vec<Suggestion> = d
            .bookmarks
            .iter()
            .filter(|b| b.url.to_lowercase().contains(&q) || b.title.to_lowercase().contains(&q))
            .take(limit)
            .map(|b| Suggestion { kind: "bookmark".into(), title: b.title.clone(), url: b.url.clone() })
            .collect();
        let mut hist: Vec<&HistoryEntry> = d.history.iter().filter(|e| e.url.to_lowercase().contains(&q) || e.title.to_lowercase().contains(&q)).collect();
        hist.sort_by(|a, b| b.visits.cmp(&a.visits).then(b.time.cmp(&a.time)));
        for e in hist {
            if out.len() >= limit {
                break;
            }
            if !out.iter().any(|s| s.url == e.url) {
                out.push(Suggestion { kind: "history".into(), title: e.title.clone(), url: e.url.clone() });
            }
        }
        out
    })
}

/* -------------------------------------------------------------------- session --- */

pub fn save_session(profile: &str, session: Session) {
    with(profile, |d| {
        if d.session != session {
            d.session = session;
            d.dirty.2 = true;
        }
    });
}

pub fn session(profile: &str) -> Session {
    with(profile, |d| d.session.clone())
}

/* ------------------------------------------------------------------- settings --- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserSettings {
    /// "duckduckgo" | "google" | "bing" | "brave" | "ecosia"
    pub search: String,
    pub bookmarks_bar: bool,
    pub restore_tabs: bool,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self { search: "duckduckgo".into(), bookmarks_bar: true, restore_tabs: true }
    }
}

pub fn search_template(engine: &str) -> &'static str {
    match engine {
        "google" => "https://www.google.com/search?q=",
        "bing" => "https://www.bing.com/search?q=",
        "brave" => "https://search.brave.com/search?q=",
        "ecosia" => "https://www.ecosia.org/search?q=",
        _ => "https://duckduckgo.com/?q=",
    }
}

fn settings_cell() -> &'static Mutex<Option<BrowserSettings>> {
    static S: Mutex<Option<BrowserSettings>> = Mutex::new(None);
    &S
}

fn settings_file() -> PathBuf {
    crate::paths::browser_dir().join("settings.json")
}

pub fn settings() -> BrowserSettings {
    let mut g = settings_cell().lock().unwrap();
    if g.is_none() {
        *g = Some(std::fs::read(settings_file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    }
    g.clone().unwrap()
}

pub fn set_settings(mut s: BrowserSettings) -> BrowserSettings {
    if !matches!(s.search.as_str(), "duckduckgo" | "google" | "bing" | "brave" | "ecosia") {
        s.search = "duckduckgo".into();
    }
    if let Ok(json) = serde_json::to_vec_pretty(&s) {
        let _ = std::fs::write(settings_file(), json);
    }
    *settings_cell().lock().unwrap() = Some(s.clone());
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against a private profile folder.
    fn fresh(name: &str) -> String {
        let id = format!("t-{name}-{}", std::process::id() % 100000);
        let id: String = id.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(24).collect();
        if let Some(d) = profiles::dir(&id) {
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(d).unwrap();
        }
        id
    }

    fn cleanup(id: &str) {
        drop_profile(id);
        if let Some(d) = profiles::dir(id) {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn bookmarks_toggle_and_survive_a_restart() {
        let id = fresh("bm");
        assert!(toggle_bookmark(&id, "https://a.example/", "A"));
        assert!(is_bookmarked(&id, "https://a.example/"));
        assert!(toggle_bookmark(&id, "https://b.example/", ""));
        assert_eq!(bookmarks(&id)[0].title, "https://b.example/", "an untitled page is named by its address");
        assert!(!toggle_bookmark(&id, "https://a.example/", "A"), "toggling again removes it");
        flush_all();
        drop_profile(&id); // as if the app restarted
        let after = bookmarks(&id);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].url, "https://b.example/");
        cleanup(&id);
    }

    #[test]
    fn history_merges_visits_orders_by_recency_and_searches() {
        let id = fresh("hist");
        add_history(&id, "https://a.example/x", "Alpha page");
        add_history(&id, "https://b.example/", "Beta");
        add_history(&id, "https://a.example/x", "Alpha page");
        add_history(&id, "javascript:alert(1)", "bad");
        add_history(&id, "about:blank", "blank");
        let all = history(&id, "", 50);
        assert_eq!(all.len(), 2, "only web pages are remembered");
        assert_eq!((all[0].url.as_str(), all[0].visits), ("https://a.example/x", 2));
        assert_eq!(history(&id, "beta", 50).len(), 1);
        set_history_title(&id, "https://b.example/", "Beta renamed");
        assert_eq!(history(&id, "renamed", 50)[0].url, "https://b.example/");
        remove_history(&id, &all[0].id);
        assert_eq!(history(&id, "", 50).len(), 1);
        clear_history(&id);
        assert!(history(&id, "", 50).is_empty());
        cleanup(&id);
    }

    #[test]
    fn suggestions_put_bookmarks_first_and_rank_history_by_visits() {
        let id = fresh("sug");
        toggle_bookmark(&id, "https://news.example/", "Daily news");
        add_history(&id, "https://news.example/", "Daily news");
        add_history(&id, "https://newsroom.example/a", "Newsroom A");
        add_history(&id, "https://newsroom.example/b", "Newsroom B");
        add_history(&id, "https://newsroom.example/b", "Newsroom B");
        let s = suggest(&id, "news", 8);
        assert_eq!(s[0].kind, "bookmark");
        assert_eq!(s.len(), 3, "the bookmarked page is not repeated from history");
        assert_eq!(s[1].url, "https://newsroom.example/b", "more visits first");
        assert!(suggest(&id, "   ", 8).is_empty());
        cleanup(&id);
    }

    #[test]
    fn sessions_round_trip() {
        let id = fresh("ses");
        let s = Session { tabs: vec![SessionTab { url: "https://a.example/".into(), title: "A".into(), pinned: true }], active: 0 };
        save_session(&id, s.clone());
        flush_all();
        drop_profile(&id);
        assert_eq!(session(&id), s);
        cleanup(&id);
    }

    #[test]
    fn search_engines_map_to_query_urls_and_unknown_ones_fall_back() {
        assert!(search_template("google").contains("google.com"));
        assert!(search_template("nope").contains("duckduckgo"));
        assert_eq!(set_settings(BrowserSettings { search: "evil".into(), ..Default::default() }).search, "duckduckgo");
    }
}
