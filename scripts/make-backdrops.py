"""Builds the app's two window backdrops: a photo seen through a fogged-up
window pane (condensation haze, finger-wiped streaks showing the sharp photo,
and water droplets that act as tiny inverted lenses).

    python scripts/make-backdrops.py <light-photo.jpg> <dark-photo.jpg>

Writes src/assets/bg-light.jpg and src/assets/bg-dark.jpg. Needs Pillow and
numpy. Seeds are fixed, so the output is reproducible.

Photos used (Pexels licence — free to use, no attribution required):
  light: https://www.pexels.com/photo/10615070/  (misty hills at sunrise)
  dark:  https://www.pexels.com/photo/1477537/   (night sky full of stars)
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT_W = 2560
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "assets")


def smooth_noise(h, w, rng, scales, weights):
    """Low-frequency fractal noise in 0..1 (random grids upscaled bicubically)."""
    acc = np.zeros((h, w), np.float32)
    for s, wt in zip(scales, weights):
        gh, gw = max(2, int(h / s)), max(2, int(w / s))
        grid = (rng.random((gh, gw)) * 255).astype(np.uint8)
        acc += wt * (np.asarray(Image.fromarray(grid).resize((w, h), Image.BICUBIC), np.float32) / 255.0)
    acc -= acc.min()
    return acc / max(acc.max(), 1e-6)


def blur(arr, radius):
    """Gaussian blur of an HxWx3 (or HxW) float array in 0..1."""
    if arr.ndim == 2:
        im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "L")
        return np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255.0
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "RGB")
    return np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255.0


def wipe_mask(h, w, rng, swipes, drop_trails):
    """0..1 mask of where the fog has been wiped away."""
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    for _ in range(swipes):
        x = rng.uniform(0.05, 0.95) * w
        y = rng.uniform(-0.05, 0.45) * h
        length = rng.uniform(0.35, 0.75) * h
        angle = math.radians(rng.uniform(-24, 24))
        width = rng.uniform(110, 210)
        strength = int(rng.uniform(0.55, 0.85) * 255)
        wobble = rng.uniform(25, 70)
        phase = rng.uniform(0, 6.28)
        pts = []
        for t in np.linspace(0, 1, 40):
            px = x + math.sin(angle) * length * t + math.sin(t * 5 + phase) * wobble
            py = y + math.cos(angle) * length * t
            pts.append((px, py))
        d.line(pts, fill=strength, width=int(width), joint="curve")
    for cx, cy, r in drop_trails:
        # A running drop leaves a narrow clear track behind it.
        length = r * rng.uniform(5, 12)
        pts = [(cx + math.sin(t * 3 + cx) * 2.5, cy - length * (1 - t)) for t in np.linspace(0, 1, 14)]
        d.line(pts, fill=int(rng.uniform(0.75, 1.0) * 255), width=max(3, int(r * 0.9)), joint="curve")
    m = np.asarray(img.filter(ImageFilter.GaussianBlur(26)), np.float32) / 255.0
    # Streaky edges rather than a perfectly smooth stencil.
    return np.clip(m * (0.8 + 0.4 * smooth_noise(h, w, rng, [40, 14], [0.6, 0.4])), 0, 1)


def draw_drop(base, clear, cx, cy, r, light):
    h, w = base.shape[:2]
    x0, x1 = int(max(0, cx - r - 3)), int(min(w, cx + r + 4))
    y0, y1 = int(max(0, cy - r * 1.15 - 3)), int(min(h, cy + r * 1.15 + 4))
    if x1 <= x0 or y1 <= y0:
        return
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    dx, dy = xs - cx, ys - cy
    dist = np.sqrt(dx * dx + (dy / 1.12) ** 2)  # slightly taller than wide: gravity
    alpha = np.clip(r - dist, 0, 1)
    if alpha.max() <= 0:
        return
    # A drop is a lens: it shows a wider, upside-down, compressed piece of the scene.
    mag = 2.4
    sx = np.clip(cx + dx * mag, 0, w - 1).astype(np.int32)
    sy = np.clip(cy - dy * mag, 0, h - 1).astype(np.int32)
    lens = clear[sy, sx] * (1.14 if light else 1.7) + (0.02 if light else 0.07)
    t = np.clip(dist / r, 0, 1)
    rim = np.clip((t - 0.72) / 0.28, 0, 1) ** 1.5
    lens *= (1 - (0.30 if light else 0.12) * rim * np.where(dy < 0, 1.0, 0.55))[..., None]
    crescent = np.clip((dy / r - 0.30) / 0.70, 0, 1) * np.clip((t - 0.5) / 0.5, 0, 1)
    lens += (0.20 if light else 0.32) * crescent[..., None]
    spec = np.exp(-((dx + 0.38 * r) ** 2 + (dy + 0.42 * r) ** 2) / (2 * (0.15 * r) ** 2))
    lens += 0.9 * spec[..., None]
    a = alpha[..., None]
    base[y0:y1, x0:x1] = base[y0:y1, x0:x1] * (1 - a) + np.clip(lens, 0, 1) * a


def build(src_path, out_path, mode, seed):
    rng = np.random.default_rng(seed)
    light = mode == "light"

    photo = Image.open(src_path).convert("RGB")
    h = round(OUT_W * photo.height / photo.width)
    photo = photo.resize((OUT_W, h), Image.LANCZOS)
    w = OUT_W
    src = np.asarray(photo, np.float32) / 255.0

    frosted = blur(src, 26 if light else 30)   # what the fogged glass shows
    thin = blur(src, 8 if light else 3.5)       # glass wiped clean-ish
    clear = blur(src, 2.6 if light else 1.3)    # what a droplet shows

    # Drops: many tiny ones, fewer medium, a few big ones that run and leave tracks.
    def positions(n, bias):
        xs = rng.random(n) * w
        ys = (rng.random(n) ** bias) * h  # bias < 1 pushes drops toward the bottom
        return xs, ys

    small = list(zip(*positions(2300, 0.75), rng.uniform(1.6, 4.6, 2300) ** 1.0))
    medium = list(zip(*positions(170, 0.7), rng.uniform(5.0, 11.5, 170)))
    large = list(zip(*positions(26, 0.6), rng.uniform(13, 25, 26)))
    trails = [d for d in large if rng.random() < 0.65]

    wiped = wipe_mask(h, w, rng, swipes=3 if light else 4, drop_trails=trails)

    density = smooth_noise(h, w, rng, [260, 120, 50], [0.55, 0.3, 0.15])
    fog = np.clip(0.72 + 0.4 * density, 0, 1)         # mostly fogged, unevenly
    fog = np.clip(fog * (1 - 0.92 * wiped), 0, 1)     # ...except where wiped

    f3 = fog[..., None]
    img = frosted * f3 + thin * (1 - f3)

    # Condensation haze: fog scatters light, lifting and desaturating what's behind it.
    tint = np.array([0.97, 0.97, 0.95] if light else [0.34, 0.42, 0.56], np.float32)
    haze = (0.44 if light else 0.09) * f3
    img = img * (1 - haze) + tint * haze

    # Fine grain of micro-droplets, only where there's fog.
    grain = np.asarray(
        Image.fromarray((rng.random((h, w)) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.9)),
        np.float32,
    ) / 255.0
    grain = (grain - grain.mean()) / max(grain.std(), 1e-6)
    img = img + (0.016 if light else 0.011) * grain[..., None] * f3

    for cx, cy, r in small + medium + large:
        draw_drop(img, clear, cx, cy, r, light)

    # Vignette keeps the edges (where the sidebar/toolbars sit) calmer.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rr = ((xx / w - 0.5) ** 2 + (yy / h - 0.5) ** 2) * 2
    img = img * (1 - (0.06 if light else 0.32) * rr)[..., None]
    if light:
        img = img + 0.03  # airy, not muddy
    if not light:
        img = (np.clip(img, 0, 1) ** 0.95) * 0.9  # keep it deep, but let the fog read

    out = Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    out.save(out_path, "JPEG", quality=84, optimize=True, progressive=True)
    print(f"{mode}: {out_path} {out.size} {os.path.getsize(out_path) // 1024} KB")

    # The animated raindrops (RainOverlay) are little lenses: they show a
    # sharper, upside-down piece of the scene. This is that scene, matched to
    # the backdrop's framing and tone (same size ratio, smaller file).
    lens = clear
    if not light:
        lens = np.clip(lens, 0, 1) ** 0.95 * 0.9
    lens_img = Image.fromarray((np.clip(lens, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
    lens_img = lens_img.resize((1280, round(1280 * h / w)), Image.LANCZOS)
    lens_path = out_path.replace(".jpg", "-clear.jpg")
    lens_img.save(lens_path, "JPEG", quality=80, optimize=True)
    print(f"{mode} lens: {lens_path} {lens_img.size} {os.path.getsize(lens_path) // 1024} KB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    build(sys.argv[1], os.path.join(OUT_DIR, "bg-light.jpg"), "light", 7)
    build(sys.argv[2], os.path.join(OUT_DIR, "bg-dark.jpg"), "dark", 11)
