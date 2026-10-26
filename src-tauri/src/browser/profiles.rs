//! Browser profiles: each one is a separate WebView2 data folder (cookies,
//! logins, cache, history...) under `data/browser/profiles/<id>`, so sessions
//! never mix. Private sessions use a throw-away folder that is deleted again.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created: i64,
    pub last_used: i64,
}

const COLORS: &[&str] = &["#6673e0", "#a78bfa", "#34d399", "#f59e0b", "#f472b6", "#38bdf8", "#f87171", "#84cc16"];

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn lock() -> &'static Mutex<Option<Vec<Profile>>> {
    static P: Mutex<Option<Vec<Profile>>> = Mutex::new(None);
    &P
}

fn file() -> PathBuf {
    crate::paths::browser_dir().join("profiles.json")
}

/// Ids become folder names: keep them boring.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 24 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn dir(id: &str) -> Option<PathBuf> {
    valid_id(id).then(|| crate::paths::profiles_dir().join(id))
}

fn clean_name(name: &str) -> String {
    let n: String = name.chars().filter(|c| !c.is_control()).take(40).collect::<String>().trim().to_string();
    if n.is_empty() {
        "Profile".into()
    } else {
        n
    }
}

fn clean_color(c: &str) -> String {
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit());
    if ok {
        c.to_string()
    } else {
        COLORS[0].to_string()
    }
}

fn save(list: &[Profile]) {
    if let Ok(json) = serde_json::to_vec_pretty(list) {
        let tmp = file().with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, file());
        }
    }
}

fn with<R>(f: impl FnOnce(&mut Vec<Profile>) -> R) -> R {
    let mut guard = lock().lock().unwrap();
    if guard.is_none() {
        let mut list: Vec<Profile> = std::fs::read(file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        list.retain(|p| valid_id(&p.id));
        if list.is_empty() {
            // first run (or an older version's single browser profile, moved to "default")
            list.push(Profile { id: "default".into(), name: "Default".into(), color: COLORS[0].into(), created: now_ms(), last_used: now_ms() });
            save(&list);
        }
        *guard = Some(list);
    }
    f(guard.as_mut().unwrap())
}

pub fn list() -> Vec<Profile> {
    with(|l| l.clone())
}

pub fn get(id: &str) -> Option<Profile> {
    with(|l| l.iter().find(|p| p.id == id).cloned())
}

pub fn create(name: &str, color: &str) -> Profile {
    with(|l| {
        let id = format!("p{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let color = if color.is_empty() { COLORS[l.len() % COLORS.len()].to_string() } else { clean_color(color) };
        let p = Profile { id: id.clone(), name: clean_name(name), color, created: now_ms(), last_used: now_ms() };
        l.push(p.clone());
        save(l);
        if let Some(d) = dir(&id) {
            let _ = std::fs::create_dir_all(d);
        }
        p
    })
}

pub fn rename(id: &str, name: &str, color: Option<&str>) -> Result<Profile, String> {
    with(|l| {
        let p = l.iter_mut().find(|p| p.id == id).ok_or("no such profile")?;
        p.name = clean_name(name);
        if let Some(c) = color {
            p.color = clean_color(c);
        }
        let out = p.clone();
        save(l);
        Ok(out)
    })
}

pub fn touch(id: &str) {
    with(|l| {
        if let Some(p) = l.iter_mut().find(|p| p.id == id) {
            p.last_used = now_ms();
            save(l);
        }
    });
}

/// Removes the profile from the list; its folder is deleted by `wipe_dir` once the webviews let go.
pub fn remove_entry(id: &str) -> Result<(), String> {
    with(|l| {
        if l.len() <= 1 {
            return Err("Keep at least one profile".to_string());
        }
        if !l.iter().any(|p| p.id == id) {
            return Err("no such profile".to_string());
        }
        l.retain(|p| p.id != id);
        save(l);
        Ok(())
    })
}

/// Deletes a folder, retrying while WebView2's processes still hold files in it.
pub fn wipe_dir(path: PathBuf) {
    std::thread::spawn(move || {
        for _ in 0..25 {
            if !path.exists() || std::fs::remove_dir_all(&path).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    });
}

/// Size of a profile's data on disk (for the manager's cards).
pub fn size_of(id: &str) -> u64 {
    fn walk(p: &std::path::Path) -> u64 {
        let Ok(rd) = std::fs::read_dir(p) else { return 0 };
        rd.filter_map(Result::ok).map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => walk(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        }).sum()
    }
    dir(id).map(|d| walk(&d)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_become_safe_folder_names() {
        assert!(valid_id("default") && valid_id("p1a2b3c4d") && valid_id("a-b"));
        assert!(!valid_id("") && !valid_id("../x") && !valid_id("A") && !valid_id("a b") && !valid_id(&"x".repeat(30)));
        assert_eq!(dir("../x"), None);
    }

    #[test]
    fn names_and_colours_are_cleaned() {
        assert_eq!(clean_name("  Work \n"), "Work");
        assert_eq!(clean_name("   "), "Profile");
        assert_eq!(clean_name(&"x".repeat(100)).chars().count(), 40);
        assert_eq!(clean_color("#12abEF"), "#12abEF");
        assert_eq!(clean_color("red; background:url(x)"), COLORS[0]);
    }
}
