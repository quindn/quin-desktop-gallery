//! Browser extensions. WebView2 loads every folder of `data/browser/extensions/` as an
//! unpacked Chromium extension into each page it creates (content scripts, request
//! blocking, page tweaks). uBlock Origin ships inside the app and is copied there; more can
//! be added from the Chrome Web Store (its link or id), from an unpacked folder, and be
//! switched off (the folder moves to `extensions-disabled/`) or removed.
//!
//! What the engine does not provide is a toolbar: an extension's own popup button is not
//! shown, so extensions that work in the background or inside pages are the ones that fit.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

pub const BUILTIN: &str = "uBlock0.chromium";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtInfo {
    /// The folder name (also the handle for toggling / removing).
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub builtin: bool,
    /// "builtin" | "store" | "folder"
    pub source: String,
    /// PNG as a data URL.
    pub icon: Option<String>,
    /// "manifest v2" / "manifest v3"
    pub manifest: u8,
}

pub fn root() -> PathBuf {
    let r = crate::paths::browser_dir().join("extensions");
    let _ = std::fs::create_dir_all(&r);
    ensure_builtin(&r);
    r
}

fn disabled_root() -> PathBuf {
    let r = crate::paths::browser_dir().join("extensions-disabled");
    let _ = std::fs::create_dir_all(&r);
    r
}

/// uBlock Origin is unpacked from the exe next to the other tools; keep a copy in the extensions folder.
fn ensure_builtin(root: &Path) {
    let dst = root.join(BUILTIN);
    let off = disabled_root().join(BUILTIN);
    let src = crate::tools::extensions_dir().join(BUILTIN);
    if !src.exists() || off.exists() {
        return;
    }
    let stamp = src.parent().and_then(|p| p.parent()).and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let stamp_file = dst.join(".qg-build");
    let current = std::fs::read_to_string(&stamp_file).unwrap_or_default();
    if dst.join("manifest.json").exists() && current.trim() == stamp {
        return;
    }
    let _ = std::fs::remove_dir_all(&dst);
    if crate::paths::copy_dir(&src, &dst).is_ok() {
        let _ = std::fs::write(stamp_file, stamp);
    }
}

fn slug(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' }).collect();
    let t = t.trim_matches(|c| c == '-' || c == '.').to_string();
    if t.is_empty() {
        "extension".into()
    } else {
        t.chars().take(60).collect()
    }
}

fn message(dir: &Path, key: &str, default_locale: &str) -> Option<String> {
    for loc in [default_locale, "en", "en_US"] {
        if loc.is_empty() {
            continue;
        }
        let text = std::fs::read_to_string(dir.join("_locales").join(loc).join("messages.json")).ok()?;
        let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
        if let Some(obj) = v.as_object() {
            if let Some((_, m)) = obj.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)) {
                if let Some(s) = m["message"].as_str() {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

fn localized(dir: &Path, v: &Value, field: &str) -> String {
    let raw = v[field].as_str().unwrap_or("").to_string();
    if let Some(key) = raw.strip_prefix("__MSG_").and_then(|r| r.strip_suffix("__")) {
        return message(dir, key, v["default_locale"].as_str().unwrap_or("")).unwrap_or_default();
    }
    raw
}

fn icon_of(dir: &Path, v: &Value) -> Option<String> {
    use base64::Engine;
    let mut candidates: Vec<(u32, String)> = Vec::new();
    let mut collect = |m: &Value| {
        if let Some(o) = m.as_object() {
            for (k, p) in o {
                if let (Ok(n), Some(p)) = (k.parse::<u32>(), p.as_str()) {
                    candidates.push((n, p.to_string()));
                }
            }
        } else if let Some(p) = m.as_str() {
            candidates.push((16, p.to_string()));
        }
    };
    collect(&v["icons"]);
    collect(&v["action"]["default_icon"]);
    collect(&v["browser_action"]["default_icon"]);
    candidates.sort_by_key(|(n, _)| if *n >= 32 { *n } else { 1000 + *n }); // the smallest one that is still sharp
    for (_, p) in candidates {
        let rel = p.trim_start_matches('/');
        if rel.contains("..") || !rel.to_ascii_lowercase().ends_with(".png") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(dir.join(rel)) {
            if bytes.len() < 300_000 {
                return Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
            }
        }
    }
    None
}

fn read_manifest(dir: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn info_of(dir: &Path, enabled: bool) -> Option<ExtInfo> {
    let v = read_manifest(dir)?;
    let id = dir.file_name()?.to_string_lossy().to_string();
    let name = localized(dir, &v, "name");
    Some(ExtInfo {
        builtin: id == BUILTIN,
        source: if id == BUILTIN {
            "builtin".into()
        } else if id.len() == 32 && id.chars().all(|c| ('a'..='p').contains(&c)) {
            "store".into()
        } else {
            "folder".into()
        },
        name: if name.is_empty() { id.clone() } else { name },
        version: v["version"].as_str().unwrap_or("").to_string(),
        description: localized(dir, &v, "description").chars().take(240).collect(),
        enabled,
        icon: icon_of(dir, &v),
        manifest: v["manifest_version"].as_u64().unwrap_or(2) as u8,
        id,
    })
}

pub fn list() -> Vec<ExtInfo> {
    let mut out = Vec::new();
    for (dir, enabled) in [(root(), true), (disabled_root(), false)] {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.filter_map(Result::ok) {
                if e.path().is_dir() {
                    if let Some(i) = info_of(&e.path(), enabled) {
                        out.push(i);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.builtin.cmp(&a.builtin).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

fn find(id: &str) -> Option<(PathBuf, bool)> {
    if id != slug(id) {
        return None;
    }
    let a = root().join(id);
    if a.is_dir() {
        return Some((a, true));
    }
    let b = disabled_root().join(id);
    b.is_dir().then_some((b, false))
}

pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    let (dir, now) = find(id).ok_or("no such extension")?;
    if now == enabled {
        return Ok(());
    }
    let target = if enabled { root().join(id) } else { disabled_root().join(id) };
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&dir, &target).or_else(|_| crate::paths::copy_dir(&dir, &target).map(|_| { let _ = std::fs::remove_dir_all(&dir); })).map_err(|e| format!("could not move the extension: {e}"))
}

pub fn remove(id: &str) -> Result<(), String> {
    if id == BUILTIN {
        return Err("uBlock Origin is part of the app: switch it off instead".into());
    }
    let (dir, _) = find(id).ok_or("no such extension")?;
    crate::browser::profiles::wipe_dir(dir);
    Ok(())
}

/* ------------------------------------------------------------------------ install --- */

/// The Chrome Web Store id in a link or bare id (32 letters a–p).
pub fn parse_store_id(input: &str) -> Option<String> {
    input.split(|c: char| !c.is_ascii_alphanumeric()).find(|t| t.len() == 32 && t.chars().all(|c| ('a'..='p').contains(&c))).map(str::to_string)
}

/// Where the zip starts inside a .crx (v2 or v3); a plain zip starts at 0.
pub fn crx_zip_offset(b: &[u8]) -> Option<usize> {
    if b.starts_with(b"PK") {
        return Some(0);
    }
    if b.len() < 16 || &b[..4] != b"Cr24" {
        return None;
    }
    let u = |at: usize| u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as usize;
    let start = match u(4) {
        3 => 12usize.checked_add(u(8))?,
        2 => 16usize.checked_add(u(8))?.checked_add(u(12))?,
        _ => return None,
    };
    (start < b.len()).then_some(start)
}

fn unzip_into(bytes: &[u8], dst: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid extension package: {e}"))?;
    if zip.len() > 8000 {
        return Err("the package has too many files".into());
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else { continue }; // refuses ../ paths
        let out = dst.join(rel);
        if f.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        total += f.size();
        if total > 300 * 1024 * 1024 {
            return Err("the package is too big".into());
        }
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out, buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Downloads an extension from the Chrome Web Store by link or id and unpacks it.
pub async fn install_from_store(input: &str) -> Result<ExtInfo, String> {
    let id = parse_store_id(input).ok_or("That is not a Chrome Web Store link or extension id")?;
    let url = format!(
        "https://clients2.google.com/service/update2/crx?response=redirect&os=win&arch=x64&os_arch=x86_64&nacl_arch=x86-64&prod=chromecrx&prodchannel=&prodversion=140.0.0.0&acceptformat=crx2,crx3&x=id%3D{id}%26installsource%3Dondemand%26uc"
    );
    let resp = crate::online::http().get(&url).timeout(std::time::Duration::from_secs(60)).send().await.map_err(|e| format!("could not reach the Chrome Web Store: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the Chrome Web Store has no download for that extension (HTTP {})", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let off = crx_zip_offset(&bytes).ok_or("the download is not an extension package")?;
    let tmp = crate::paths::tmp_dir().join(format!("ext-{id}"));
    let _ = std::fs::remove_dir_all(&tmp);
    unzip_into(&bytes[off..], &tmp)?;
    finish_install(&tmp, &id)
}

fn manifest_dir(dir: &Path) -> Option<PathBuf> {
    if dir.join("manifest.json").exists() {
        return Some(dir.to_path_buf());
    }
    std::fs::read_dir(dir).ok()?.filter_map(Result::ok).map(|e| e.path()).find(|p| p.join("manifest.json").exists())
}

/// Adds an unpacked extension folder (or a folder that contains one).
pub fn install_from_folder(path: &Path) -> Result<ExtInfo, String> {
    let dir = manifest_dir(path).ok_or("That folder has no manifest.json (pick the unpacked extension folder)")?;
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "extension".into());
    let tmp = crate::paths::tmp_dir().join(format!("ext-{}", slug(&name)));
    let _ = std::fs::remove_dir_all(&tmp);
    crate::paths::copy_dir(&dir, &tmp).map_err(|e| e.to_string())?;
    finish_install(&tmp, &slug(&name))
}

fn finish_install(tmp: &Path, wanted: &str) -> Result<ExtInfo, String> {
    let src = manifest_dir(tmp).ok_or("The package has no manifest.json")?;
    read_manifest(&src).ok_or("The extension's manifest.json is not valid")?;
    let mut id = slug(wanted);
    if id == BUILTIN {
        id = format!("{id}-2");
    }
    let target = root().join(&id);
    let _ = std::fs::remove_dir_all(&target);
    let _ = std::fs::remove_dir_all(disabled_root().join(&id));
    std::fs::rename(&src, &target).or_else(|_| crate::paths::copy_dir(&src, &target)).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(tmp);
    info_of(&target, true).ok_or_else(|| "installed, but the manifest could not be read".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_ids_are_found_in_links_and_bare() {
        let id = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
        assert_eq!(parse_store_id(id).as_deref(), Some(id));
        assert_eq!(parse_store_id(&format!("https://chromewebstore.google.com/detail/dark-reader/{id}?hl=en")).as_deref(), Some(id));
        assert_eq!(parse_store_id(&format!("https://chrome.google.com/webstore/detail/{id}")).as_deref(), Some(id));
        assert!(parse_store_id("https://example.com/not-an-extension").is_none());
        assert!(parse_store_id("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_none(), "ids only use the letters a to p");
    }

    #[test]
    fn crx_headers_are_skipped() {
        let mut v3 = b"Cr24".to_vec();
        v3.extend(3u32.to_le_bytes());
        v3.extend(5u32.to_le_bytes());
        v3.extend([0u8; 5]);
        v3.extend(b"PK\x03\x04rest");
        assert_eq!(crx_zip_offset(&v3), Some(17));
        let mut v2 = b"Cr24".to_vec();
        v2.extend(2u32.to_le_bytes());
        v2.extend(2u32.to_le_bytes());
        v2.extend(3u32.to_le_bytes());
        v2.extend([0u8; 5]);
        v2.extend(b"PK\x03\x04");
        assert_eq!(crx_zip_offset(&v2), Some(21));
        assert_eq!(crx_zip_offset(b"PK\x03\x04abc"), Some(0));
        assert_eq!(crx_zip_offset(b"garbage-garbage-garbage"), None);
    }

    #[test]
    fn packages_cannot_write_outside_their_folder() {
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut z = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opt = zip::write::SimpleFileOptions::default();
            z.start_file("manifest.json", opt).unwrap();
            z.write_all(br#"{"name":"x","version":"1","manifest_version":3}"#).unwrap();
            z.start_file("../../evil.txt", opt).unwrap();
            z.write_all(b"no").unwrap();
            z.finish().unwrap();
        }
        let dst = std::env::temp_dir().join(format!("qg-ext-zip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dst);
        unzip_into(&buf, &dst).unwrap();
        assert!(dst.join("manifest.json").exists());
        assert!(!dst.parent().unwrap().join("evil.txt").exists() && !dst.parent().unwrap().parent().unwrap().join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[test]
    fn names_come_from_locales_and_slugs_are_safe() {
        let dir = std::env::temp_dir().join(format!("qg-ext-loc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("_locales/en")).unwrap();
        std::fs::write(dir.join("_locales/en/messages.json"), r#"{"appName":{"message":"Dark Thing"}}"#).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{"name":"__MSG_appName__","version":"2.1","manifest_version":3,"default_locale":"en","description":"d"}"#).unwrap();
        let i = info_of(&dir, true).unwrap();
        assert_eq!((i.name.as_str(), i.version.as_str(), i.manifest), ("Dark Thing", "2.1", 3));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(slug("../My Ext/../x"), "My-Ext-..-x");
        assert_eq!(slug("///"), "extension");
    }
}
