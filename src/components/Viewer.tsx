import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject, type WheelEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { MediaListItem } from "../lib/api";
import { seekBy } from "../lib/seek";
import { VideoPlayer } from "./VideoPlayer";
import { addTag, getMediaFilePath, getMediaStreamUrl, listTagsForMedia, openInExplorer, removeTag, setFavorite, setRating } from "../lib/api";
import { formatBytes, formatDate, formatDuration, formatResolution } from "../lib/format";
import { FAVORITE_KEYS, useSettingsStore } from "../stores/settingsStore";
import { EditorPanel } from "./EditorPanel";
import { dragFilesOut } from "../lib/fileDrag";
import { useEnhance } from "../lib/ai";

function TagEditor({ mediaId }: { mediaId: number }) {
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    listTagsForMedia(mediaId).then(setTags).catch(() => setTags([]));
  }, [mediaId]);

  async function submit() {
    const value = input.trim();
    if (!value) return;
    setInput("");
    await addTag(mediaId, value);
    setTags(await listTagsForMedia(mediaId));
  }

  async function remove(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
    await removeTag(mediaId, tag);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {tags.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/85">
            {t}
            <button onClick={() => remove(t)} className="text-white/40 hover:text-white/80">
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Add tag…"
        className="rounded-control bg-black/30 px-2 py-1 text-[11px] text-white outline-none placeholder:text-white/30"
      />
    </div>
  );
}

/**
 * Where the stage loads the file from. Videos stream from the app's local http server (byte
 * ranges: seeking reads just what it needs, and very large files work — the webview's asset://
 * protocol refused some of them outright, which sent them through a slow FFmpeg conversion).
 */
function useMediaUrl(id: number | undefined, isVideo: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    setUrl(null);
    const load = isVideo ? getMediaStreamUrl(id).catch(() => getMediaFilePath(id).then(convertFileSrc)) : getMediaFilePath(id).then(convertFileSrc);
    load
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, isVideo]);
  return url;
}

function IconButton({
  onClick,
  label,
  active,
  children,
}: {
  onClick: () => void;
  label: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-8 w-8 items-center justify-center rounded-control transition-colors ${
        active ? "bg-accent text-white" : "text-text-secondary hover:bg-white/10 hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function PhotoStage({ url }: { url: string | null }) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    setScale(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  }, [url]);

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    setScale((s) => Math.min(6, Math.max(0.5, s - e.deltaY * 0.0015 * s)));
  }

  function onMouseDown(e: MouseEvent) {
    if (scale <= 1) return;
    dragging.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  }
  function onMouseMove(e: MouseEvent) {
    if (!dragging.current) return;
    const dx = e.clientX - dragging.current.startX;
    const dy = e.clientY - dragging.current.startY;
    setPan({ x: dragging.current.panX + dx, y: dragging.current.panY + dy });
  }
  function onMouseUp() {
    dragging.current = null;
  }

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={() => {
        setScale((s) => (s > 1 ? 1 : 2));
        setPan({ x: 0, y: 0 });
      }}
    >
      {url && (
        <img
          src={url}
          draggable={false}
          alt=""
          className="max-h-full max-w-full select-none"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale}) rotate(${rotation}deg)`,
            transition: dragging.current ? "none" : "transform 120ms cubic-bezier(0.4,0,0.2,1)",
            cursor: scale > 1 ? "grab" : "default",
          }}
        />
      )}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-control bg-black/50 p-1 backdrop-blur">
        <IconButton label="Zoom out" onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}>
          <span className="text-lg leading-none">−</span>
        </IconButton>
        <IconButton label="Fit" onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}>
          <span className="text-[11px]">Fit</span>
        </IconButton>
        <IconButton label="100%" onClick={() => { setScale(2); setPan({ x: 0, y: 0 }); }}>
          <span className="text-[11px]">1:1</span>
        </IconButton>
        <IconButton label="Zoom in" onClick={() => setScale((s) => Math.min(6, s + 0.25))}>
          <span className="text-lg leading-none">+</span>
        </IconButton>
        <IconButton label="Rotate" onClick={() => setRotation((r) => (r + 90) % 360)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 12a9 9 0 1 1 3 6.7M3 12v6h6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </IconButton>
      </div>
    </div>
  );
}

/** Resume where you left off: the position is loaded before the player starts and saved as it plays. */
function usePlaybackMemory(id: number, videoRef: RefObject<HTMLVideoElement | null>) {
  const [startAt, setStartAt] = useState<number | null>(null);
  const resume = useSettingsStore((s) => s.resumePlayback);
  useEffect(() => {
    let alive = true;
    setStartAt(null);
    if (!resume) setStartAt(0);
    else
      invoke<number>("get_playback_position", { id })
        .then((ms) => alive && setStartAt(ms / 1000))
        .catch(() => alive && setStartAt(0));
    const save = () => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.duration) || v.duration < 30) return;
      // near the start or the end: next time starts from the beginning
      const t = v.currentTime < 5 || v.currentTime > v.duration - 8 ? 0 : v.currentTime;
      void invoke("set_playback_position", { id, ms: Math.round(t * 1000) }).catch(() => {});
    };
    const timer = window.setInterval(save, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      save();
    };
  }, [id, videoRef, resume]);
  return startAt;
}

function VideoStage({ id, url, title, videoRef }: { id: number; url: string | null; title: string; videoRef: RefObject<HTMLVideoElement | null> }) {
  const startAt = usePlaybackMemory(id, videoRef);
  const [resumedNote, setResumedNote] = useState<number | null>(null);
  useEffect(() => {
    if (startAt && startAt > 0) {
      setResumedNote(startAt);
      const t = window.setTimeout(() => setResumedNote(null), 6000);
      return () => window.clearTimeout(t);
    }
    setResumedNote(null);
  }, [startAt, id]);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [failed, setFailed] = useState(false);
  const triedFallback = useRef(false);

  useEffect(() => {
    triedFallback.current = false;
    setFallbackUrl(null);
    setFailed(false);
  }, [id]);

  const src = fallbackUrl ?? url;

  // The original file failed to play natively: re-mux / transcode it through
  // FFmpeg into the app's playback cache and play that instead.
  async function handleError() {
    if (triedFallback.current) {
      setFailed(true);
      return;
    }
    triedFallback.current = true;
    setPreparing(true);
    try {
      const path = await invoke<string>("prepare_video_playback", { id });
      setFallbackUrl(convertFileSrc(path));
    } catch {
      setFailed(true);
    } finally {
      setPreparing(false);
    }
  }

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-text-tertiary">
        This video could not be played, even after attempting to convert it.
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {src && startAt !== null && (
        <VideoPlayer key={id} src={src} videoRef={videoRef} title={title} onError={handleError} handleArrows startAt={startAt} className="h-full w-full !rounded-none" />
      )}
      {resumedNote !== null && (
        <div data-testid="resume-note" className="absolute left-1/2 top-16 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full bg-black/75 px-4 py-1.5 text-[12px] text-white shadow-lg backdrop-blur">
          <span>Resumed at {formatDuration(resumedNote * 1000)}</span>
          <button
            onClick={() => {
              const v = videoRef.current;
              if (v) v.currentTime = 0;
              setResumedNote(null);
            }}
            className="rounded-full bg-white/15 px-2.5 py-0.5 hover:bg-white/25"
          >
            Start over
          </button>
        </div>
      )}
      {preparing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm text-white backdrop-blur-sm">
          Converting for playback…
        </div>
      )}
    </div>
  );
}

export function Viewer({
  items,
  total,
  index,
  onIndexChange,
  onClose,
  onNeedMore,
  initialEditorOpen,
  onItemChanged,
  onStep,
  globalIndex,
  globalTotal,
  onShowFolder,
}: {
  items: MediaListItem[];
  total: number;
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  onNeedMore: () => void;
  initialEditorOpen?: boolean;
  /** Favourite / rating changed here, so the list can follow without a reload. */
  onItemChanged?: (id: number, patch: Partial<MediaListItem>) => void;
  /** Next / previous across pages (the grid loads the neighbouring page when needed). */
  onStep?: (delta: number) => void;
  /** Position in the whole result (not just this page), 0-based, and its size. */
  globalIndex?: number;
  globalTotal?: number;
  /** Shows the folder this file is in, nothing else. */
  onShowFolder?: (item: MediaListItem) => void;
}) {
  const item = items[index];
  const [infoOpen, setInfoOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(initialEditorOpen ?? false);
  const [favorite, setFav] = useState(item?.favorite ?? false);
  const [rating, setRatingState] = useState(item?.rating ?? 0);
  const url = useMediaUrl(item?.id, item?.mediaType === "video");
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekStepSec = useSettingsStore((s) => s.seekStepSec);
  const favoriteKey = useSettingsStore((s) => s.favoriteKey);
  const gIndex = globalIndex ?? index;
  const gTotal = globalTotal ?? total;
  const step = (d: number) => (onStep ? onStep(d) : onIndexChange(Math.min(items.length - 1, Math.max(0, index + d))));
  const [heartFlash, setHeartFlash] = useState<{ key: number; on: boolean } | null>(null);
  const favRef = useRef<() => void>(() => {});

  useEffect(() => {
    setFav(item?.favorite ?? false);
    setRatingState(item?.rating ?? 0);
  }, [item?.id]);

  useEffect(() => {
    if (index >= items.length - 3 && items.length < total) onNeedMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items.length, total]);

  // Left/Right seek within a video (step configurable in Settings) and
  // fall back to prev/next for photos, since there's nothing to seek.
  // Up/Down always mean prev/next, regardless of media type.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (useEnhance.getState().item) return;
      if (e.key === "Escape") {
        if (document.fullscreenElement) return; // the browser exits full screen itself
        onClose();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        step(-1);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        step(1);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // In a video ← / → only ever seek — even while it is still loading or buffering (the player
        // handles them and remembers the target). They never switch to another file.
        if (item?.mediaType === "video") {
          e.preventDefault();
          const video = videoRef.current;
          if (video && !e.defaultPrevented) seekBy(video, e.key === "ArrowLeft" ? -seekStepSec : seekStepSec);
          return;
        }
        step(e.key === "ArrowLeft" ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, items.length, onIndexChange, onStep, onClose, item?.mediaType, seekStepSec]);

  // The favorite key (Settings → Playback; next to the arrow keys). Captured before the player and
  // any focused button, so Enter never "clicks" something instead.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (e.code !== favoriteKey || e.repeat || e.altKey || e.metaKey || useEnhance.getState().item) return;
      if (favoriteKey !== "ControlRight" && e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      favRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [favoriteKey]);

  const dateInfo = useMemo(() => {
    if (!item) return null;
    return `Modified ${formatDate(item.modifiedTime)} · Created ${formatDate(item.createdTime)}`;
  }, [item]);

  if (!item) return null;

  async function toggleFavorite() {
    const next = !favorite;
    setFav(next);
    setHeartFlash({ key: Date.now(), on: next });
    await setFavorite(item.id, next);
    onItemChanged?.(item.id, { favorite: next });
  }
  favRef.current = () => void toggleFavorite();
  async function rate(n: number) {
    setRatingState(n);
    await setRating(item.id, n);
    onItemChanged?.(item.id, { rating: n });
  }

  return (
    // top-9 (not inset-0): leaves the custom title bar — with the window's
    // own minimize/maximize/close controls, since this is a frameless
    // window with no native OS chrome — reachable even while viewing media
    // full-screen. Covering it entirely trapped the user with no way to
    // resize/maximize/minimize the window at all.
    <div className="animate-fade-in fixed inset-x-0 top-9 bottom-0 z-[100] flex flex-col bg-black">
      <div className="no-drag flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <IconButton label="Close" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <line x1="5" y1="5" x2="19" y2="19" />
            <line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        </IconButton>
        {item.mediaType === "video" && (
          <div className="flex items-center gap-0.5">
            <IconButton label="Previous file (↑ / PageUp)" onClick={() => step(-1)}>
              <span className="text-[15px]">‹</span>
            </IconButton>
            <IconButton label="Next file (↓ / PageDown)" onClick={() => step(1)}>
              <span className="text-[15px]">›</span>
            </IconButton>
          </div>
        )}
        <span className="truncate text-[13px] text-white/80">{item.filename}</span>
        <span data-testid="viewer-pos" className="shrink-0 text-[11px] tabular-nums text-white/40">
          {gIndex + 1} / {gTotal}
        </span>
        <div className="flex-1" />
        <button
          aria-label="Drag this file out"
          title="Drag this file out — drop it on a web page, a chat, Explorer…"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const x0 = e.clientX;
            const y0 = e.clientY;
            const id = item.id;
            const move = (ev: PointerEvent) => {
              if ((ev.buttons & 1) === 0 || Math.hypot(ev.clientX - x0, ev.clientY - y0) >= 4) {
                window.removeEventListener("pointermove", move);
                if (ev.buttons & 1) void dragFilesOut([id]);
              }
            };
            window.addEventListener("pointermove", move);
          }}
          className="flex h-8 cursor-grab items-center gap-1 rounded-control px-2 text-[11.5px] text-text-secondary hover:bg-white/10 hover:text-text-primary active:cursor-grabbing"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
          </svg>
          Drag out
        </button>
        {onShowFolder && (
          <button
            data-testid="show-folder"
            title={`Show only the files in "${item.folderRelPath || "(root)"}"`}
            onClick={() => onShowFolder(item)}
            className="flex h-8 items-center gap-1 rounded-control px-2 text-[11.5px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            This folder
          </button>
        )}
        <IconButton label="Open in Folder" onClick={() => openInExplorer(item.relPath)}>
          <span className="text-[13px]">⧉</span>
        </IconButton>
        <IconButton label={`Toggle favorite (${favoriteKeyLabel(favoriteKey)})`} active={favorite} onClick={toggleFavorite}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill={favorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
            <path d="M12 21s-6.5-4.35-9.5-8.15C.6 10.2 1.2 6.7 4 5.2c2-1.07 4.4-.4 6 1.5 1.6-1.9 4-2.57 6-1.5 2.8 1.5 3.4 5 1.5 7.65C18.5 16.65 12 21 12 21z" />
          </svg>
        </IconButton>
        <div className="flex items-center gap-0.5 px-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => rate(n === rating ? 0 : n)} className="text-text-tertiary hover:text-amber-300">
              <svg width="12" height="12" viewBox="0 0 24 24" fill={n <= rating ? "#f5c451" : "none"} stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </button>
          ))}
        </div>
        {item.mediaType === "video" && (
          <button
            data-testid="viewer-ai"
            title="AI Enhance: smoother motion or a sharper picture"
            onClick={() => {
              videoRef.current?.pause();
              useEnhance.getState().open({ id: item.id, filename: item.filename });
            }}
            className="flex h-8 items-center rounded-control px-2 text-[11.5px] font-semibold text-text-secondary hover:bg-white/10 hover:text-text-primary"
          >
            AI ✦
          </button>
        )}
        {item.mediaType === "video" && (
          <IconButton label="Edit" onClick={() => setEditorOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 20h9" strokeLinecap="round" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>
        )}
        <IconButton label="Info" active={infoOpen} onClick={() => setInfoOpen((v) => !v)}>
          <span className="text-[13px]">ⓘ</span>
        </IconButton>
      </div>

      <div className="relative flex flex-1 overflow-hidden">
        {item.mediaType !== "video" && (
          <>
            <button
              onClick={() => step(-1)}
              disabled={gIndex === 0}
              aria-label="Previous file"
              className="absolute left-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/80 disabled:opacity-20"
            >
              ‹
            </button>
            <button
              onClick={() => step(1)}
              disabled={gIndex >= gTotal - 1}
              aria-label="Next file"
              className="absolute right-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/80 disabled:opacity-20"
            >
              ›
            </button>
          </>
        )}

        {heartFlash && (
          <div
            key={heartFlash.key}
            data-testid="heart-flash"
            className="pointer-events-none absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 animate-[flash_700ms_ease-out_forwards] text-[64px] drop-shadow-lg"
          >
            {heartFlash.on ? "❤️" : "🤍"}
          </div>
        )}
        <div className="flex-1">
          {item.mediaType === "video" ? <VideoStage id={item.id} url={url} title={item.filename} videoRef={videoRef} /> : <PhotoStage url={url} />}
        </div>

        {infoOpen && (
          <div className="glass w-72 shrink-0 overflow-y-auto border-l border-white/10 p-4 text-[12px] text-white/80">
            <div className="mb-3 text-[13px] font-medium text-white">Info</div>
            <div className="flex flex-col gap-2">
              <InfoRow label="Filename" value={item.filename} />
              <InfoRow label="Folder" value={item.folderRelPath || "(root)"} />
              <InfoRow label="Size" value={formatBytes(item.fileSize)} />
              {formatResolution(item.width, item.height) && (
                <InfoRow label="Dimensions" value={formatResolution(item.width, item.height)!} />
              )}
              {item.mediaType === "video" && <InfoRow label="Duration" value={formatDuration(item.durationMs)} />}
              <InfoRow label="Dates" value={dateInfo ?? ""} />
              {item.dateTaken && <InfoRow label="Date Taken" value={formatDate(item.dateTaken)} />}
              {(item.cameraMake || item.cameraModel) && (
                <InfoRow label="Camera" value={[item.cameraMake, item.cameraModel].filter(Boolean).join(" ")} />
              )}
              {item.gpsLat !== null && item.gpsLon !== null && (
                <InfoRow label="Location" value={`${item.gpsLat!.toFixed(5)}, ${item.gpsLon!.toFixed(5)}`} />
              )}
              <InfoRow label="Type" value={item.extension.toUpperCase()} />
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-white/40">Tags</span>
                <TagEditor mediaId={item.id} />
              </div>
            </div>
          </div>
        )}
      </div>

      {editorOpen && <EditorPanel item={item} onClose={() => setEditorOpen(false)} />}
    </div>
  );
}

function favoriteKeyLabel(code: string) {
  return FAVORITE_KEYS.find((k) => k.code === code)?.label ?? code;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-white/40">{label}</span>
      <span className="break-words text-white/85">{value}</span>
    </div>
  );
}
