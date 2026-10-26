//! Duplicate finder (spec §18) — "optional", and scoped down from the
//! full spec here: exact content-hash duplicates and same-file-size
//! candidates are implemented; perceptual image similarity and
//! approximate video similarity are not (they need real feature
//! extraction/comparison, a materially bigger undertaking than hashing).
//! Never deletes anything itself — only ever reports groups for the user
//! to review and act on.

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::Pool;
use crate::fs_sandbox::GalleryRoot;

#[derive(Debug, Clone, Serialize)]
pub struct DuplicateMember {
    pub id: i64,
    pub rel_path: String,
    pub filename: String,
    pub file_size: i64,
    pub modified_time: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DuplicateGroup {
    pub method: String, // "exact_hash" | "same_size"
    pub members: Vec<DuplicateMember>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DuplicateProgress {
    pub hashed: u64,
    pub total: u64,
    pub done: bool,
}

fn hash_file(path: &std::path::Path) -> anyhow::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize().to_hex().to_string())
}

/// Computes (and caches in `media.fingerprint`) content hashes for every
/// media row missing one, then reports both exact-hash duplicate groups
/// and same-size candidate groups. Runs on the calling thread — callers
/// dispatch this to a background thread, same convention as the scanner.
pub fn run_duplicate_scan(app: &AppHandle, root: &GalleryRoot, pool: &Pool) -> anyhow::Result<Vec<DuplicateGroup>> {
    let candidates: Vec<(i64, String)> = {
        let conn = pool.get()?;
        let mut stmt = conn.prepare(
            "SELECT id, rel_path FROM media
             WHERE is_deleted = 0 AND fingerprint IS NULL
               AND media_type IN ('photo', 'video', 'animated')",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.filter_map(Result::ok).collect()
    };

    let total = candidates.len() as u64;
    for (i, (id, rel_path)) in candidates.iter().enumerate() {
        if let Ok(abs_path) = root.resolve(rel_path) {
            if let Ok(hash) = hash_file(&abs_path) {
                let conn = pool.get()?;
                conn.execute(
                    "UPDATE media SET fingerprint = ?1 WHERE id = ?2",
                    params![hash, id],
                )?;
            }
        }
        if (i as u64).is_multiple_of(50) || i as u64 + 1 == total {
            let _ = app.emit(
                "duplicates://progress",
                DuplicateProgress {
                    hashed: i as u64 + 1,
                    total,
                    done: false,
                },
            );
        }
    }
    let _ = app.emit(
        "duplicates://progress",
        DuplicateProgress {
            hashed: total,
            total,
            done: true,
        },
    );

    let conn = pool.get()?;
    let mut groups = Vec::new();

    // Exact-hash duplicates: highest confidence.
    {
        let mut stmt = conn.prepare(
            "SELECT fingerprint FROM media
             WHERE is_deleted = 0 AND fingerprint IS NOT NULL
             GROUP BY fingerprint HAVING COUNT(*) > 1",
        )?;
        let fingerprints: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        for fp in fingerprints {
            let mut mstmt = conn.prepare(
                "SELECT id, rel_path, filename, file_size, modified_time FROM media
                 WHERE is_deleted = 0 AND fingerprint = ?1 ORDER BY modified_time ASC",
            )?;
            let members: Vec<DuplicateMember> = mstmt
                .query_map(params![fp], |r| {
                    Ok(DuplicateMember {
                        id: r.get(0)?,
                        rel_path: r.get(1)?,
                        filename: r.get(2)?,
                        file_size: r.get(3)?,
                        modified_time: r.get(4)?,
                    })
                })?
                .filter_map(Result::ok)
                .collect();
            if members.len() > 1 {
                groups.push(DuplicateGroup {
                    method: "exact_hash".to_string(),
                    members,
                });
            }
        }
    }

    // Same-size candidates: lower confidence, excludes anything already
    // reported as an exact-hash duplicate so groups don't overlap.
    {
        let exact_ids: std::collections::HashSet<i64> =
            groups.iter().flat_map(|g| g.members.iter().map(|m| m.id)).collect();
        let mut stmt = conn.prepare(
            "SELECT file_size FROM media
             WHERE is_deleted = 0 AND media_type IN ('photo','video','animated')
             GROUP BY file_size HAVING COUNT(*) > 1",
        )?;
        let sizes: Vec<i64> = stmt.query_map([], |r| r.get(0))?.filter_map(Result::ok).collect();
        for size in sizes {
            let mut mstmt = conn.prepare(
                "SELECT id, rel_path, filename, file_size, modified_time FROM media
                 WHERE is_deleted = 0 AND file_size = ?1 ORDER BY modified_time ASC",
            )?;
            let members: Vec<DuplicateMember> = mstmt
                .query_map(params![size], |r| {
                    Ok(DuplicateMember {
                        id: r.get(0)?,
                        rel_path: r.get(1)?,
                        filename: r.get(2)?,
                        file_size: r.get(3)?,
                        modified_time: r.get(4)?,
                    })
                })?
                .filter_map(Result::ok)
                .filter(|m| !exact_ids.contains(&m.id))
                .collect();
            if members.len() > 1 {
                groups.push(DuplicateGroup {
                    method: "same_size".to_string(),
                    members,
                });
            }
        }
    }

    Ok(groups)
}
