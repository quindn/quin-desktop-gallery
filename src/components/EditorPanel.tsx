import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DEFAULT_EDIT_PARAMS,
  cancelEditJob,
  editorFilmstrip,
  editorSourceInfo,
  extractAudio,
  extractFrame,
  getMediaFilePath,
  getMediaStreamUrl,
  startEditJob,
  type CropRect,
  type EditParams,
  type MediaListItem,
  type RemovalRegion,
  type Segment,
} from "../lib/api";
import { formatDuration } from "../lib/format";
import { seekTo } from "../lib/seek";
import { formatTime } from "../lib/timecode";
import { CropOverlay } from "./CropOverlay";
import { EditorTimeline, cutRange, keptLength, mergeTouching, normalizeParts, setEdge, splitAt } from "./EditorTimeline";

type Tab = "adjust" | "crop" | "removal";
/** A place in the single settings column ("output" holds loop / format / quality). */
type Target = Tab | "output";

const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 };
const isFullFrame = (c: CropRect) => c.x <= 0.0005 && c.y <= 0.0005 && c.w >= 0.9995 && c.h >= 0.9995;
const LOOP_COUNTS = [1, 2, 3, 5, 10, 20, 50, 100];

/** Largest centered rectangle of the given pixel aspect ratio (w/h). */
function centeredRatioCrop(ratio: number, frameW: number, frameH: number): CropRect {
  const frameRatio = frameW / frameH;
  if (ratio >= frameRatio) {
    const h = frameRatio / ratio;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = ratio / frameRatio;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}
type Tool = "rect" | "brush";
type Point = { x: number; y: number };

interface JobState {
  jobId: string;
  percent: number;
  status: "running" | "done" | "error";
  outputPath?: string;
  error?: string;
}

function useJobEvents(onProgress: (jobId: string, percent: number) => void, onDone: (jobId: string, success: boolean, outputPath?: string, error?: string) => void) {
  useEffect(() => {
    const unlistenProgress = listen<any>("edit://progress", (e) => onProgress(e.payload.job_id, e.payload.percent));
    const unlistenDone = listen<any>("edit://done", (e) =>
      onDone(e.payload.job_id, e.payload.success, e.payload.output_path, e.payload.error),
    );
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{label}</span>
      {children}
    </div>
  );
}

function ChipRow<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={`rounded-control px-2.5 py-1 text-[11.5px] transition-colors ${
            value === o.value ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EditorPanel({ item, onClose }: { item: MediaListItem; onClose: () => void }) {
  // What the video area is being used for right now (plain preview, drawing a crop, marking a watermark).
  const [tab, setTab] = useState<Tab>("adjust");
  const [open, setOpen] = useState<Record<Target, boolean>>({ adjust: true, crop: false, removal: false, output: true });
  /** Opens a section of the column, scrolls to it and — for crop / watermark — hands the video area to it. */
  function activate(target: Target) {
    setOpen((o) => ({ ...o, [target]: true }));
    if (target !== "output") setTab(target);
    requestAnimationFrame(() => document.getElementById(`ed-sec-${target}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }
  function toggleSection(target: Target) {
    const isOpen = open[target];
    const isActive = target !== "output" && tab === target;
    if (isOpen && (target === "output" || isActive || target === "adjust")) {
      setOpen((o) => ({ ...o, [target]: false }));
      if (isActive && target !== "adjust") setTab("adjust");
    } else {
      activate(target);
    }
  }
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const triedFallback = useRef(false);
  const videoSrc = fallbackUrl ?? srcUrl;
  const [params, setParams] = useState<EditParams>({ ...DEFAULT_EDIT_PARAMS });
  // --- timeline: the kept parts of the video, the playhead, playback ---
  const [duration, setDuration] = useState(item.durationMs ?? 0);
  const [fps, setFps] = useState(30);
  const [parts, setPartsState] = useState<Segment[]>([{ startMs: 0, endMs: item.durationMs ?? 0 }]);
  const [selectedPart, setSelectedPart] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [filmstrip, setFilmstrip] = useState<string | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  // every kept part becomes its own file, instead of one file with the parts joined
  const [separateFiles, setSeparateFiles] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const [quickActionMsg, setQuickActionMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [regions, setRegions] = useState<RemovalRegion[]>([]);
  const [regionMode, setRegionMode] = useState<RemovalRegion["mode"]>("inpaint");
  const [tool, setTool] = useState<Tool>("rect");
  const [brushSize, setBrushSize] = useState(26);

  // Live-drag state lives in refs, not React state: the window-level
  // mousemove/mouseup listeners below are registered once (empty deps) so
  // dragging never breaks when the cursor leaves the small video box —
  // reading React state from those closures would just see stale values
  // from mount time. State setters here only drive the visual preview.
  const draggingRef = useRef(false);
  const dragStartRef = useRef<Point | null>(null);
  const draftRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const brushPtsRef = useRef<Point[] | null>(null);
  const toolRef = useRef<Tool>(tool);
  const regionModeRef = useRef<RemovalRegion["mode"]>(regionMode);
  const brushSizeRef = useRef(brushSize);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [brushPreview, setBrushPreview] = useState<Point[] | null>(null);
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  useEffect(() => {
    regionModeRef.current = regionMode;
  }, [regionMode]);
  useEffect(() => {
    brushSizeRef.current = brushSize;
  }, [brushSize]);

  useEffect(() => {
    triedFallback.current = false;
    setFallbackUrl(null);
    getMediaStreamUrl(item.id)
      .catch(() => getMediaFilePath(item.id).then(convertFileSrc))
      .then(setSrcUrl);
  }, [item.id]);

  // Exact length and frame rate (for frame stepping), then the frame strip for the timeline.
  useEffect(() => {
    let alive = true;
    setFilmstrip(null);
    editorSourceInfo(item.id)
      .then((info) => {
        if (!alive) return;
        if (info.fps && info.fps > 0) setFps(info.fps);
        if (info.durationMs && info.durationMs > 0) adoptDuration(info.durationMs);
        return editorFilmstrip(item.id, 40).then((path) => alive && setFilmstrip(convertFileSrc(path)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  /** The real length became known: a still-untouched "whole video" part follows it. */
  function adoptDuration(ms: number) {
    setDuration((old) => {
      setPartsState((ps) => (ps.length === 1 && ps[0].startMs === 0 && (ps[0].endMs === old || ps[0].endMs === 0) ? [{ startMs: 0, endMs: ms }] : normalizeParts(ps, ms)));
      return ms;
    });
  }
  const setParts = (next: Segment[], sel?: number) => {
    setPartsState(next);
    if (sel !== undefined) setSelectedPart(sel);
  };

  function seek(ms: number) {
    const v = videoRef.current;
    const t = Math.min(Math.max(ms, 0), duration || ms);
    setCurrent(t);
    if (v) seekTo(v, t / 1000);
  }
  /** Plays with sound; if the engine refuses sound without a click, plays muted instead of not at all. */
  function playWithSound(v: HTMLVideoElement) {
    v.muted = false;
    v.play().catch(() => {
      v.muted = true;
      return v.play().catch(() => {});
    });
  }
  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      playWithSound(v);
    } else {
      v.pause();
      setPreviewing(false);
    }
  }
  function togglePreview() {
    const v = videoRef.current;
    if (!v) return;
    if (previewing) {
      setPreviewing(false);
      v.pause();
      return;
    }
    const first = parts.find((p) => current >= p.startMs && current < p.endMs - 50) ?? parts[0];
    if (!(current >= first.startMs && current < first.endMs - 50)) seek(first.startMs);
    setPreviewing(true);
    playWithSound(v);
  }

  // While playing: a smooth playhead, and in "preview result" the cut-out parts are skipped.
  const partsRef = useRef(parts);
  partsRef.current = parts;
  const previewRef = useRef(previewing);
  previewRef.current = previewing;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const t = v.currentTime * 1000;
        if (previewRef.current) {
          const ps = partsRef.current;
          const inPart = ps.find((p) => t >= p.startMs - 30 && t < p.endMs);
          if (!inPart) {
            const next = ps.find((p) => p.startMs > t);
            if (next) v.currentTime = next.startMs / 1000;
            else {
              v.pause();
              setPreviewing(false);
            }
          }
        }
        setCurrent(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Keyboard: Space, ← →, I / O, S, Delete, Home / End — not while typing in a field.
  const keyState = useRef({ current, parts, selectedPart, duration, fps, range });
  keyState.current = { current, parts, selectedPart, duration, fps, range };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const k = keyState.current;
      const frame = 1000 / (k.fps || 30);
      const sel = k.parts[Math.min(k.selectedPart, k.parts.length - 1)];
      let handled = true;
      switch (e.key) {
        case " ":
          togglePlay();
          break;
        case "ArrowLeft":
          seek(k.current - (e.shiftKey ? 1000 : frame));
          break;
        case "ArrowRight":
          seek(k.current + (e.shiftKey ? 1000 : frame));
          break;
        case "Home":
          seek(sel?.startMs ?? 0);
          break;
        case "End":
          seek(sel?.endMs ?? k.duration);
          break;
        case "i":
        case "I":
          setParts(setEdge(k.parts, k.selectedPart, "start", k.current, k.duration, true), k.selectedPart);
          break;
        case "o":
        case "O":
          setParts(setEdge(k.parts, k.selectedPart, "end", k.current, k.duration, true), k.selectedPart);
          break;
        case "s":
        case "S": {
          const r = splitAt(k.parts, k.current);
          if (r) setParts(r.parts, r.index);
          break;
        }
        case "[":
          setRange({ from: k.current, to: Math.max(k.current, k.range?.to ?? k.current) });
          break;
        case "]":
          setRange({ from: Math.min(k.current, k.range?.from ?? k.current), to: k.current });
          break;
        case "x":
        case "X":
          if (k.range && k.range.to - k.range.from >= 100) {
            const next = cutRange(k.parts, k.range.from, k.range.to);
            if (next.length) {
              setParts(next, Math.min(k.selectedPart, next.length - 1));
              setRange(null);
            }
          }
          break;
        case "Delete":
        case "Backspace":
          if (k.parts.length > 1) {
            const next = k.parts.filter((_, j) => j !== k.selectedPart);
            setParts(next, Math.min(k.selectedPart, next.length - 1));
          }
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The direct asset:// URL for an original file has, in practice, failed
  // to load for some files (network error, not a codec/decode problem —
  // confirmed via the video element's own reported state) even though the
  // file is well within the sandboxed root. Viewer.tsx already has a
  // reliable recovery for exactly this: re-encode/remux through ffmpeg
  // into the app's own statically-scoped playback cache and play that
  // instead. Reusing it here instead of chasing the asset-protocol issue
  // itself fixes the actual symptom immediately.
  async function handleVideoError() {
    if (triedFallback.current) return;
    triedFallback.current = true;
    try {
      const path = await invoke<string>("prepare_video_playback", { id: item.id });
      setFallbackUrl(convertFileSrc(path));
    } catch {
      // Leaves videoSrc pointing at the original URL.
    }
  }

  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = job?.jobId ?? null;
  useJobEvents(
    (jobId, percent) =>
      setJob((j) => {
        if (j?.jobId !== jobId) return j;
        // several files: one bar over all of them
        const n = totalFilesRef.current;
        const overall = n > 1 ? ((doneFilesRef.current.length + percent / 100) / n) * 100 : percent;
        return { ...j, percent: overall };
      }),
    (jobId, success, outputPath, error) => {
      if (jobId !== jobIdRef.current) return;
      if (success && outputPath) doneFilesRef.current.push(outputPath);
      const next = success ? queueRef.current.shift() : undefined;
      if (next) {
        void startOne(next);
        return;
      }
      const files = doneFilesRef.current;
      setJob((j) =>
        j?.jobId === jobId
          ? {
              ...j,
              status: success ? "done" : "error",
              outputPath: files.length > 1 ? `${files.length} files: ${files.map((f) => f.split(/[\\/]/).pop()).join(", ")}` : outputPath,
              error,
              percent: 100,
            }
          : j,
      );
    },
  );

  const kept = mergeTouching(parts);
  const single = kept.length === 1 ? kept[0] : null;
  const trimmed = !single || single.startMs > 0 || single.endMs < duration - 1;

  // Separate files: the parts are exported one after another; `queue` holds the ones still to go.
  const queueRef = useRef<EditParams[]>([]);
  const doneFilesRef = useRef<string[]>([]);
  const totalFilesRef = useRef(1);
  async function startOne(p: EditParams) {
    try {
      const result = await startEditJob(item.id, p);
      setJob({ jobId: result.jobId, percent: result.streamCopy ? 90 : 0, status: "running" });
    } catch (e) {
      queueRef.current = [];
      setJob({ jobId: "", percent: 0, status: "error", error: String(e) });
    }
  }
  async function handleExport() {
    const base: EditParams = { ...params, removal: regions };
    if (separateFiles && kept.length > 1) {
      // timed watermark windows refer to the source timeline, which each single-range export keeps
      queueRef.current = kept.map((s) => ({ ...base, trimStartMs: s.startMs > 0 ? s.startMs : null, trimEndMs: s.endMs < duration - 1 ? s.endMs : null, segments: [] }));
      totalFilesRef.current = kept.length;
      doneFilesRef.current = [];
      await startOne(queueRef.current.shift()!);
      return;
    }
    queueRef.current = [];
    totalFilesRef.current = 1;
    doneFilesRef.current = [];
    await startOne({
      ...base,
      trimStartMs: single && single.startMs > 0 ? single.startMs : null,
      trimEndMs: single && single.endMs < duration - 1 ? single.endMs : null,
      segments: single ? [] : kept,
    });
  }

  const crop = params.crop ?? FULL_FRAME;
  const setCrop = (r: CropRect) => setParams((p) => ({ ...p, crop: isFullFrame(r) ? null : r }));
  const cropPx = {
    x: Math.round(crop.x * videoSize.w),
    y: Math.round(crop.y * videoSize.h),
    w: Math.round(crop.w * videoSize.w),
    h: Math.round(crop.h * videoSize.h),
  };
  function setCropPx(field: "x" | "y" | "w" | "h", value: number) {
    if (!videoSize.w || !videoSize.h || !Number.isFinite(value)) return;
    const MIN_FRAC = 0.03;
    const next = { ...crop };
    if (field === "x") {
      next.x = Math.min(Math.max(value / videoSize.w, 0), 1 - MIN_FRAC);
      next.w = Math.min(next.w, 1 - next.x);
    }
    if (field === "y") {
      next.y = Math.min(Math.max(value / videoSize.h, 0), 1 - MIN_FRAC);
      next.h = Math.min(next.h, 1 - next.y);
    }
    if (field === "w") next.w = Math.min(Math.max(value / videoSize.w, MIN_FRAC), 1 - next.x);
    if (field === "h") next.h = Math.min(Math.max(value / videoSize.h, MIN_FRAC), 1 - next.y);
    setCrop(next);
  }

  const edits: EditSummary[] = [];
  if (trimmed) {
    edits.push({
      key: "trim",
      label: single ? `Trim ${formatTime(single.startMs, false)}–${formatTime(single.endMs, false)}` : `Cut: ${kept.length} parts · ${formatTime(keptLength(kept), false)}`,
      tab: "adjust",
    });
  }
  if (params.crop) edits.push({ key: "crop", label: `Crop ${cropPx.w}×${cropPx.h}`, tab: "crop" });
  else if (params.aspect !== "original") edits.push({ key: "aspect", label: `Aspect ${params.aspect}`, tab: "adjust" });
  if (regions.length > 0) edits.push({ key: "wm", label: `Remove watermark ×${regions.length}`, tab: "removal" });
  if (params.rotate !== 0) edits.push({ key: "rot", label: `Rotate ${params.rotate}°`, tab: "adjust" });
  if (params.flipH || params.flipV) {
    edits.push({ key: "flip", label: `Flip ${[params.flipH && "H", params.flipV && "V"].filter(Boolean).join("+")}`, tab: "adjust" });
  }
  if (params.targetWidth) edits.push({ key: "resize", label: `Resize ${params.targetWidth}px`, tab: "adjust" });
  if (params.speed !== 1) edits.push({ key: "speed", label: `Speed ${params.speed.toFixed(2)}×`, tab: "adjust" });
  if (params.brightness !== 0 || params.contrast !== 1 || params.saturation !== 1) {
    edits.push({ key: "color", label: "Color", tab: "adjust" });
  }
  if (params.mute) edits.push({ key: "mute", label: "Mute", tab: "adjust" });
  if (params.loopPingpong) edits.push({ key: "loop", label: `Loop ${params.loopCount}×`, tab: "output" });
  if (params.format !== "source") edits.push({ key: "format", label: params.format.toUpperCase(), tab: "output" });
  if (params.quality !== "high") edits.push({ key: "quality", label: `Quality ${params.quality}`, tab: "output" });
  const adjustCount = edits.filter((e) => e.tab === "adjust").length;

  const rangeMs = keptLength(kept);
  const loopCycleMs = (rangeMs / params.speed) * 2;
  const loopTotalMs = loopCycleMs * params.loopCount;

  async function handleCancel() {
    if (job) {
      await cancelEditJob(job.jobId);
      setJob(null);
    }
  }

  async function handleExtractFrame() {
    const t = videoRef.current?.currentTime ?? 0;
    try {
      const path = await extractFrame(item.id, Math.round(t * 1000));
      setQuickActionMsg(`Frame saved: ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setQuickActionMsg(String(e));
    }
  }

  async function handleExtractAudio() {
    try {
      const path = await extractAudio(item.id);
      setQuickActionMsg(`Audio saved: ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setQuickActionMsg(String(e));
    }
  }

  // A freshly loaded <video> with no autoplay stays fully black in WebView2
  // until something actually plays it, so this element uses the native
  // `autoPlay` attribute and pauses itself on the `playing` event (the one
  // event that specifically means "a frame is now actually being
  // rendered"). That alone wasn't enough, though: `muted` was passed as a
  // plain JSX attribute, and React doesn't reliably sync that particular
  // boolean prop to the live DOM property in time for the browser's
  // autoplay-permission check (unmuted autoplay is blocked, silently — no
  // error, playback just never starts, so `playing` never fires and the
  // frame stays black). Setting `.muted` imperatively, like Viewer.tsx
  // already does successfully, sidesteps that timing gap entirely.
  const pausedOnceRef = useRef(false);
  useLayoutEffect(() => {
    pausedOnceRef.current = false;
    if (videoRef.current) videoRef.current.muted = true;
  }, [videoSrc]);
  function handleLoadedMetadata() {
    const v = videoRef.current;
    if (v) {
      setVideoSize({ w: v.videoWidth, h: v.videoHeight });
      if (!duration && Number.isFinite(v.duration) && v.duration > 0) adoptDuration(Math.round(v.duration * 1000));
    }
  }
  function handlePlaying() {
    if (!pausedOnceRef.current) {
      // the first, silent autoplay only exists to get a picture on screen
      pausedOnceRef.current = true;
      videoRef.current?.pause();
      return;
    }
    setPlaying(true);
  }
  function handleTimeUpdate() {
    const v = videoRef.current;
    if (v && v.paused) setCurrent(v.currentTime * 1000);
  }

  // --- Region drawing (watermark/object removal tab) ---
  function toSourceCoords(clientX: number, clientY: number) {
    const video = videoRef.current;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!video || !rect || !video.videoWidth) return null;
    const scaleX = video.videoWidth / rect.width;
    const scaleY = video.videoHeight / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  function finalizeRect(d: { x: number; y: number; w: number; h: number }) {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const x0 = Math.max(0, Math.min(d.x, vw));
    const y0 = Math.max(0, Math.min(d.y, vh));
    const x1 = Math.max(0, Math.min(d.x + d.w, vw));
    const y1 = Math.max(0, Math.min(d.y + d.h, vh));
    const w = Math.round(x1 - x0);
    const h = Math.round(y1 - y0);
    if (w < 8 || h < 8) return;
    setRegions((prev) => [
      ...prev,
      {
        mode: regionModeRef.current,
        x: Math.round(x0),
        y: Math.round(y0),
        w,
        h,
        startMs: null,
        endMs: null,
        color: regionModeRef.current === "cover" ? "#000000" : null,
        mask: null,
      },
    ]);
  }

  function finalizeBrush(pts: Point[]) {
    const video = videoRef.current;
    if (!video || !video.videoWidth || pts.length === 0) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const r = brushSizeRef.current;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x - r);
      minY = Math.min(minY, p.y - r);
      maxX = Math.max(maxX, p.x + r);
      maxY = Math.max(maxY, p.y + r);
    }
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(vw, Math.ceil(maxX));
    const y1 = Math.min(vh, Math.ceil(maxY));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 4 || h < 4) return;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = r * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach((p, i) => {
      const lx = p.x - x0;
      const ly = p.y - y0;
      if (i === 0) ctx.moveTo(lx, ly);
      else ctx.lineTo(lx, ly);
    });
    ctx.stroke();
    // Also stamp the first point as a filled dot, so a single click (no
    // drag) still paints something instead of an invisible zero-length line.
    ctx.beginPath();
    ctx.arc(pts[0].x - x0, pts[0].y - y0, r, 0, Math.PI * 2);
    ctx.fill();

    const data = ctx.getImageData(0, 0, w, h).data;
    const mask: number[] = new Array(w * h);
    for (let i = 0; i < w * h; i++) {
      mask[i] = data[i * 4 + 3] > 10 ? 1 : 0;
    }

    setRegions((prev) => [
      ...prev,
      {
        mode: regionModeRef.current,
        x: x0,
        y: y0,
        w,
        h,
        startMs: null,
        endMs: null,
        color: regionModeRef.current === "cover" ? "#000000" : null,
        mask,
      },
    ]);
  }

  function onStageMouseDown(e: ReactMouseEvent) {
    const p = toSourceCoords(e.clientX, e.clientY);
    if (!p) return;
    draggingRef.current = true;
    if (toolRef.current === "rect") {
      dragStartRef.current = p;
      draftRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
      setDraft(draftRef.current);
    } else {
      brushPtsRef.current = [p];
      setBrushPreview(brushPtsRef.current);
    }
  }

  // Registered once on mount (window-level, not on the small video box) so
  // a fast drag past the video's edge keeps tracking smoothly instead of
  // freezing/"disappearing" the moment the cursor leaves that little box —
  // the bug reported with the old per-element mousemove/mouseup handlers.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const p = toSourceCoords(e.clientX, e.clientY);
      if (!p) return;
      if (toolRef.current === "rect") {
        const start = dragStartRef.current;
        if (!start) return;
        const next = {
          x: Math.min(start.x, p.x),
          y: Math.min(start.y, p.y),
          w: Math.abs(p.x - start.x),
          h: Math.abs(p.y - start.y),
        };
        draftRef.current = next;
        setDraft(next);
      } else {
        const pts = brushPtsRef.current;
        if (!pts) return;
        const last = pts[pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < brushSizeRef.current * 0.35) return;
        const next = [...pts, p];
        brushPtsRef.current = next;
        setBrushPreview(next);
      }
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (toolRef.current === "rect") {
        if (draftRef.current) finalizeRect(draftRef.current);
        dragStartRef.current = null;
        draftRef.current = null;
        setDraft(null);
      } else {
        if (brushPtsRef.current) finalizeBrush(brushPtsRef.current);
        brushPtsRef.current = null;
        setBrushPreview(null);
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overlayScale = useMemo(() => {
    const video = videoRef.current;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!video || !rect || !video.videoWidth) return { x: 1, y: 1 };
    return { x: rect.width / video.videoWidth, y: rect.height / video.videoHeight };
  }, [videoSrc, draft, brushPreview]);

  return (
    // top-9, not inset-0: keeps the window's own title bar (minimize/
    // maximize/close — frameless window, no native OS chrome) reachable
    // while the editor is open full-screen.
    <div className="fixed inset-x-0 top-9 bottom-0 z-[120] flex flex-col bg-black">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/10 px-4">
        <span className="text-[13px] font-medium text-white/90">Edit — {item.filename}</span>
        <div className="flex-1" />
        <button onClick={onClose} className="text-white/60 hover:text-white">
          ✕ Close
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5"
          onMouseDown={tab === "removal" ? onStageMouseDown : undefined}
          style={tab === "removal" ? { cursor: "crosshair" } : undefined}
        >
          <div ref={overlayRef} className="relative max-h-[48vh] max-w-full">
            {videoSrc && (
              <video
                key={videoSrc}
                ref={videoRef}
                src={videoSrc}
                autoPlay
                playsInline
                onLoadedMetadata={handleLoadedMetadata}
                onPlaying={handlePlaying}
                onTimeUpdate={handleTimeUpdate}
                onError={handleVideoError}
                onPause={() => setPlaying(false)}
                onClick={() => tab === "adjust" && togglePlay()}
                className="block max-h-[48vh] max-w-full rounded-lg"
                style={
                  tab === "adjust"
                    ? {
                        filter: `brightness(${1 + params.brightness}) contrast(${params.contrast}) saturate(${params.saturation})`,
                        transform: `scale(${params.flipH ? -1 : 1}, ${params.flipV ? -1 : 1})`,
                      }
                    : undefined
                }
              />
            )}
            {tab === "crop" && videoSize.w > 0 && <CropOverlay value={crop} onChange={setCrop} />}
            {tab === "removal" && (
              <div className="pointer-events-none absolute inset-0">
                {regions.map((r, i) => (
                  <div
                    key={i}
                    className={`absolute border-2 bg-accent/20 ${r.mask ? "border-dashed border-accent" : "border-accent"}`}
                    style={{
                      left: r.x * overlayScale.x,
                      top: r.y * overlayScale.y,
                      width: r.w * overlayScale.x,
                      height: r.h * overlayScale.y,
                    }}
                  />
                ))}
                {draft && (
                  <div
                    className="absolute border-2 border-dashed border-white/80"
                    style={{
                      left: draft.x * overlayScale.x,
                      top: draft.y * overlayScale.y,
                      width: draft.w * overlayScale.x,
                      height: draft.h * overlayScale.y,
                    }}
                  />
                )}
                {brushPreview && brushPreview.length > 0 && (
                  <svg className="absolute inset-0 h-full w-full overflow-visible">
                    <polyline
                      points={brushPreview.map((p) => `${p.x * overlayScale.x},${p.y * overlayScale.y}`).join(" ")}
                      fill="none"
                      stroke="rgba(255,255,255,0.75)"
                      strokeWidth={brushSize * overlayScale.x * 2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
            <span className="text-[11px] text-white/40">On the video:</span>
            {(
              [
                ["adjust", "Preview"],
                ["crop", "Crop (free)"],
                ["removal", "Mark watermark"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => (t === "adjust" ? setTab("adjust") : activate(t))}
                className={`rounded-control px-2.5 py-1 text-[11px] transition-colors ${tab === t ? "bg-accent text-white" : "bg-white/10 text-white/80 hover:bg-white/15"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "adjust" && (
            <div className="flex items-center gap-2">
              <button onClick={handleExtractFrame} className="rounded-control bg-white/10 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/15">
                Extract Frame at Playhead
              </button>
              <button onClick={handleExtractAudio} className="rounded-control bg-white/10 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/15">
                Extract Audio
              </button>
              {quickActionMsg && <span className="text-[11px] text-white/50">{quickActionMsg}</span>}
            </div>
          )}
          {tab === "removal" && (
            <p className="text-[11px] text-white/40">
              Drag anywhere in this area — the selection isn't clipped to the video's edges. Use the timeline below to
              find the frame where the watermark is visible.
            </p>
          )}
        </div>

        {duration > 0 && (
          <EditorTimeline
            duration={duration}
            fps={fps}
            current={current}
            playing={playing}
            parts={parts}
            selected={Math.min(selectedPart, parts.length - 1)}
            filmstrip={filmstrip}
            previewing={previewing}
            onSeek={seek}
            onTogglePlay={togglePlay}
            onPreview={togglePreview}
            onParts={setParts}
            onSelect={setSelectedPart}
            range={range}
            onRange={setRange}
          />
        )}
        </div>

        <div className="flex w-80 shrink-0 flex-col border-l border-white/10">
          <div className="flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-3">
            <Section id="adjust" title="Adjust" badge={adjustCount || undefined} open={open.adjust} active={tab === "adjust"} onToggle={() => toggleSection("adjust")}>
            <div className="flex flex-col gap-4">
              <p className="text-[11px] leading-relaxed text-text-tertiary">
                Cut and trim on the timeline under the video: type exact times or drag the part edges. Several parts can be kept — the rest is cut out and they are joined.
              </p>

              <Field label="Rotate">
                <ChipRow
                  options={[
                    { value: 0, label: "0°" },
                    { value: 90, label: "90°" },
                    { value: 180, label: "180°" },
                    { value: 270, label: "270°" },
                  ]}
                  value={params.rotate}
                  onChange={(rotate) => setParams((p) => ({ ...p, rotate: rotate as EditParams["rotate"] }))}
                />
              </Field>

              <Field label="Flip">
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setParams((p) => ({ ...p, flipH: !p.flipH }))}
                    className={`rounded-control px-2.5 py-1 text-[11.5px] ${params.flipH ? "bg-accent text-white" : "bg-card text-text-secondary"}`}
                  >
                    Horizontal
                  </button>
                  <button
                    onClick={() => setParams((p) => ({ ...p, flipV: !p.flipV }))}
                    className={`rounded-control px-2.5 py-1 text-[11.5px] ${params.flipV ? "bg-accent text-white" : "bg-card text-text-secondary"}`}
                  >
                    Vertical
                  </button>
                </div>
              </Field>

              <Field label={params.crop ? "Aspect Ratio (overridden by the free crop)" : "Aspect Ratio (centre crop)"}>
                <ChipRow
                  options={[
                    { value: "original", label: "Original" },
                    { value: "1:1", label: "1:1" },
                    { value: "16:9", label: "16:9" },
                    { value: "9:16", label: "9:16" },
                    { value: "4:3", label: "4:3" },
                  ]}
                  value={params.aspect}
                  onChange={(aspect) => setParams((p) => ({ ...p, aspect: aspect as EditParams["aspect"] }))}
                />
              </Field>

              <Field label="Resize (width)">
                <ChipRow
                  options={[
                    { value: 0, label: "Original" },
                    { value: 3840, label: "4K" },
                    { value: 1920, label: "1080p" },
                    { value: 1280, label: "720p" },
                    { value: 854, label: "480p" },
                  ]}
                  value={params.targetWidth ?? 0}
                  onChange={(w) => setParams((p) => ({ ...p, targetWidth: w === 0 ? null : (w as number) }))}
                />
              </Field>

              <Field label="Speed">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0.25}
                    max={4}
                    step={0.05}
                    value={params.speed}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v > 0) setParams((p) => ({ ...p, speed: Math.min(4, Math.max(0.25, v)) }));
                    }}
                    className="w-20 rounded-control bg-card px-2 py-1 text-right text-[12px] tabular-nums text-text-primary outline-none"
                  />
                  <span className="text-[11px] text-text-tertiary">× (0.25 – 4)</span>
                </div>
                <input
                  type="range"
                  min={0.25}
                  max={4}
                  step={0.05}
                  value={params.speed}
                  onChange={(e) => setParams((p) => ({ ...p, speed: Number(e.target.value) }))}
                  className="w-full accent-[#0A84FF]"
                />
              </Field>

              <Field label="Audio">
                <button
                  onClick={() => setParams((p) => ({ ...p, mute: !p.mute }))}
                  className={`rounded-control px-2.5 py-1 text-[11.5px] ${params.mute ? "bg-accent text-white" : "bg-card text-text-secondary"}`}
                >
                  {params.mute ? "Muted" : "Mute Audio"}
                </button>
              </Field>

              <Field label={`Brightness (${params.brightness.toFixed(2)})`}>
                <input
                  type="range"
                  min={-0.5}
                  max={0.5}
                  step={0.02}
                  value={params.brightness}
                  onChange={(e) => setParams((p) => ({ ...p, brightness: Number(e.target.value) }))}
                  className="w-full accent-[#0A84FF]"
                />
              </Field>
              <Field label={`Contrast (${params.contrast.toFixed(2)})`}>
                <input
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.02}
                  value={params.contrast}
                  onChange={(e) => setParams((p) => ({ ...p, contrast: Number(e.target.value) }))}
                  className="w-full accent-[#0A84FF]"
                />
              </Field>
              <Field label={`Saturation (${params.saturation.toFixed(2)})`}>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.02}
                  value={params.saturation}
                  onChange={(e) => setParams((p) => ({ ...p, saturation: Number(e.target.value) }))}
                  className="w-full accent-[#0A84FF]"
                />
              </Field>
            </div>
            </Section>
            <Section id="crop" title="Crop" badge={params.crop ? "●" : undefined} open={open.crop} active={tab === "crop"} onToggle={() => toggleSection("crop")}>
            <div className="flex flex-col gap-4">
              <p className="text-[11px] leading-relaxed text-text-tertiary">
                Free crop: drag any corner or edge handle to move that side on its own, drag inside the box to move it, or drag on the dimmed area to draw a new box. Everything you
                set in the other sections (trim, rotate, watermark, loop…) is exported together with it — use the button
                at the bottom. The crop is placed on the original frame; rotation is applied after it.
              </p>

              <Field label="Presets">
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { label: "Full frame", ratio: 0 },
                    { label: "1:1", ratio: 1 },
                    { label: "16:9", ratio: 16 / 9 },
                    { label: "9:16", ratio: 9 / 16 },
                    { label: "4:3", ratio: 4 / 3 },
                  ].map((pr) => (
                    <button
                      key={pr.label}
                      onClick={() =>
                        setCrop(pr.ratio === 0 || !videoSize.w ? FULL_FRAME : centeredRatioCrop(pr.ratio, videoSize.w, videoSize.h))
                      }
                      className="rounded-control bg-card px-2.5 py-1 text-[11.5px] text-text-secondary hover:bg-card-hover hover:text-text-primary"
                    >
                      {pr.label}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Position & size (px)">
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["x", "X"],
                      ["y", "Y"],
                      ["w", "Width"],
                      ["h", "Height"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 rounded-control bg-card px-2 py-1 text-[11px] text-text-tertiary">
                      <span className="w-9 shrink-0">{label}</span>
                      <input
                        type="number"
                        value={cropPx[key]}
                        min={0}
                        onChange={(e) => setCropPx(key, Number(e.target.value))}
                        className="w-full bg-transparent text-right text-[12px] tabular-nums text-text-primary outline-none"
                      />
                    </label>
                  ))}
                </div>
                <span className="text-[11px] text-text-tertiary">
                  Output: {cropPx.w - (cropPx.w % 2)} × {cropPx.h - (cropPx.h % 2)} px (source {videoSize.w} × {videoSize.h})
                </span>
              </Field>

              <button
                onClick={() => setCrop(FULL_FRAME)}
                disabled={!params.crop}
                className="rounded-control bg-card px-3 py-1.5 text-[12px] text-text-secondary hover:bg-card-hover disabled:opacity-40"
              >
                Reset crop
              </button>
            </div>
            </Section>
            <Section id="removal" title="Watermark" badge={regions.length || undefined} open={open.removal} active={tab === "removal"} onToggle={() => toggleSection("removal")}>
            <div className="flex flex-col gap-4">
              <Field label="Tool">
                <ChipRow
                  options={[
                    { value: "rect", label: "Rectangle" },
                    { value: "brush", label: "Brush" },
                  ]}
                  value={tool}
                  onChange={setTool}
                />
                <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
                  {tool === "rect"
                    ? "Drag to draw a box. Fastest for a clean logo/watermark shape."
                    : "Paint directly over the watermark — only the painted pixels are affected, so it can hug an odd shape or a logo over a busy background more tightly than a box."}
                </p>
              </Field>

              {tool === "brush" && (
                <Field label={`Brush Size (${brushSize}px)`}>
                  <input
                    type="range"
                    min={8}
                    max={80}
                    step={2}
                    value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                    className="w-full accent-[#0A84FF]"
                  />
                </Field>
              )}

              <Field label="New Region Mode">
                <ChipRow
                  options={[
                    { value: "inpaint", label: "Auto Remove" },
                    { value: "blur", label: "Blur" },
                    { value: "pixelate", label: "Pixelate" },
                    { value: "cover", label: "Cover" },
                  ]}
                  value={regionMode}
                  onChange={setRegionMode}
                />
                <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">
                  {regionMode === "inpaint" &&
                    "Reconstructs the area pixel-by-pixel from what's around it, frame by frame — no trace of a box left behind. Best on simple or gently textured backgrounds; heavily detailed backgrounds fill in smooth rather than reproducing the detail."}
                  {regionMode === "blur" && "Softens the region. Works on any background, but stays visibly blurred."}
                  {regionMode === "pixelate" && "Mosaics the region. Works on any background, visibly pixelated."}
                  {regionMode === "cover" && "Fills the region with a solid color — total coverage, fully opaque."}
                </p>
              </Field>

              <Field label={`Regions (${regions.length})`}>
                <div className="flex flex-col gap-1.5">
                  {regions.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-control bg-card px-2 py-1.5 text-[11.5px] text-text-secondary">
                      <span className="flex-1">
                        {r.mode} {r.mask ? "(brush)" : "(rect)"} · {r.w}×{r.h}
                      </span>
                      <button onClick={() => setRegions((prev) => prev.filter((_, j) => j !== i))} className="text-red-400">
                        Remove
                      </button>
                    </div>
                  ))}
                  {regions.length === 0 && <span className="text-[11px] text-text-tertiary">No regions yet.</span>}
                </div>
              </Field>
            </div>
            </Section>
            <Section id="output" title="Loop & Output" badge={(params.loopPingpong ? 1 : 0) + (params.format !== "source" ? 1 : 0) || undefined} open={open.output} active={false} onToggle={() => toggleSection("output")}>
            <div className="flex flex-col gap-4">
              <Field label="Loop">
                <ChipRow
                  options={[
                    { value: "off", label: "Off" },
                    { value: "pingpong", label: "Original + Reversed" },
                  ]}
                  value={params.loopPingpong ? "pingpong" : "off"}
                  onChange={(v) => setParams((p) => ({ ...p, loopPingpong: v === "pingpong" }))}
                />
                {params.loopPingpong && (
                  <div className="mt-2 flex flex-col gap-2">
                    <span className="text-[11px] text-text-tertiary">Repeat the forward + backward cycle</span>
                    <ChipRow
                      options={LOOP_COUNTS.map((n) => ({ value: n, label: `${n}×` }))}
                      value={params.loopCount}
                      onChange={(loopCount) => setParams((p) => ({ ...p, loopCount }))}
                    />
                    <label className="flex items-center gap-2 rounded-control bg-card px-2 py-1 text-[11px] text-text-tertiary">
                      <span className="shrink-0">Custom</span>
                      <input
                        type="number"
                        min={1}
                        max={9999}
                        value={params.loopCount}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, loopCount: Math.min(9999, Math.max(1, Math.round(Number(e.target.value) || 1))) }))
                        }
                        className="w-full bg-transparent text-right text-[12px] tabular-nums text-text-primary outline-none"
                      />
                      <span className="shrink-0">cycles</span>
                    </label>
                    <span className="text-[11px] leading-relaxed text-text-tertiary">
                      One cycle ≈ {formatDuration(loopCycleMs)} · Output ≈ {formatDuration(loopTotalMs)}. Repeats are copied
                      without re-encoding, so 100× costs about the same as 1×. Long or large clips are reversed in pieces,
                      so the length does not matter (it just takes a little longer). Audio is reversed too unless muted.
                    </span>
                  </div>
                )}
              </Field>

              <Field label="Format">
                <ChipRow
                  options={[
                    { value: "source", label: "Keep Container" },
                    { value: "mp4", label: "MP4" },
                    { value: "webm", label: "WebM" },
                  ]}
                  value={params.format}
                  onChange={(format) => setParams((p) => ({ ...p, format: format as EditParams["format"] }))}
                />
              </Field>
              <Field label="Quality">
                <ChipRow
                  options={[
                    { value: "high", label: "High" },
                    { value: "medium", label: "Medium" },
                    { value: "compressed", label: "Compressed" },
                  ]}
                  value={params.quality}
                  onChange={(quality) => setParams((p) => ({ ...p, quality: quality as EditParams["quality"] }))}
                />
              </Field>

              {kept.length > 1 && (
                <label className="flex items-start gap-2 rounded-control bg-card px-2.5 py-2 text-[11.5px] text-text-secondary">
                  <input type="checkbox" data-testid="separate-files" checked={separateFiles} onChange={(e) => setSeparateFiles(e.target.checked)} className="mt-0.5" />
                  <span>
                    Save each of the {kept.length} parts as its own file
                    <span className="block text-[10.5px] text-text-tertiary">instead of joining them into one</span>
                  </span>
                </label>
              )}

              <Field label="Cut Accuracy">
                <button
                  onClick={() => setParams((p) => ({ ...p, accurateCut: !p.accurateCut }))}
                  className={`rounded-control px-2.5 py-1 text-[11.5px] ${params.accurateCut ? "bg-accent text-white" : "bg-card text-text-secondary"}`}
                >
                  {params.accurateCut ? "Accurate Cut (re-encodes)" : "Fast Cut (keyframe-snapped)"}
                </button>
              </Field>

              <label className="flex items-center gap-2 text-[11.5px] text-amber-300">
                <input
                  type="checkbox"
                  checked={params.replaceOriginal}
                  onChange={(e) => setParams((p) => ({ ...p, replaceOriginal: e.target.checked }))}
                />
                Replace original file
              </label>
            </div>
            </Section>
          </div>
          </div>

          <ExportFooter edits={edits} job={job} onCancel={handleCancel} onExport={handleExport} onPickTab={activate} />
        </div>
      </div>
    </div>
  );
}

interface EditSummary {
  key: string;
  label: string;
  tab: Target;
}

/** One block of the settings column. Clicking its header opens it; Crop and Watermark also take over the video area. */
function Section({
  id,
  title,
  badge,
  open,
  active,
  onToggle,
  children,
}: {
  id: Target;
  title: string;
  badge?: string | number;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div id={`ed-sec-${id}`} className={`rounded-card border transition-colors ${active ? "border-accent/60 bg-accent/[0.06]" : "border-white/10 bg-white/[0.03]"}`}>
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <span className="text-[12px] font-medium text-white/90">{title}</span>
        {badge !== undefined && <span className="rounded-full bg-accent/30 px-1.5 py-px text-[10px] font-medium text-white">{badge}</span>}
        <span className="flex-1" />
        {active && id !== "adjust" && <span className="text-[10px] text-accent">editing on the video</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`text-white/50 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && <div className="border-t border-white/10 p-3">{children}</div>}
    </div>
  );
}

/** One place to see everything that will be applied, and the single Export. */
function ExportFooter({
  edits,
  job,
  onCancel,
  onExport,
  onPickTab,
}: {
  edits: EditSummary[];
  job: JobState | null;
  onCancel: () => void;
  onExport: () => void;
  onPickTab: (t: Target) => void;
}) {
  const running = job?.status === "running";
  return (
    <div className="flex shrink-0 flex-col gap-2.5 border-t border-white/10 bg-black/40 p-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
          This export includes
        </span>
        {edits.length === 0 ? (
          <span className="text-[11.5px] text-text-tertiary">Nothing yet — trim, crop, rotate, remove a watermark…</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {edits.map((e) => (
              <button
                key={e.key}
                onClick={() => onPickTab(e.tab)}
                className="rounded-full bg-accent/20 px-2.5 py-1 text-[11px] text-white/85 hover:bg-accent/35"
              >
                {e.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <JobStatus job={job} onCancel={onCancel} />
      <button
        onClick={onExport}
        disabled={running || edits.length === 0}
        className="rounded-control bg-accent px-3 py-2.5 text-[13px] font-medium text-white transition-opacity disabled:opacity-40"
      >
        {running ? "Exporting…" : edits.length > 1 ? `Export all ${edits.length} edits` : "Export"}
      </button>
    </div>
  );
}

function JobStatus({ job, onCancel }: { job: JobState | null; onCancel: () => void }) {
  if (!job) return null;
  if (job.status === "running") {
    return (
      <div className="flex flex-col gap-1.5 rounded-control bg-card px-3 py-2">
        <div className="flex items-center justify-between text-[11px] text-text-secondary">
          <span>Exporting… {Math.round(job.percent)}%</span>
          <button onClick={onCancel} className="text-red-400">
            Cancel
          </button>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-accent transition-all" style={{ width: `${job.percent}%` }} />
        </div>
      </div>
    );
  }
  if (job.status === "done") {
    return (
      <div className="rounded-control bg-emerald-500/15 px-3 py-2 text-[11px] text-emerald-300">
        Done — saved as {job.outputPath?.split(/[\\/]/).pop()}
      </div>
    );
  }
  return <div className="rounded-control bg-red-500/15 px-3 py-2 text-[11px] text-red-400">Failed: {job.error}</div>;
}
