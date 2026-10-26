//! Enforces the single most important invariant in the app: nothing is
//! ever read, written, listed, or streamed from outside the configured
//! Gallery Root. Every other subsystem (scanner, commands, LAN server)
//! must route path resolution through this module rather than
//! reimplementing containment checks.

use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("path does not exist: {0}")]
    NotFound(PathBuf),
    #[error("path escapes the gallery root")]
    Escapes,
    #[error("io error resolving path: {0}")]
    Io(#[from] std::io::Error),
}

/// The canonicalized, sandboxed root. Constructing one requires the path
/// to exist and canonicalize successfully; every containment check is
/// then a cheap prefix comparison on canonical forms.
#[derive(Debug, Clone)]
pub struct GalleryRoot {
    canonical: PathBuf,
}

impl GalleryRoot {
    /// Canonicalizes `path` (resolving symlinks/junctions and Windows'
    /// `\\?\` quirks via `dunce`) and adopts it as the sandbox root.
    pub fn new(path: impl AsRef<Path>) -> Result<Self, SandboxError> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(SandboxError::NotFound(path.to_path_buf()));
        }
        let canonical = dunce::canonicalize(path)?;
        Ok(Self { canonical })
    }

    pub fn canonical_path(&self) -> &Path {
        &self.canonical
    }

    /// Resolves `candidate` (absolute, or relative to the root) to a
    /// canonical path and verifies it is contained within the root.
    /// This is the ONLY approved way to turn user/DB/LAN-supplied paths
    /// into filesystem access — canonicalization happens *before* the
    /// containment check, which is what defeats `..` traversal and
    /// symlink/junction escapes (a symlink inside the root that resolves
    /// outside it fails this check rather than being followed).
    pub fn resolve(&self, candidate: impl AsRef<Path>) -> Result<PathBuf, SandboxError> {
        let candidate = candidate.as_ref();
        let absolute = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.canonical.join(candidate)
        };

        if !absolute.exists() {
            return Err(SandboxError::NotFound(absolute));
        }

        let canonical_candidate = dunce::canonicalize(&absolute)?;

        if canonical_candidate == self.canonical
            || canonical_candidate.starts_with(&self.canonical)
        {
            Ok(canonical_candidate)
        } else {
            Err(SandboxError::Escapes)
        }
    }

    /// Like `resolve`, but for paths that may not exist yet (e.g. an
    /// export destination). Canonicalizes the deepest existing ancestor
    /// and rejoins the remainder, so containment is still checked against
    /// resolved symlinks rather than the raw string.
    pub fn resolve_for_write(&self, candidate: impl AsRef<Path>) -> Result<PathBuf, SandboxError> {
        let candidate = candidate.as_ref();
        let absolute = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.canonical.join(candidate)
        };

        let mut existing = absolute.clone();
        let mut remainder: Vec<std::ffi::OsString> = Vec::new();
        while !existing.exists() {
            match existing.file_name() {
                Some(name) => {
                    remainder.push(name.to_os_string());
                    existing = existing
                        .parent()
                        .ok_or(SandboxError::Escapes)?
                        .to_path_buf();
                }
                None => return Err(SandboxError::Escapes),
            }
        }

        let mut canonical_existing = dunce::canonicalize(&existing)?;
        if !(canonical_existing == self.canonical || canonical_existing.starts_with(&self.canonical))
        {
            return Err(SandboxError::Escapes);
        }

        for part in remainder.into_iter().rev() {
            canonical_existing.push(part);
        }
        Ok(canonical_existing)
    }

    /// Converts an already-validated absolute path into the root-relative,
    /// forward-slash form stored in the database (spec: DB rows store
    /// paths relative to the canonical root).
    pub fn relativize(&self, absolute: &Path) -> Option<String> {
        absolute
            .strip_prefix(&self.canonical)
            .ok()
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_traversal_outside_root() {
        let tmp = std::env::temp_dir().join(format!("qpg-sandbox-test-{}", uuid::Uuid::new_v4()));
        let root_dir = tmp.join("root");
        let outside_dir = tmp.join("outside");
        fs::create_dir_all(&root_dir).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("secret.txt"), b"nope").unwrap();

        let root = GalleryRoot::new(&root_dir).unwrap();
        let escape_attempt = root_dir.join("..").join("outside").join("secret.txt");
        let result = root.resolve(&escape_attempt);
        assert!(matches!(result, Err(SandboxError::Escapes)));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn allows_nested_paths() {
        let tmp = std::env::temp_dir().join(format!("qpg-sandbox-test-{}", uuid::Uuid::new_v4()));
        let root_dir = tmp.join("root");
        let nested = root_dir.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("file.txt"), b"ok").unwrap();

        let root = GalleryRoot::new(&root_dir).unwrap();
        let resolved = root.resolve(nested.join("file.txt")).unwrap();
        assert!(resolved.starts_with(root.canonical_path()));

        fs::remove_dir_all(&tmp).ok();
    }
}
