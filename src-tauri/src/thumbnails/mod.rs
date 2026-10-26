//! Thumbnail generation for both photos (via the `image` crate) and
//! videos (via the bundled FFmpeg sidecar). Actual scheduling —
//! concurrency limits, priority, dedup — lives in `queue`; this module is
//! just the pure "make one thumbnail" logic each queued job calls into.

pub mod queue;

use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use tauri::AppHandle;

pub const GRID_MAX_EDGE: u32 = 512;

/// Cache key per spec: derived from path + modified time + size, so a
/// changed file naturally invalidates its cached thumbnail without a full
/// content hash. See MEDIA_PIPELINE.md.
pub fn cache_key(rel_path: &str, modified_time: i64, file_size: i64) -> String {
    let s = format!("{rel_path}|{modified_time}|{file_size}");
    blake3::hash(s.as_bytes()).to_hex()[..24].to_string()
}

pub fn thumbnail_path(cache_dir: &Path, key: &str) -> PathBuf {
    cache_dir.join(format!("{key}.jpg"))
}

/// Generates (or returns the already-cached) thumbnail for a photo.
/// Writes via temp-file-then-rename so a crash mid-write never leaves a
/// corrupt cache entry (spec §30).
///
/// Uses `Triangle` (bilinear) rather than `Lanczos3` resampling: at grid
/// thumbnail sizes the visual difference is negligible but Triangle is
/// several times faster, which matters when warming thousands of these in
/// the background. Lanczos3 is worth it for full-size viewer/filmstrip
/// previews later, not the grid.
pub fn ensure_photo_thumbnail(
    source: &Path,
    cache_dir: &Path,
    key: &str,
) -> anyhow::Result<PathBuf> {
    let out_path = thumbnail_path(cache_dir, key);
    if out_path.exists() {
        return Ok(out_path);
    }
    std::fs::create_dir_all(cache_dir)?;

    let img = image::open(source)?;
    let thumb = img.resize(GRID_MAX_EDGE, GRID_MAX_EDGE, FilterType::Triangle);

    let tmp_path = cache_dir.join(format!("{key}.tmp"));
    thumb.to_rgb8().save_with_format(&tmp_path, image::ImageFormat::Jpeg)?;
    std::fs::rename(&tmp_path, &out_path)?;
    Ok(out_path)
}

/// Extracts a representative video frame via the bundled FFmpeg sidecar.
/// Seeks a little into the clip (proportional to duration when known) to
/// avoid black/fade-in opening frames, falling back to frame 0 if that
/// seek produces nothing (very short clips, or a seek past EOF).
pub async fn ensure_video_thumbnail(
    app: &AppHandle,
    source: &Path,
    cache_dir: &Path,
    key: &str,
    duration_ms: Option<i64>,
) -> anyhow::Result<PathBuf> {
    let out_path = thumbnail_path(cache_dir, key);
    if out_path.exists() {
        return Ok(out_path);
    }
    std::fs::create_dir_all(cache_dir)?;

    let seek_secs = match duration_ms {
        Some(ms) if ms > 0 => ((ms as f64 / 1000.0) * 0.1).clamp(0.5, 5.0),
        _ => 1.0,
    };

    let tmp_path = cache_dir.join(format!("{key}.tmp.jpg"));
    let source_str = source.to_string_lossy().to_string();
    let tmp_str = tmp_path.to_string_lossy().to_string();
    let scale_filter = format!("scale='min({GRID_MAX_EDGE},iw)':-2");

    let try_extract = |seek: f64, tmp_str: String, source_str: String| {
        let app = app.clone();
        let scale_filter = scale_filter.clone();
        async move {
            let output = crate::metadata::probe::run_sidecar(
                &app,
                "ffmpeg",
                vec![
                    "-y".to_string(),
                    "-nostdin".to_string(),
                    // One frame doesn't need every core; several of these run
                    // at once, and left alone each grabbed them all.
                    "-threads".to_string(),
                    "1".to_string(),
                    "-ss".to_string(),
                    format!("{seek:.2}"),
                    "-i".to_string(),
                    source_str,
                    "-frames:v".to_string(),
                    "1".to_string(),
                    "-vf".to_string(),
                    scale_filter,
                    "-q:v".to_string(),
                    "4".to_string(),
                    tmp_str.clone(),
                ],
                std::time::Duration::from_secs(60),
            )
            .await?;
            anyhow::Ok(output.success && Path::new(&tmp_str).exists())
        }
    };

    let mut ok = try_extract(seek_secs, tmp_str.clone(), source_str.clone()).await?;
    if !ok && seek_secs > 0.0 {
        ok = try_extract(0.0, tmp_str.clone(), source_str.clone()).await?;
    }
    if !ok {
        anyhow::bail!("ffmpeg produced no frame for {}", source.display());
    }

    std::fs::rename(&tmp_path, &out_path)?;
    Ok(out_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_image(path: &Path, w: u32, h: u32) {
        let img = image::RgbImage::from_fn(w, h, |x, _y| {
            image::Rgb([((x * 255) / w.max(1)) as u8, 128, 200])
        });
        img.save(path).unwrap();
    }

    #[test]
    fn generates_and_caches_thumbnail() {
        let tmp = std::env::temp_dir().join(format!("qpg-thumb-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("source.png");
        make_test_image(&source, 1600, 900);

        let cache_dir = tmp.join("cache");
        let key = cache_key("photos/source.png", 1234, 5678);

        let out = ensure_photo_thumbnail(&source, &cache_dir, &key).unwrap();
        assert!(out.exists());
        let decoded = image::open(&out).unwrap();
        // Long edge capped at GRID_MAX_EDGE, aspect ratio preserved.
        assert!(decoded.width() <= GRID_MAX_EDGE);
        assert!(decoded.height() <= GRID_MAX_EDGE);
        assert!(decoded.width() > decoded.height());

        // Second call hits the cache and returns the same path without
        // erroring on a source that's now irrelevant.
        let cached_again = ensure_photo_thumbnail(&source, &cache_dir, &key).unwrap();
        assert_eq!(out, cached_again);

        std::fs::remove_dir_all(&tmp).ok();
    }
}
