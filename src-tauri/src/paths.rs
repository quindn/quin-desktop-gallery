//! Where everything the app writes lives.
//!
//! One rule, no exceptions: **all data sits in a `data/` folder next to the exe**
//! — libraries' databases, thumbnails, the unpacked FFmpeg / yt-dlp / uBlock
//! tools, the main window's web data, every browser profile (cookies, logins,
//! history, bookmarks, cache), downloads, temp files. Copy the folder and the
//! whole app moves with it.
//!
//! Only when that folder cannot be written (installed somewhere read-only)
//! does it fall back to the per-user app-data folder. `QG_DATA_DIR` overrides
//! the location (tests, or a data folder on another drive).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write_test");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn choose() -> PathBuf {
    if let Some(custom) = std::env::var_os("QG_DATA_DIR").map(PathBuf::from).filter(|p| writable(p)) {
        return custom;
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("data"))).filter(|p| writable(p)) {
        return dir;
    }
    let fallback = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("QuinGallery").join("data");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// The data folder (created on first use).
pub fn data_dir() -> &'static Path {
    static D: OnceLock<PathBuf> = OnceLock::new();
    D.get_or_init(|| {
        let dir = choose();
        migrate_legacy(&dir);
        dir
    })
}

fn sub(name: &str) -> PathBuf {
    let p = data_dir().join(name);
    let _ = std::fs::create_dir_all(&p);
    p
}

/// FFmpeg / FFprobe / yt-dlp / uBlock Origin, unpacked from the exe.
pub fn tools_dir() -> PathBuf {
    sub("bin")
}
/// The main window's web data.
pub fn webview_dir() -> PathBuf {
    sub("webview")
}
pub fn browser_dir() -> PathBuf {
    sub("browser")
}
pub fn profiles_dir() -> PathBuf {
    let p = browser_dir().join("profiles");
    let _ = std::fs::create_dir_all(&p);
    p
}
/// Throw-away browser sessions (private windows); emptied at start-up.
pub fn private_dir() -> PathBuf {
    let p = browser_dir().join("private");
    let _ = std::fs::create_dir_all(&p);
    p
}
pub fn tmp_dir() -> PathBuf {
    sub("tmp")
}
pub fn cache_dir() -> PathBuf {
    sub("cache")
}
pub fn downloads_dir() -> PathBuf {
    sub("downloads")
}

/// One-time move of what older versions kept in `%LOCALAPPDATA%` into the data folder.
fn migrate_legacy(data: &Path) {
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else { return };
    // the built-in browser's old single profile becomes the "default" profile
    let old_profile = local.join("QuinGallery").join("browser-profile");
    let new_profile = data.join("browser").join("profiles").join("default");
    if old_profile.exists() && !new_profile.exists() {
        let _ = std::fs::create_dir_all(new_profile.parent().unwrap());
        if std::fs::rename(&old_profile, &new_profile).is_err() {
            let _ = copy_dir(&old_profile, &new_profile);
        }
    }
    // the main window's saved settings (theme, lock state...) live in its local storage
    let old_ls = local.join("com.quinpower.gallery").join("EBWebView").join("Default").join("Local Storage");
    let new_ls = data.join("webview").join("EBWebView").join("Default").join("Local Storage");
    if old_ls.exists() && !new_ls.exists() {
        let _ = std::fs::create_dir_all(new_ls.parent().unwrap());
        let _ = copy_dir(&old_ls, &new_ls);
    }
}

pub fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_writable_folder_is_recognised_and_a_missing_one_is_created() {
        let d = std::env::temp_dir().join(format!("qg-paths-{}", std::process::id())).join("a").join("b");
        assert!(writable(&d));
        assert!(d.exists());
        let _ = std::fs::remove_dir_all(d.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn copy_dir_copies_nested_files() {
        let root = std::env::temp_dir().join(format!("qg-copy-{}", std::process::id()));
        let src = root.join("src");
        std::fs::create_dir_all(src.join("x/y")).unwrap();
        std::fs::write(src.join("x/y/f.txt"), b"hi").unwrap();
        copy_dir(&src, &root.join("dst")).unwrap();
        assert_eq!(std::fs::read(root.join("dst/x/y/f.txt")).unwrap(), b"hi");
        let _ = std::fs::remove_dir_all(&root);
    }
}
