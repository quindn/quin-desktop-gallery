//! Region-based watermark/object removal (spec §15): rectangle or
//! freehand-brush regions, each with its own mode, composited frame-by-frame
//! onto raw RGB24 video frames (see `editor::pipeline`) rather than through
//! an ffmpeg filter graph — the only way to support an arbitrary brush mask
//! and real pixel-guessing inpaint, neither of which ffmpeg's built-in
//! filters (crop/overlay/delogo) can express. Not implemented — noted here
//! rather than silently ignored: moving-region tracking and full
//! deep-learning inpainting (e.g. LaMa). AI inpainting was deliberately
//! left out: running it per video frame on CPU (this app bundles no GPU
//! runtime) would take seconds per frame — minutes of processing per second
//! of footage — and the model weights alone run 100s of MB, working against
//! the "small, portable, bundles only ffmpeg" design. "Inpaint" mode instead
//! solves a discrete Laplace equation over the masked pixels (harmonic
//! diffusion from the surrounding known pixels, à la classic PDE-based
//! inpainting/"Poisson fill") — the same family of technique OpenCV's
//! `INPAINT_NS` uses, minus the fluid-dynamics term — which is fast enough
//! to run per frame and, for the common case (a logo over a fairly simple
//! or gently textured background), leaves no obvious trace of a box.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct RemovalRegion {
    pub mode: String, // "inpaint" | "blur" | "pixelate" | "cover"
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// Only used by "cover" mode: "#rrggbb", defaults to black.
    pub color: Option<String>,
    /// Freehand brush mask, row-major, `w * h` bytes, nonzero = affected.
    /// `None` means the whole rectangle is affected (the plain drag-a-box
    /// case) — keeps the common case from paying for a mask payload.
    pub mask: Option<Vec<u8>>,
}

impl RemovalRegion {
    pub fn active_at(&self, t_ms: i64) -> bool {
        match (self.start_ms, self.end_ms) {
            (Some(s), Some(e)) => t_ms >= s && t_ms <= e,
            (Some(s), None) => t_ms >= s,
            (None, Some(e)) => t_ms <= e,
            (None, None) => true,
        }
    }

    pub(super) fn is_masked(&self, local_x: i64, local_y: i64) -> bool {
        match &self.mask {
            None => true,
            Some(m) => {
                let idx = (local_y * self.w + local_x) as usize;
                m.get(idx).copied().unwrap_or(0) != 0
            }
        }
    }

    fn color_rgb(&self) -> [u8; 3] {
        let s = self.color.as_deref().unwrap_or("#000000");
        let s = s.trim_start_matches('#');
        if s.len() == 6 {
            let r = u8::from_str_radix(&s[0..2], 16).unwrap_or(0);
            let g = u8::from_str_radix(&s[2..4], 16).unwrap_or(0);
            let b = u8::from_str_radix(&s[4..6], 16).unwrap_or(0);
            [r, g, b]
        } else {
            [0, 0, 0]
        }
    }
}

#[inline]
fn px_idx(fw: usize, x: usize, y: usize) -> usize {
    (y * fw + x) * 3
}

/// Applies every region active at `t_ms` to one RGB24 frame buffer
/// (`frame.len() == fw * fh * 3`), in order. `scratch` carries each
/// inpaint region's previous solved state across frames for a warm-started
/// (faster, temporally stabler) solve — indexed the same as `regions`.
pub fn apply_regions_to_frame(
    frame: &mut [u8],
    fw: usize,
    fh: usize,
    regions: &[RemovalRegion],
    t_ms: i64,
    scratch: &mut [super::inpaint::InpaintScratch],
) {
    for (i, region) in regions.iter().enumerate() {
        if !region.active_at(t_ms) {
            continue;
        }
        match region.mode.as_str() {
            "inpaint" => super::inpaint::inpaint_region(frame, fw, fh, region, &mut scratch[i]),
            "blur" => blur_region(frame, fw, fh, region),
            "pixelate" => pixelate_region(frame, fw, fh, region),
            "cover" => cover_region(frame, fw, fh, region),
            _ => {}
        }
    }
}

fn region_bounds(fw: usize, fh: usize, r: &RemovalRegion) -> Option<(usize, usize, usize, usize)> {
    let x0 = r.x.clamp(0, fw as i64) as usize;
    let y0 = r.y.clamp(0, fh as i64) as usize;
    let x1 = (r.x + r.w).clamp(0, fw as i64) as usize;
    let y1 = (r.y + r.h).clamp(0, fh as i64) as usize;
    if x1 <= x0 || y1 <= y0 {
        None
    } else {
        Some((x0, y0, x1, y1))
    }
}

fn cover_region(frame: &mut [u8], fw: usize, fh: usize, r: &RemovalRegion) {
    let Some((x0, y0, x1, y1)) = region_bounds(fw, fh, r) else { return };
    let color = r.color_rgb();
    for y in y0..y1 {
        for x in x0..x1 {
            if !r.is_masked(x as i64 - r.x, y as i64 - r.y) {
                continue;
            }
            let idx = px_idx(fw, x, y);
            frame[idx..idx + 3].copy_from_slice(&color);
        }
    }
}

fn pixelate_region(frame: &mut [u8], fw: usize, fh: usize, r: &RemovalRegion) {
    let Some((x0, y0, x1, y1)) = region_bounds(fw, fh, r) else { return };
    let block = ((x1 - x0).max(y1 - y0) / 14).clamp(4, 48);
    let mut by = y0;
    while by < y1 {
        let bh = block.min(y1 - by);
        let mut bx = x0;
        while bx < x1 {
            let bw = block.min(x1 - bx);
            let mut sum = [0u32; 3];
            let mut count = 0u32;
            for y in by..by + bh {
                for x in bx..bx + bw {
                    let idx = px_idx(fw, x, y);
                    sum[0] += frame[idx] as u32;
                    sum[1] += frame[idx + 1] as u32;
                    sum[2] += frame[idx + 2] as u32;
                    count += 1;
                }
            }
            #[allow(clippy::manual_checked_ops)]
            if count > 0 {
                let avg = [
                    (sum[0] / count) as u8,
                    (sum[1] / count) as u8,
                    (sum[2] / count) as u8,
                ];
                for y in by..by + bh {
                    for x in bx..bx + bw {
                        if !r.is_masked(x as i64 - r.x, y as i64 - r.y) {
                            continue;
                        }
                        let idx = px_idx(fw, x, y);
                        frame[idx..idx + 3].copy_from_slice(&avg);
                    }
                }
            }
            bx += block;
        }
        by += block;
    }
}

fn blur_region(frame: &mut [u8], fw: usize, fh: usize, r: &RemovalRegion) {
    let Some((x0, y0, x1, y1)) = region_bounds(fw, fh, r) else { return };
    let radius = 8usize;
    // Snapshot the source pixels for this box (+ radius padding) before
    // writing, so the box-blur reads only original values.
    let px0 = x0.saturating_sub(radius);
    let py0 = y0.saturating_sub(radius);
    let px1 = (x1 + radius).min(fw);
    let py1 = (y1 + radius).min(fh);
    let bw = px1 - px0;
    let bh = py1 - py0;
    let mut src = vec![0u8; bw * bh * 3];
    for y in py0..py1 {
        for x in px0..px1 {
            let s = px_idx(fw, x, y);
            let d = ((y - py0) * bw + (x - px0)) * 3;
            src[d..d + 3].copy_from_slice(&frame[s..s + 3]);
        }
    }
    for y in y0..y1 {
        for x in x0..x1 {
            if !r.is_masked(x as i64 - r.x, y as i64 - r.y) {
                continue;
            }
            let mut sum = [0u32; 3];
            let mut count = 0u32;
            let ry0 = y.saturating_sub(radius).max(py0);
            let ry1 = (y + radius + 1).min(py1);
            let rx0 = x.saturating_sub(radius).max(px0);
            let rx1 = (x + radius + 1).min(px1);
            for sy in ry0..ry1 {
                for sx in rx0..rx1 {
                    let d = ((sy - py0) * bw + (sx - px0)) * 3;
                    sum[0] += src[d] as u32;
                    sum[1] += src[d + 1] as u32;
                    sum[2] += src[d + 2] as u32;
                    count += 1;
                }
            }
            let idx = px_idx(fw, x, y);
            frame[idx] = (sum[0] / count) as u8;
            frame[idx + 1] = (sum[1] / count) as u8;
            frame[idx + 2] = (sum[2] / count) as u8;
        }
    }
}
