//! Screen lock. The UI is locked on launch and every time the window is hidden to the tray; the
//! backend checks the password, so nothing secret sits in the JS bundle — or in the code: the
//! owner picks the password (on first launch, and in Settings later) and only a salted
//! PBKDF2-SHA256 hash of it is kept, in `data/lock.json`. This is a privacy screen for someone
//! walking up to the machine, not encryption of the library (the files are ordinary files on disk,
//! and deleting `lock.json` resets the lock to "choose a password").

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const ITERATIONS: u32 = 100_000;
const MIN_LEN: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Stored {
    /// hex
    salt: String,
    /// hex, 32 bytes
    hash: String,
    iterations: u32,
}

fn lock_file() -> PathBuf {
    crate::paths::data_dir().join("lock.json")
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> Option<Vec<u8>> {
    (s.len() % 2 == 0).then_some(())?;
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn derive(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password, salt, iterations, &mut out);
    out
}

fn load(file: &Path) -> Option<Stored> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// Compares without bailing out at the first differing byte.
fn same(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() != b.len()) as u8;
    for (i, x) in a.iter().enumerate() {
        diff |= b.get(i).copied().unwrap_or(0) ^ x;
    }
    diff == 0
}

fn matches(file: &Path, candidate: &str) -> bool {
    let Some(s) = load(file) else { return false };
    let (Some(salt), Some(hash)) = (unhex(&s.salt), unhex(&s.hash)) else { return false };
    same(&derive(candidate.as_bytes(), &salt, s.iterations.max(1)), &hash)
}

fn save(file: &Path, password: &str) -> Result<(), String> {
    let salt: [u8; 16] = *uuid::Uuid::new_v4().as_bytes();
    let stored = Stored { salt: hex(&salt), hash: hex(&derive(password.as_bytes(), &salt, ITERATIONS)), iterations: ITERATIONS };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

/// Sets the password: the first one freely, after that only with the current one.
fn set(file: &Path, current: Option<&str>, new: &str) -> Result<(), String> {
    if new.chars().count() < MIN_LEN {
        return Err(format!("Use at least {MIN_LEN} characters"));
    }
    if load(file).is_some() && !matches(file, current.unwrap_or("")) {
        return Err("The current password is wrong".into());
    }
    save(file, new)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    /// false on a fresh install: the lock screen asks for a new password
    pub has_password: bool,
}

#[tauri::command(async)]
pub fn lock_status() -> LockStatus {
    LockStatus { has_password: load(&lock_file()).is_some() }
}

#[tauri::command(async)]
pub fn verify_password(password: String) -> bool {
    matches(&lock_file(), &password)
}

#[tauri::command(async)]
pub fn set_password(current: Option<String>, new: String) -> Result<(), String> {
    set(&lock_file(), current.as_deref(), &new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qg-lock-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("lock.json")
    }

    #[test]
    fn first_password_then_only_with_the_current_one() {
        let f = file("set");
        assert!(!matches(&f, "anything"), "no password yet: nothing unlocks");
        assert!(set(&f, None, "abc").is_err(), "too short");
        set(&f, None, "first-pass").unwrap();
        assert!(matches(&f, "first-pass"));
        assert!(!matches(&f, "first-pas"));
        assert!(!matches(&f, "first-pass "));
        assert!(!matches(&f, ""));
        assert!(set(&f, Some("nope"), "second-pass").is_err());
        assert!(set(&f, None, "second-pass").is_err());
        set(&f, Some("first-pass"), "second-pass").unwrap();
        assert!(!matches(&f, "first-pass"));
        assert!(matches(&f, "second-pass"));
    }

    #[test]
    fn only_a_salted_hash_is_stored() {
        let f = file("hash");
        set(&f, None, "my-secret-word").unwrap();
        let text = std::fs::read_to_string(&f).unwrap();
        assert!(!text.contains("my-secret-word"));
        let s = load(&f).unwrap();
        assert_eq!(s.iterations, ITERATIONS);
        assert_eq!(unhex(&s.hash).unwrap().len(), 32);
        // the same password saved twice gets a different salt and hash
        let first = s.hash.clone();
        set(&f, Some("my-secret-word"), "my-secret-word").unwrap();
        assert_ne!(load(&f).unwrap().hash, first);
    }

    #[test]
    fn matches_the_standard_pbkdf2_vector() {
        // RFC 7914 §11 (PBKDF2-HMAC-SHA256, "passwd" / "salt", 1 iteration), first 32 bytes
        assert_eq!(hex(&derive(b"passwd", b"salt", 1)), "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
    }
}
