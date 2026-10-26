import { useEffect, useRef } from "react";
import lensDark from "../assets/bg-dark-clear.jpg";
import lensLight from "../assets/bg-light-clear.jpg";
import { useGalleryStore } from "../stores/galleryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useThemeStore } from "../stores/themeStore";

// Raindrops running down the fogged window. The droplets baked into the
// backdrop photo stay put; these are the live ones: they sit for a while,
// then slip down in a stick–slip way (accelerate, coast, stop), swallow
// smaller drops they meet, shed tiny beads and leave a fading wet track.
// Each drop is a little lens: it shows a sharper, upside-down piece of the
// scene behind it (sampled from the "clear" copy of the backdrop).
//
// Built for a steady 60 fps: every frame is a handful of drawImage calls.
//  * each drop is a small pre-rendered sprite, re-rendered only when it has
//    moved a good distance or changed size (a resting drop is drawn once; the
//    refraction inside a small drop hardly changes over a few dozen pixels, and
//    re-rendering sprites was by far the most expensive part of the animation);
//  * nothing is drawn while the Browser is shown (a page covers the window) or
//    the window is hidden;
//  * a wet track is cut into short pieces; each piece is stroked ONCE (on a
//    software canvas, away from the GPU) into a small bitmap and afterwards
//    only blitted with a fade. Stroking long polylines on the GPU every frame
//    was what made the whole animation heavy; only the newest few points of
//    a sliding drop's track are stroked live so it stays glued to the drop;
//  * the pieces of finished tracks are composed into one layer that is
//    refreshed a few times a second, so a frame only draws that layer once;
//  * motion is time-based (dt), so a late frame never makes drops jump.

type Phase = "rest" | "slide";

interface Trail {
  pts: number[]; // x0, y0, x1, y1, ...
  beads: { x: number; y: number; r: number }[];
  width: number;
  /** Older pieces of the track, already rendered. */
  chunks: { bmp: ImageBitmap; x: number; y: number; w: number; h: number }[];
  /** Last time the drop that made it touched it (seconds); it fades after that. */
  touched: number;
  active: boolean;
}

interface Drop {
  x: number;
  y: number;
  r: number;
  phase: Phase;
  timer: number; // seconds left resting
  travelled: number;
  target: number; // how far this slide goes
  vmax: number;
  wobble: number;
  nextBead: number;
  trail: Trail | null;
  // pre-rendered look (an ImageBitmap is an immutable texture: far cheaper to draw 30 times a frame than 30 canvases)
  sprite: ImageBitmap | null;
  sw: number;
  sh: number;
  bx: number;
  by: number;
  br: number;
  bphase: Phase;
}

const FADE_SECONDS = 15;
const CHUNK_POINTS = 24; // points of a track kept live before that piece is rendered once
const LAYER_EVERY = 0.25; // seconds between refreshes of the layer holding finished tracks
const REBAKE_DIST = 80; // px a drop may travel before its sprite is re-rendered
const REBAKE_SIZE = 0.9; // px its radius may change before that

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function RainOverlay() {
  const theme = useThemeStore((s) => s.theme);
  const enabled = useSettingsStore((s) => s.rainAnimation);
  const covered = useGalleryStore((s) => s.mainView === "browser");
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const light = theme === "light";
    const img = new Image();
    img.src = light ? lensLight : lensDark;

    let W = 1;
    let H = 1;
    let dpr = 1;
    // canvas px -> lens-image px ("cover" framing, same as the backdrop)
    let mapS = 1;
    let mapOx = 0;
    let mapOy = 0;
    const drops: Drop[] = [];
    const trails: Trail[] = [];
    let now = 0; // seconds of animation time
    let raf = 0;
    let last = performance.now();
    let stopped = false;

    // finished tracks, composed from their rendered pieces
    const layer = document.createElement("canvas");
    const lctx = layer.getContext("2d")!;
    let layerAge = 999;

    // frame statistics (read by the tests / a curious developer: window.__rain)
    const stats = { frames: 0, ms: 0, worst: 0, bakes: 0, since: performance.now() };
    (window as unknown as { __rain: typeof stats }).__rain = stats;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width));
      H = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas!.width = Math.round(W * dpr);
      canvas!.height = Math.round(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      layer.width = canvas!.width;
      layer.height = canvas!.height;
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layerAge = 999;
      if (img.naturalWidth) {
        mapS = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        mapOx = (W - img.naturalWidth * mapS) / 2;
        mapOy = (H - img.naturalHeight * mapS) / 2;
      }
      for (const d of drops) dropSprite(d); // re-render at the new pixel ratio
    }

    function dropSprite(d: Drop) {
      d.sprite?.close();
      d.sprite = null;
    }

    const targetCount = () => Math.round(clamp((W * H) / 52000, 10, 34));

    function spawn(initial: boolean): Drop {
      const r = Math.random() < 0.12 ? rand(11, 16) : rand(4.5, 10.5);
      return {
        x: rand(0.02, 0.98) * W,
        y: initial ? rand(0.02, 0.85) * H : rand(-30, 0.2 * H),
        r,
        phase: initial && Math.random() < 0.65 ? "rest" : "slide",
        timer: rand(0.2, 3.5),
        travelled: 0,
        target: rand(45, 240),
        vmax: (70 + r * 16) * rand(0.8, 1.25),
        wobble: rand(0, 100),
        nextBead: rand(20, 55),
        trail: null,
        sprite: null,
        sw: 0,
        sh: 0,
        bx: 0,
        by: 0,
        br: 0,
        bphase: "rest",
      };
    }

    function startTrail(d: Drop) {
      const t: Trail = { pts: [d.x, d.y], beads: [], width: d.r * 0.85, chunks: [], touched: now, active: true };
      trails.push(t);
      d.trail = t;
    }

    function step(dt: number) {
      now += dt;
      const want = targetCount();
      if (drops.length < want && Math.random() < dt * 1.3) drops.push(spawn(false));

      for (const d of drops) {
        if (d.phase === "rest") {
          d.timer -= dt;
          if (d.timer <= 0) {
            d.phase = "slide";
            d.travelled = 0;
            d.target = rand(35, 230) * (0.6 + d.r / 12);
            d.vmax = (70 + d.r * 16) * rand(0.8, 1.25);
            d.trail = null;
          }
        }
        if (d.phase === "slide") {
          if (!d.trail) startTrail(d);
          const progress = clamp(d.travelled / d.target, 0, 1);
          const speed = d.vmax * (0.22 + 0.78 * Math.sin(Math.PI * progress)) + (d.r > 10 ? 40 : 0);
          const dy = speed * dt;
          d.y += dy;
          d.x += Math.sin((d.y + d.wobble) * 0.035) * dy * 0.12;
          d.travelled += dy;
          d.r = Math.max(3.4, d.r - dy * 0.0011); // leaves water behind

          const t = d.trail!;
          t.touched = now;
          const n = t.pts.length;
          if (Math.hypot(d.x - t.pts[n - 2], d.y - t.pts[n - 1]) >= 5) t.pts.push(d.x, d.y);
          if (t.pts.length >= CHUNK_POINTS * 2) commitTrail(t);
          d.nextBead -= dy;
          if (d.nextBead <= 0) {
            d.nextBead = rand(24, 70);
            t.beads.push({ x: d.x + rand(-0.5, 0.5) * d.r, y: d.y - d.r * 0.4, r: rand(0.9, 2.3) });
          }
          if (d.travelled >= d.target) {
            d.phase = "rest";
            d.timer = rand(0.5, 4);
            commitTrail(t);
            t.active = false;
            d.trail = null;
            layerAge = 999; // the finished track moves into the layer
          }
        }
      }

      // A sliding drop swallows whatever it runs into; the result gets heavier.
      for (const a of drops) {
        if (a.phase !== "slide") continue;
        for (const b of drops) {
          if (a === b || b.r > a.r * 1.05) continue;
          if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.75) {
            a.r = Math.sqrt(a.r * a.r + b.r * b.r * 0.85);
            a.vmax *= 1.12;
            a.target += 60;
            b.y = H + 999; // removed below
          }
        }
      }
      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        if (d.y - d.r > H) {
          if (d.trail) {
            commitTrail(d.trail);
            d.trail.active = false;
            layerAge = 999;
          }
          drops.splice(i, 1);
        }
      }
      for (let i = trails.length - 1; i >= 0; i--) {
        const t = trails[i];
        if (!t.active && now - t.touched > FADE_SECONDS) {
          for (const c of t.chunks) c.bmp.close();
          trails.splice(i, 1);
          layerAge = 999;
        }
      }
    }

    function trailAlpha(t: Trail): number {
      const age = t.active ? 0 : (now - t.touched) / FADE_SECONDS;
      return Math.pow(clamp(1 - age, 0, 1), 1.3);
    }

    function strokeTrail(c: Ctx2D, t: Trail, a: number) {
      if (a <= 0.01) return;
      if (t.pts.length >= 4) {
        c.beginPath();
        c.moveTo(t.pts[0], t.pts[1]);
        for (let i = 2; i < t.pts.length; i += 2) c.lineTo(t.pts[i], t.pts[i + 1]);
        c.lineWidth = t.width;
        c.strokeStyle = light ? `rgba(255,255,255,${0.2 * a})` : `rgba(190,210,245,${0.11 * a})`;
        c.stroke();
        c.lineWidth = Math.max(1, t.width * 0.35);
        c.strokeStyle = light ? `rgba(60,80,70,${0.07 * a})` : `rgba(0,0,0,${0.18 * a})`;
        c.stroke();
      }
      for (const b of t.beads) {
        c.beginPath();
        c.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        c.fillStyle = light ? `rgba(255,255,255,${0.55 * a})` : `rgba(215,228,255,${0.4 * a})`;
        c.fill();
        c.lineWidth = 0.7;
        c.strokeStyle = light ? `rgba(40,60,70,${0.3 * a})` : `rgba(0,0,0,${0.5 * a})`;
        c.stroke();
      }
    }

    // pieces of tracks are rendered on a SOFTWARE canvas: cheap for tiny areas, and it keeps the
    // vector stroking out of the GPU process
    const soft = new OffscreenCanvas(64, 64);
    const sfx = soft.getContext("2d", { willReadFrequently: true })!;

    /** Renders the live points of a track into a bitmap and keeps only the last point live. */
    function commitTrail(t: Trail) {
      const n = t.pts.length;
      if (n < 4 && t.beads.length === 0) return;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < n; i += 2) {
        x0 = Math.min(x0, t.pts[i]);
        x1 = Math.max(x1, t.pts[i]);
        y0 = Math.min(y0, t.pts[i + 1]);
        y1 = Math.max(y1, t.pts[i + 1]);
      }
      for (const b of t.beads) {
        x0 = Math.min(x0, b.x - b.r);
        x1 = Math.max(x1, b.x + b.r);
        y0 = Math.min(y0, b.y - b.r);
        y1 = Math.max(y1, b.y + b.r);
      }
      if (!isFinite(x0)) return;
      const pad = t.width + 3;
      x0 -= pad;
      y0 -= pad;
      x1 += pad;
      y1 += pad;
      const pw = Math.max(1, Math.ceil((x1 - x0) * dpr));
      const ph = Math.max(1, Math.ceil((y1 - y0) * dpr));
      soft.width = pw; // (also clears it)
      soft.height = ph;
      sfx.setTransform(dpr, 0, 0, dpr, -x0 * dpr, -y0 * dpr);
      sfx.lineCap = "round";
      sfx.lineJoin = "round";
      strokeTrail(sfx, t, 1);
      t.chunks.push({ bmp: soft.transferToImageBitmap(), x: x0, y: y0, w: pw / dpr, h: ph / dpr });
      // the trail carries on from where this piece ended
      t.pts = n >= 2 ? [t.pts[n - 2], t.pts[n - 1]] : [];
      t.beads = [];
    }

    /** The finished tracks (a blit per piece), refreshed a few times a second. */
    function renderLayer() {
      lctx.clearRect(0, 0, W, H);
      for (const t of trails) {
        if (t.active || !t.chunks.length) continue;
        const a = trailAlpha(t);
        if (a <= 0.01) continue;
        lctx.globalAlpha = a;
        for (const c of t.chunks) lctx.drawImage(c.bmp, c.x, c.y, c.w, c.h);
      }
      lctx.globalAlpha = 1;
      layerAge = 0;
    }

    /** One drop drawn centred at (cx, cy); the lens samples the backdrop at (wx, wy). */
    function paintDrop(c: Ctx2D, cx: number, cy: number, r: number, stretch: number, wx: number, wy: number) {
      const rx = r;
      const ry = r * stretch;

      // Soft shadow the drop casts on the fog around it.
      c.beginPath();
      c.ellipse(cx, cy + ry * 0.12, rx * 1.28, ry * 1.28, 0, 0, Math.PI * 2);
      c.fillStyle = light ? "rgba(30,50,40,0.06)" : "rgba(0,0,0,0.18)";
      c.fill();

      c.save();
      c.beginPath();
      c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      c.clip();
      if (img.complete && img.naturalWidth) {
        // Lens: the scene behind, magnified and flipped top-to-bottom.
        const mag = 2.3;
        const sx = (wx - rx * mag - mapOx) / mapS;
        const sy = (wy - ry * mag - mapOy) / mapS;
        const sw = (2 * rx * mag) / mapS;
        const sh = (2 * ry * mag) / mapS;
        c.translate(cx, cy);
        c.scale(1, -1);
        c.drawImage(img, sx, sy, sw, sh, -rx, -ry, 2 * rx, 2 * ry);
        c.scale(1, -1);
        c.translate(-cx, -cy);
      }
      // A drop gathers and brightens light.
      c.fillStyle = light ? "rgba(255,255,255,0.10)" : "rgba(190,210,245,0.09)";
      c.fillRect(cx - rx, cy - ry, 2 * rx, 2 * ry);
      // Thin dark upper rim, bright lower crescent.
      const g = c.createLinearGradient(0, cy - ry, 0, cy + ry);
      g.addColorStop(0, light ? "rgba(20,35,30,0.32)" : "rgba(0,0,0,0.5)");
      g.addColorStop(0.45, "rgba(0,0,0,0)");
      g.addColorStop(0.72, "rgba(255,255,255,0)");
      g.addColorStop(1, light ? "rgba(255,255,255,0.55)" : "rgba(210,225,255,0.4)");
      c.lineWidth = Math.max(1.2, r * 0.22);
      c.strokeStyle = g;
      c.beginPath();
      c.ellipse(cx, cy, rx - c.lineWidth / 2, ry - c.lineWidth / 2, 0, 0, Math.PI * 2);
      c.stroke();
      c.restore();

      // Specular highlight.
      const hx = cx - rx * 0.36;
      const hy = cy - ry * 0.42;
      const hr = Math.max(1.5, rx * 0.3);
      const hg = c.createRadialGradient(hx, hy, 0, hx, hy, hr);
      hg.addColorStop(0, "rgba(255,255,255,0.95)");
      hg.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = hg;
      c.beginPath();
      c.arc(hx, hy, hr, 0, Math.PI * 2);
      c.fill();
    }

    // one scratch canvas renders every sprite; transferToImageBitmap() hands the pixels over as a texture
    const scratch = new OffscreenCanvas(64, 64);
    const sctx = scratch.getContext("2d")!;

    /** (Re)renders a drop's sprite when it has moved / changed enough to notice. */
    function bake(d: Drop) {
      const stretch = d.phase === "slide" ? 1.18 : 1.1;
      const w = Math.ceil((d.r * 1.28 * 2 + 6) / 4) * 4;
      const h = Math.ceil((d.r * stretch * 1.28 * 2 + 6) / 4) * 4;
      const pw = Math.ceil(w * dpr);
      const ph = Math.ceil(h * dpr);
      if (scratch.width !== pw || scratch.height !== ph) {
        scratch.width = pw;
        scratch.height = ph;
      }
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, w, h);
      paintDrop(sctx, w / 2, h / 2, d.r, stretch, d.x, d.y);
      d.sprite?.close();
      d.sprite = scratch.transferToImageBitmap();
      d.sw = w;
      d.sh = h;
      d.bx = d.x;
      d.by = d.y;
      d.br = d.r;
      d.bphase = d.phase;
      stats.bakes++;
    }

    function draw() {
      ctx!.clearRect(0, 0, W, H);
      ctx!.drawImage(layer, 0, 0, W, H);
      // pieces of tracks that are still growing
      for (const t of trails) if (t.active) for (const c of t.chunks) ctx!.drawImage(c.bmp, c.x, c.y, c.w, c.h);
      // the newest points of a growing track are stroked live so they stay glued to their drop
      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      for (const t of trails) if (t.active) strokeTrail(ctx!, t, 1);
      for (const d of drops) {
        if (!d.sprite || d.phase !== d.bphase || Math.abs(d.r - d.br) > REBAKE_SIZE || Math.hypot(d.x - d.bx, d.y - d.by) > REBAKE_DIST) bake(d);
        ctx!.drawImage(d.sprite!, d.x - d.sw / 2, d.y - d.sh / 2, d.sw, d.sh);
      }
    }

    function frame(t: number) {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      // drawn at the chosen rate only (a little slack for the display's own timing)
      if (t - last < 1000 / useSettingsStore.getState().rainFps - 3) return;
      const t0 = performance.now();
      const dt = Math.min((t - last) / 1000, 0.1);
      last = t;
      if (dt <= 0) return;
      step(dt);
      layerAge += dt;
      if (layerAge > LAYER_EVERY) renderLayer();
      draw();
      const cost = performance.now() - t0;
      stats.frames++;
      stats.ms += cost;
      if (cost > stats.worst) stats.worst = cost;
    }

    function start() {
      if (raf || stopped || document.hidden || coveredRef.current) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function pause() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    const onVisibility = () => (document.hidden ? pause() : start());
    const onGate = () => (document.hidden || coveredRef.current ? pause() : start());
    window.addEventListener("qg-rain-gate", onGate);

    resize();
    img.onload = () => {
      resize();
      for (const d of drops) dropSprite(d);
    };
    for (let i = 0; i < targetCount(); i++) drops.push(spawn(true));
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stopped = true;
      pause();
      for (const d of drops) dropSprite(d);
      for (const t of trails) for (const c of t.chunks) c.bmp.close();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("qg-rain-gate", onGate);
    };
  }, [enabled, theme]);

  // the Browser view covers the window: stop drawing (and resume when it is left)
  useEffect(() => {
    window.dispatchEvent(new Event("qg-rain-gate"));
  }, [covered]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full [contain:strict] [will-change:transform]" />;
}
