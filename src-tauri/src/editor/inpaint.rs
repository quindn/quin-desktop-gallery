//! Diffusion-based pixel inpainting for the "Auto Remove" watermark mode.
//!
//! For each frame, the masked pixels are solved as a discrete Laplace
//! equation — each unknown pixel converges to the average of its 4
//! neighbors — seeded from a few pixels of real, known border around the
//! region. Iterated to convergence (or close to it), this "grows" the
//! surrounding texture/color smoothly inward, the classic PDE approach to
//! inpainting (OpenCV's `INPAINT_NS` is this same idea plus a fluid-flow
//! term for sharper edges). It has a real limitation: strongly patterned or
//! detailed backgrounds (bricks, text, fine texture) fill in *smooth*
//! rather than reproducing the pattern — there is no substitute for a real
//! exemplar-based or learned model there. For the common case (sky,
//! gradients, skin, out-of-focus background, solid colors) the result
//! blends in with no visible trace of a box.
//!
//! `InpaintScratch` carries the previous frame's solved values forward so a
//! static region only needs a handful of refinement iterations per frame
//! instead of solving from scratch — both faster and less flickery, since
//! consecutive frames start from a similar answer.

use super::watermark::RemovalRegion;

#[derive(Default)]
pub struct InpaintScratch {
    initialized: bool,
    pw: usize,
    ph: usize,
    buf: Vec<f32>,
}

const PAD: i64 = 4;
const COLD_MIN_ITERS: usize = 120;
const COLD_MAX_ITERS: usize = 400;
const WARM_ITERS: usize = 25;

#[inline]
fn px_idx(fw: usize, x: usize, y: usize) -> usize {
    (y * fw + x) * 3
}

pub fn inpaint_region(frame: &mut [u8], fw: usize, fh: usize, region: &RemovalRegion, scratch: &mut InpaintScratch) {
    let (x0, y0, w, h) = (region.x, region.y, region.w, region.h);
    if w <= 0 || h <= 0 {
        return;
    }

    let px0 = (x0 - PAD).max(0);
    let py0 = (y0 - PAD).max(0);
    let px1 = (x0 + w + PAD).min(fw as i64);
    let py1 = (y0 + h + PAD).min(fh as i64);
    if px1 <= px0 || py1 <= py0 {
        return;
    }
    let pw = (px1 - px0) as usize;
    let ph = (py1 - py0) as usize;

    let mut unknown = vec![false; pw * ph];
    for ly in 0..ph {
        for lx in 0..pw {
            let fx = px0 + lx as i64;
            let fy = py0 + ly as i64;
            let within_rect = fx >= x0 && fx < x0 + w && fy >= y0 && fy < y0 + h;
            unknown[ly * pw + lx] = within_rect && region.is_masked(fx - x0, fy - y0);
        }
    }
    // A region with nothing actually masked (an empty brush stroke bbox
    // slipped through) has no work to do.
    if !unknown.iter().any(|&u| u) {
        return;
    }

    let mut buf = vec![0f32; pw * ph * 3];
    for ly in 0..ph {
        for lx in 0..pw {
            let fx = (px0 + lx as i64) as usize;
            let fy = (py0 + ly as i64) as usize;
            let s = px_idx(fw, fx, fy);
            let d = (ly * pw + lx) * 3;
            buf[d] = frame[s] as f32;
            buf[d + 1] = frame[s + 1] as f32;
            buf[d + 2] = frame[s + 2] as f32;
        }
    }

    let warm = scratch.initialized && scratch.pw == pw && scratch.ph == ph && scratch.buf.len() == buf.len();
    let iterations = if warm {
        WARM_ITERS
    } else {
        (((w.max(h)) as usize) * 2).clamp(COLD_MIN_ITERS, COLD_MAX_ITERS)
    };

    if warm {
        for i in 0..unknown.len() {
            if unknown[i] {
                buf[i * 3] = scratch.buf[i * 3];
                buf[i * 3 + 1] = scratch.buf[i * 3 + 1];
                buf[i * 3 + 2] = scratch.buf[i * 3 + 2];
            }
        }
    } else {
        let mut sum = [0f64; 3];
        let mut count = 0u64;
        for i in 0..unknown.len() {
            if !unknown[i] {
                sum[0] += buf[i * 3] as f64;
                sum[1] += buf[i * 3 + 1] as f64;
                sum[2] += buf[i * 3 + 2] as f64;
                count += 1;
            }
        }
        let avg = if count > 0 {
            [(sum[0] / count as f64) as f32, (sum[1] / count as f64) as f32, (sum[2] / count as f64) as f32]
        } else {
            [128.0, 128.0, 128.0]
        };
        for i in 0..unknown.len() {
            if unknown[i] {
                buf[i * 3] = avg[0];
                buf[i * 3 + 1] = avg[1];
                buf[i * 3 + 2] = avg[2];
            }
        }
    }

    // Gauss-Seidel relaxation of the discrete Laplace equation: each
    // unknown pixel becomes the average of whichever of its 4 neighbors
    // exist, using neighbors' latest values (including ones already
    // updated this same pass) for faster convergence than Jacobi.
    for _ in 0..iterations {
        for ly in 0..ph {
            for lx in 0..pw {
                let i = ly * pw + lx;
                if !unknown[i] {
                    continue;
                }
                let mut acc = [0f32; 3];
                let mut n = 0f32;
                if lx > 0 {
                    let j = i - 1;
                    acc[0] += buf[j * 3];
                    acc[1] += buf[j * 3 + 1];
                    acc[2] += buf[j * 3 + 2];
                    n += 1.0;
                }
                if lx + 1 < pw {
                    let j = i + 1;
                    acc[0] += buf[j * 3];
                    acc[1] += buf[j * 3 + 1];
                    acc[2] += buf[j * 3 + 2];
                    n += 1.0;
                }
                if ly > 0 {
                    let j = i - pw;
                    acc[0] += buf[j * 3];
                    acc[1] += buf[j * 3 + 1];
                    acc[2] += buf[j * 3 + 2];
                    n += 1.0;
                }
                if ly + 1 < ph {
                    let j = i + pw;
                    acc[0] += buf[j * 3];
                    acc[1] += buf[j * 3 + 1];
                    acc[2] += buf[j * 3 + 2];
                    n += 1.0;
                }
                if n > 0.0 {
                    buf[i * 3] = acc[0] / n;
                    buf[i * 3 + 1] = acc[1] / n;
                    buf[i * 3 + 2] = acc[2] / n;
                }
            }
        }
    }

    for ly in 0..ph {
        for lx in 0..pw {
            let i = ly * pw + lx;
            if !unknown[i] {
                continue;
            }
            let fx = (px0 + lx as i64) as usize;
            let fy = (py0 + ly as i64) as usize;
            let d = px_idx(fw, fx, fy);
            frame[d] = buf[i * 3].round().clamp(0.0, 255.0) as u8;
            frame[d + 1] = buf[i * 3 + 1].round().clamp(0.0, 255.0) as u8;
            frame[d + 2] = buf[i * 3 + 2].round().clamp(0.0, 255.0) as u8;
        }
    }

    scratch.initialized = true;
    scratch.pw = pw;
    scratch.ph = ph;
    scratch.buf = buf;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_frame(fw: usize, fh: usize, color: [u8; 3]) -> Vec<u8> {
        let mut f = vec![0u8; fw * fh * 3];
        for px in f.chunks_mut(3) {
            px.copy_from_slice(&color);
        }
        f
    }

    #[test]
    fn fills_masked_rect_toward_surrounding_color() {
        let (fw, fh) = (60, 60);
        let mut frame = solid_frame(fw, fh, [200, 100, 50]);
        // Paint a contrasting "watermark" block in the middle.
        let region = RemovalRegion {
            mode: "inpaint".to_string(),
            x: 20,
            y: 20,
            w: 20,
            h: 20,
            start_ms: None,
            end_ms: None,
            color: None,
            mask: None,
        };
        for y in 20..40 {
            for x in 20..40 {
                let i = (y * fw + x) * 3;
                frame[i..i + 3].copy_from_slice(&[0, 0, 0]);
            }
        }
        let mut scratch = InpaintScratch::default();
        inpaint_region(&mut frame, fw, fh, &region, &mut scratch);

        // Center pixel should now be close to the surrounding color, not
        // still black.
        let center = (30 * fw + 30) * 3;
        assert!(frame[center] > 150, "expected reconstructed red channel near 200, got {}", frame[center]);
        assert!(frame[center + 1] > 60, "expected reconstructed green channel near 100, got {}", frame[center + 1]);
    }

    #[test]
    fn warm_start_converges_with_fewer_iterations_and_stays_close() {
        let (fw, fh) = (40, 40);
        let mut frame = solid_frame(fw, fh, [10, 200, 30]);
        for y in 15..25 {
            for x in 15..25 {
                let i = (y * fw + x) * 3;
                frame[i..i + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let region = RemovalRegion {
            mode: "inpaint".to_string(),
            x: 15,
            y: 15,
            w: 10,
            h: 10,
            start_ms: None,
            end_ms: None,
            color: None,
            mask: None,
        };
        let mut scratch = InpaintScratch::default();
        inpaint_region(&mut frame, fw, fh, &region, &mut scratch);
        assert!(scratch.initialized);

        // A second "frame" with the same watermark re-painted — warm start
        // should still converge close to the surrounding green.
        for y in 15..25 {
            for x in 15..25 {
                let i = (y * fw + x) * 3;
                frame[i..i + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        inpaint_region(&mut frame, fw, fh, &region, &mut scratch);
        let center = (20 * fw + 20) * 3;
        assert!(frame[center + 1] > 150, "expected green channel near 200 after warm start, got {}", frame[center + 1]);
    }

    #[test]
    fn brush_mask_only_affects_flagged_pixels() {
        let (fw, fh) = (20, 20);
        let mut frame = solid_frame(fw, fh, [50, 50, 50]);
        // Watermark only the top-left 2x2 of a 4x4 region.
        let mut mask = vec![0u8; 16];
        mask[0] = 1;
        mask[1] = 1;
        mask[4] = 1;
        mask[5] = 1;
        for y in 8..10 {
            for x in 8..10 {
                let i = (y * fw + x) * 3;
                frame[i..i + 3].copy_from_slice(&[255, 0, 0]);
            }
        }
        let region = RemovalRegion {
            mode: "inpaint".to_string(),
            x: 8,
            y: 8,
            w: 4,
            h: 4,
            start_ms: None,
            end_ms: None,
            color: None,
            mask: Some(mask),
        };
        let mut scratch = InpaintScratch::default();
        inpaint_region(&mut frame, fw, fh, &region, &mut scratch);
        // A masked pixel should have changed from pure red.
        let masked_px = (8 * fw + 8) * 3;
        assert_ne!(&frame[masked_px..masked_px + 3], &[255, 0, 0]);
        // An unmasked pixel within the bbox but outside the mask must be untouched.
        let unmasked_px = (10 * fw + 10) * 3;
        assert_eq!(&frame[unmasked_px..unmasked_px + 3], &[50, 50, 50]);
    }
}
