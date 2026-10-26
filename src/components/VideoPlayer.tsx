import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { seekTo as coalescedSeek } from "../lib/seek";
import { useSettingsStore } from "../stores/settingsStore";

/** A stream that FFmpeg restarts on demand (`?t=`): the browser only knows the part it was handed. */
export interface StreamSource {
  /** Total length in seconds; null for live streams. */
  duration: number | null;
  live: boolean;
  urlAt: (startSeconds: number) => string;
}

export interface QualityChoice {
  label: string;
  height: number;
}

interface Props {
  /** Plain media URL (or ignored when `stream` is given). */
  src: string;
  stream?: StreamSource | null;
  videoRef?: RefObject<HTMLVideoElement | null>;
  poster?: string | null;
  title?: string;
  autoPlay?: boolean;
  /** Also handle ← / → (seek by the configured step). Off in the gallery viewer, which owns those keys. */
  handleArrows?: boolean;
  qualities?: QualityChoice[];
  quality?: number | null;
  onQuality?: (height: number) => void;
  /** Extra buttons in the control bar (download, ...). */
  actions?: ReactNode;
  onError?: () => void;
  onEnded?: () => void;
  className?: string;
  /** Start here (seconds) instead of at the beginning. */
  startAt?: number;
}

const VOLUME_KEY = "qpg.playerVolume";
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];

function loadVolume(): { volume: number; muted: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null");
    if (raw && typeof raw.volume === "number") return { volume: Math.min(1, Math.max(0, raw.volume)), muted: !!raw.muted };
  } catch {
    // fall through
  }
  return { volume: 1, muted: false };
}

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------- icons --- */
const svg = (children: ReactNode, size = 20) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconPlay = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.3-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z" />
  </svg>
);
const IconPause = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4.5" width="4.4" height="15" rx="1.4" />
    <rect x="13.6" y="4.5" width="4.4" height="15" rx="1.4" />
  </svg>
);
const IconBack10 = () =>
  svg(
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.4 4.4v4.3h4.3" />
      <text x="12" y="15.4" textAnchor="middle" fontSize="7.4" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </>,
  );
const IconFwd10 = () =>
  svg(
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.6 4.4v4.3h-4.3" />
      <text x="12" y="15.4" textAnchor="middle" fontSize="7.4" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </>,
  );
const IconVolume = ({ level }: { level: "off" | "low" | "high" }) =>
  svg(
    <>
      <path d="M11 5 6.5 9H3.5v6h3L11 19z" fill="currentColor" />
      {level === "off" ? (
        <>
          <path d="m16 9.5 5 5" />
          <path d="m21 9.5-5 5" />
        </>
      ) : (
        <>
          <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
          {level === "high" && <path d="M18.4 6.6a8 8 0 0 1 0 10.8" />}
        </>
      )}
    </>,
  );
const IconLoop = ({ on }: { on: boolean }) =>
  svg(
    <>
      <path d="M17 2.5 20.5 6 17 9.5" />
      <path d="M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5" />
      <path d="M7 21.5 3.5 18 7 14.5" />
      <path d="M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5" />
      {on && <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />}
    </>,
  );
const IconPip = () =>
  svg(
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <rect x="12" y="11.5" width="7" height="5" rx="1.2" fill="currentColor" stroke="none" />
    </>,
  );
const IconFull = ({ exit }: { exit: boolean }) =>
  exit
    ? svg(
        <>
          <path d="M9 4.5v3.5a1 1 0 0 1-1 1H4.5" />
          <path d="M15 4.5v3.5a1 1 0 0 0 1 1h3.5" />
          <path d="M9 19.5V16a1 1 0 0 0-1-1H4.5" />
          <path d="M15 19.5V16a1 1 0 0 1 1-1h3.5" />
        </>,
      )
    : svg(
        <>
          <path d="M4.5 9V5.5a1 1 0 0 1 1-1H9" />
          <path d="M19.5 9V5.5a1 1 0 0 0-1-1H15" />
          <path d="M4.5 15v3.5a1 1 0 0 0 1 1H9" />
          <path d="M19.5 15v3.5a1 1 0 0 1-1 1H15" />
        </>,
      );
const IconGear = () =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
    18,
  );

/* ----------------------------------------------------------- controls --- */
function IconButton({
  label,
  onClick,
  active,
  children,
  wide,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex h-9 items-center justify-center rounded-full text-white/90 transition-all duration-150 hover:bg-white/15 hover:text-white active:scale-90 ${
        wide ? "min-w-9 px-2.5 text-[12px] font-semibold tabular-nums" : "w-9"
      } ${active ? "bg-white/15 text-white" : ""}`}
    >
      {children}
    </button>
  );
}

function Menu({ title, items, onPick, onClose }: { title: string; items: { label: string; active: boolean; value: number }[]; onPick: (v: number) => void; onClose: () => void }) {
  return (
    <div
      className="menu-surface animate-pop-in absolute bottom-12 right-0 z-20 w-40 rounded-card p-1.5"
      style={{ transformOrigin: "bottom right" }}
      onClick={(e) => e.stopPropagation()}
      onMouseLeave={onClose}
    >
      <div className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{title}</div>
      <div className="max-h-64 overflow-y-auto">
        {items.map((it) => (
          <button
            key={it.value}
            onClick={() => {
              onPick(it.value);
              onClose();
            }}
            className={`flex w-full items-center justify-between rounded-[8px] px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-white/10 ${
              it.active ? "text-accent" : "text-text-primary"
            }`}
          >
            <span>{it.label}</span>
            {it.active && <span>✓</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function VideoPlayer({
  src,
  stream = null,
  videoRef: externalRef,
  poster,
  title,
  autoPlay = true,
  handleArrows = false,
  qualities = [],
  quality = null,
  onQuality,
  actions,
  onError,
  onEnded,
  className = "",
  startAt = 0,
}: Props) {
  const internalRef = useRef<HTMLVideoElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const seekStepSec = useSettingsStore((s) => s.seekStepSec);

  const initial = useMemo(loadVolume, []);
  const [volume, setVolume] = useState(initial.volume);
  const [muted, setMuted] = useState(initial.muted);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [time, setTime] = useState(0); // position within what the element holds
  const [elementDuration, setElementDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [streamStart, setStreamStart] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null); // seconds while dragging
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [menu, setMenu] = useState<"speed" | "quality" | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ key: number; icon: "play" | "pause" | "fwd" | "back" } | null>(null);
  const [mutedByAutoplay, setMutedByAutoplay] = useState(false);
  const wantPlayRef = useRef(autoPlay);
  // touch-style gestures on the picture: hold = 2x, double-click the sides = skip
  const holdTimer = useRef<number | undefined>(undefined);
  const heldRate = useRef<number | null>(null);
  const suppressClick = useRef(0);
  const hideTimer = useRef<number | undefined>(undefined);
  const scrubbing = useRef(false);

  const isStream = !!stream;
  const url = stream ? stream.urlAt(streamStart) : src;
  const total = stream ? stream.duration ?? 0 : elementDuration;
  const live = !!stream?.live && !stream.duration;
  const position = streamStart + time;
  const shown = scrub ?? position;

  // A new source resets the timeline.
  useEffect(() => {
    setStreamStart(0);
    setTime(0);
    setError(null);
    setWaiting(true);
    wantPlayRef.current = autoPlay;
  }, [src, stream?.urlAt, autoPlay]);

  const video = () => internalRef.current;

  /* ---------------------------------------------------------- volume --- */
  useEffect(() => {
    const v = video();
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
    } catch {
      // storage disabled
    }
  }, [volume, muted, url]);

  useEffect(() => {
    const v = video();
    if (v) {
      v.playbackRate = rate;
      v.loop = loop && !isStream;
    }
  }, [rate, loop, url, isStream]);

  /* ------------------------------------------------------- play / seek --- */
  const flashIcon = useCallback((icon: "play" | "pause" | "fwd" | "back") => setFlash({ key: Date.now(), icon }), []);

  const play = useCallback(async () => {
    const v = video();
    if (!v) return;
    wantPlayRef.current = true;
    try {
      await v.play();
    } catch {
      // Autoplay with sound refused: start muted rather than not at all.
      v.muted = true;
      setMuted(true);
      setMutedByAutoplay(true);
      try {
        await v.play();
      } catch {
        // stays paused until the user presses play
      }
    }
  }, []);

  const pause = useCallback(() => {
    wantPlayRef.current = false;
    video()?.pause();
  }, []);

  const toggle = useCallback(() => {
    const v = video();
    if (!v) return;
    if (v.paused) {
      flashIcon("play");
      void play();
    } else {
      flashIcon("pause");
      pause();
    }
  }, [flashIcon, pause, play]);

  /** Seeks to an absolute position on the full timeline. */
  const seekAbs = useCallback(
    (t: number, live = false) => {
      const v = video();
      if (!v) return;
      const max = total > 0 ? total : Infinity;
      const target = clamp(t, 0, max);
      if (!stream) {
        if (live) coalescedSeek(v, target);
        else v.currentTime = target;
        return;
      }
      const local = target - streamStart;
      let end = 0;
      try {
        end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      } catch {
        end = 0;
      }
      if (local >= 0 && local <= end - 0.4) {
        coalescedSeek(v, local);
      } else {
        // Outside what the stream has delivered: restart FFmpeg there.
        wantPlayRef.current = !v.paused || wantPlayRef.current;
        setWaiting(true);
        setTime(0);
        setStreamStart(target);
      }
    },
    [stream, streamStart, total],
  );

  // Where the user is heading: repeated skips while a seek is still landing (or the file is still
  // loading) add up from there, instead of from the not-yet-updated position.
  const targetRef = useRef<{ t: number; at: number } | null>(null);
  const skip = useCallback(
    (delta: number) => {
      flashIcon(delta > 0 ? "fwd" : "back");
      const v = video();
      const pendingTarget = targetRef.current && (v?.seeking || waiting) && Date.now() - targetRef.current.at < 4000 ? targetRef.current.t : null;
      const target = clamp((pendingTarget ?? position) + delta, 0, total > 0 ? total : Infinity);
      targetRef.current = { t: target, at: Date.now() };
      seekAbs(target, true);
    },
    [flashIcon, position, seekAbs, waiting, total],
  );

  /* ------------------------------------------------------ element events --- */
  const syncBuffered = () => {
    const v = video();
    if (!v || !v.buffered.length) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    setBufferedEnd(end || v.buffered.end(v.buffered.length - 1));
  };

  // Time updates at animation-frame rate while playing (the native event only fires ~4x/s).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video();
      if (v && !scrubbing.current) setTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, url]);

  /* ----------------------------------------------------- controls chrome --- */
  const wake = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!scrubbing.current) setControlsVisible(false);
    }, 2400);
  }, []);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!playing || menu) {
      window.clearTimeout(hideTimer.current);
      setControlsVisible(true);
    } else {
      wake();
    }
  }, [playing, menu, wake]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void boxRef.current?.requestFullscreen();
  }, []);

  const togglePip = useCallback(async () => {
    const v = video();
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      // not supported for this media
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMutedByAutoplay(false);
    setMuted((m) => (m || volume === 0 ? false : true));
    if (volume === 0) setVolume(0.6);
  }, [volume]);

  /* -------------------------------------------------------- keyboard --- */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      let handled = true;
      if (k === " " || k === "k") toggle();
      else if (k === "j") skip(-10);
      else if (k === "l") skip(10);
      else if (k === "m") toggleMute();
      else if (k === "f") toggleFullscreen();
      else if (k === "p" && e.shiftKey) void togglePip();
      else if (k === ">" || (k === "." && e.shiftKey)) setRate((r) => RATES[Math.min(RATES.length - 1, RATES.indexOf(r) + 1)] ?? r);
      else if (k === "<" || (k === "," && e.shiftKey)) setRate((r) => RATES[Math.max(0, RATES.indexOf(r) - 1)] ?? r);
      else if (k === "arrowleft" && handleArrows) skip(-seekStepSec);
      else if (k === "arrowright" && handleArrows) skip(seekStepSec);
      else if (/^[0-9]$/.test(k) && total > 0) seekAbs((Number(k) / 10) * total);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        wake();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleArrows, seekAbs, seekStepSec, skip, toggle, toggleFullscreen, toggleMute, togglePip, total, wake]);

  /* ------------------------------------------------------------ seek bar --- */
  const timeAtPointer = (clientX: number) => {
    const bar = barRef.current;
    if (!bar || total <= 0) return 0;
    const r = bar.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * total;
  };
  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (total <= 0 || live) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbing.current = true;
    const t = timeAtPointer(e.clientX);
    setScrub(t);
    if (!stream) seekAbs(t, true);
  };
  const onBarMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = barRef.current?.getBoundingClientRect();
    if (r) setHover({ x: clamp(e.clientX - r.left, 0, r.width), t: timeAtPointer(e.clientX) });
    if (scrubbing.current) {
      const t = timeAtPointer(e.clientX);
      setScrub(t);
      if (!stream) seekAbs(t, true); // live scrubbing for plain files
    }
  };
  const onBarUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    const t = timeAtPointer(e.clientX);
    setScrub(null);
    seekAbs(t);
    wake();
  };

  /* ---------------------------------------------------------- rendering --- */
  const playedPct = total > 0 ? clamp((shown / total) * 100, 0, 100) : 0;
  const bufferedPct = total > 0 ? clamp(((streamStart + bufferedEnd) / total) * 100, 0, 100) : 0;
  const volumeLevel = muted || volume === 0 ? "off" : volume < 0.5 ? "low" : "high";

  return (
    <div
      ref={boxRef}
      className={`group/player relative flex select-none items-center justify-center overflow-hidden bg-black ${
        fullscreen ? "" : "rounded-card"
      } ${controlsVisible || !playing ? "" : "cursor-none"} ${className}`}
      onMouseMove={wake}
      onMouseLeave={() => {
        setHover(null);
        if (playing) setControlsVisible(false);
      }}
      onDoubleClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const f = (e.clientX - r.left) / Math.max(1, r.width);
        if (f < 0.33) skip(-seekStepSec);
        else if (f > 0.67) skip(seekStepSec);
        else toggleFullscreen();
      }}
      onWheel={(e) => {
        // the wheel over the picture is the volume knob
        const next = clamp(volume + (e.deltaY < 0 ? 0.05 : -0.05), 0, 1);
        setVolume(next);
        if (next > 0) setMuted(false);
      }}
    >
      <video
        key={url}
        ref={(el) => {
          internalRef.current = el;
          // The element is re-created on every source change; keep the caller's ref current.
          if (externalRef) (externalRef as { current: HTMLVideoElement | null }).current = el;
        }}
        src={url}
        poster={poster ?? undefined}
        autoPlay={false}
        preload="auto"
        playsInline
        className="h-full w-full object-contain"
        onClick={() => {
          if (Date.now() < suppressClick.current) return;
          toggle();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || live || !playing) return;
          window.clearTimeout(holdTimer.current);
          holdTimer.current = window.setTimeout(() => {
            heldRate.current = rate;
            setRate(2);
            suppressClick.current = Date.now() + 1200;
          }, 450);
        }}
        onPointerUp={() => {
          window.clearTimeout(holdTimer.current);
          if (heldRate.current !== null) {
            setRate(heldRate.current);
            heldRate.current = null;
            suppressClick.current = Date.now() + 350;
          }
        }}
        onPointerLeave={() => {
          window.clearTimeout(holdTimer.current);
          if (heldRate.current !== null) {
            setRate(heldRate.current);
            heldRate.current = null;
          }
        }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setElementDuration(Number.isFinite(v.duration) ? v.duration : 0);
          v.volume = volume;
          v.muted = muted;
          v.playbackRate = rate;
          v.loop = loop && !isStream;
          setError(null);
          if (!isStream && startAt > 0 && Number.isFinite(v.duration) && startAt < v.duration - 3 && v.currentTime < 0.5) v.currentTime = startAt;
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          setElementDuration(Number.isFinite(d) ? d : 0);
        }}
        onCanPlay={() => {
          setWaiting(false);
          if (wantPlayRef.current && video()?.paused) void play();
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onPlaying={() => setWaiting(false)}
        onWaiting={() => setWaiting(true)}
        onSeeking={() => setWaiting(true)}
        onSeeked={() => setWaiting(false)}
        onProgress={syncBuffered}
        onTimeUpdate={(e) => {
          if (!scrubbing.current) setTime(e.currentTarget.currentTime);
          syncBuffered();
        }}
        onEnded={() => {
          setPlaying(false);
          onEnded?.();
        }}
        onError={() => {
          const code = video()?.error?.code;
          setError(code === 4 ? "This video format isn't supported here." : "The video couldn't be loaded.");
          setWaiting(false);
          onError?.();
        }}
      />

      {/* Title bar */}
      {title && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-5 pb-10 pt-4 transition-opacity duration-200 ${
            controlsVisible || !playing ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="truncate text-[15px] font-medium text-white/95 drop-shadow">{title}</div>
        </div>
      )}

      {/* Centre: spinner, big play button, tap feedback, errors */}
      {waiting && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-white/20 border-t-white/90" />
        </div>
      )}
      {!playing && !waiting && !error && (
        <button
          type="button"
          aria-label="Play"
          onClick={toggle}
          className="animate-fade-in absolute flex h-[76px] w-[76px] items-center justify-center rounded-full bg-white/15 pl-1 text-white shadow-[0_8px_40px_rgba(102,115,224,0.5)] ring-1 ring-white/25 backdrop-blur-md transition-transform duration-150 hover:scale-105 active:scale-95"
        >
          <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.4v13.2a1 1 0 0 0 1.53.85l10.3-6.6a1 1 0 0 0 0-1.7L9.53 4.55A1 1 0 0 0 8 5.4z" />
          </svg>
        </button>
      )}
      {flash && (
        <div
          key={flash.key}
          className="pointer-events-none absolute flex h-16 w-16 animate-[flash_600ms_ease-out_forwards] items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
          onAnimationEnd={() => setFlash(null)}
        >
          {flash.icon === "play" ? <IconPlay /> : flash.icon === "pause" ? <IconPause /> : flash.icon === "fwd" ? <IconFwd10 /> : <IconBack10 />}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
          <div className="text-[14px] text-white/85">{error}</div>
        </div>
      )}
      {mutedByAutoplay && muted && !error && (
        <button
          type="button"
          onClick={() => {
            setMuted(false);
            setMutedByAutoplay(false);
          }}
          className="animate-fade-in absolute left-4 top-14 rounded-full bg-black/60 px-3 py-1.5 text-[12px] text-white/90 backdrop-blur-md hover:bg-black/75"
        >
          🔇 Tap to unmute
        </button>
      )}

      {/* Control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pb-3 pt-14 transition-opacity duration-200 ${
          controlsVisible || !playing ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* Seek bar */}
        {!live && (
          <div
            ref={barRef}
            className="group/bar relative mb-2 flex h-5 cursor-pointer items-center"
            onPointerDown={onBarDown}
            onPointerMove={onBarMove}
            onPointerUp={onBarUp}
            onPointerLeave={() => setHover(null)}
          >
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-all duration-150 group-hover/bar:h-1.5">
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${bufferedPct}%` }} />
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#6673e0] to-[#a78bfa]"
                style={{ width: `${playedPct}%` }}
              />
            </div>
            <div
              className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_3px_rgba(102,115,224,0.45)] transition-transform duration-150 group-hover/bar:scale-110"
              style={{ left: `${playedPct}%`, transform: `translateX(-50%) scale(${scrub !== null ? 1.25 : 1})` }}
            />
            {hover && (
              <div
                className="pointer-events-none absolute bottom-6 -translate-x-1/2 rounded-md bg-black/80 px-2 py-1 text-[11px] font-medium tabular-nums text-white shadow"
                style={{ left: hover.x }}
              >
                {fmt(hover.t)}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-1">
          <IconButton label={playing ? "Pause (K)" : "Play (K)"} onClick={toggle}>
            {playing ? <IconPause /> : <IconPlay />}
          </IconButton>
          {!live && (
            <>
              <IconButton label="Back 10 s (J)" onClick={() => skip(-10)}>
                <IconBack10 />
              </IconButton>
              <IconButton label="Forward 10 s (L)" onClick={() => skip(10)}>
                <IconFwd10 />
              </IconButton>
            </>
          )}

          <div className="group/vol flex items-center">
            <IconButton label={muted ? "Unmute (M)" : "Mute (M)"} onClick={toggleMute}>
              <IconVolume level={volumeLevel} />
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                setMuted(v === 0);
                setMutedByAutoplay(false);
              }}
              className="ml-0 h-1 w-0 cursor-pointer appearance-none rounded-full bg-white/30 accent-white opacity-0 transition-all duration-200 group-hover/vol:ml-1 group-hover/vol:w-20 group-hover/vol:opacity-100 focus:ml-1 focus:w-20 focus:opacity-100"
            />
          </div>

          <div className="ml-2 text-[12.5px] tabular-nums text-white/85">
            {live ? (
              <span className="rounded bg-red-500/80 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white">LIVE</span>
            ) : (
              <>
                {fmt(shown)} <span className="text-white/45">/ {fmt(total)}</span>
              </>
            )}
          </div>

          <div className="flex-1" />

          {actions}

          <div className="relative">
            <IconButton label="Playback speed" wide active={menu === "speed"} onClick={() => setMenu(menu === "speed" ? null : "speed")}>
              {rate === 1 ? "1×" : `${rate}×`}
            </IconButton>
            {menu === "speed" && (
              <Menu
                title="Speed"
                items={RATES.map((r) => ({ label: r === 1 ? "Normal" : `${r}×`, active: r === rate, value: r }))}
                onPick={setRate}
                onClose={() => setMenu(null)}
              />
            )}
          </div>

          {qualities.length > 0 && onQuality && (
            <div className="relative">
              <IconButton label="Quality" wide active={menu === "quality"} onClick={() => setMenu(menu === "quality" ? null : "quality")}>
                {quality ? `${quality}p` : <IconGear />}
              </IconButton>
              {menu === "quality" && (
                <Menu
                  title="Quality"
                  items={qualities.map((q) => ({ label: q.label, active: q.height === quality, value: q.height }))}
                  onPick={onQuality}
                  onClose={() => setMenu(null)}
                />
              )}
            </div>
          )}

          {!isStream && (
            <IconButton label={loop ? "Loop: on" : "Loop: off"} active={loop} onClick={() => setLoop((l) => !l)}>
              <IconLoop on={loop} />
            </IconButton>
          )}
          <IconButton label="Picture in picture (Shift+P)" onClick={() => void togglePip()}>
            <IconPip />
          </IconButton>
          <IconButton label={fullscreen ? "Exit full screen (F)" : "Full screen (F)"} onClick={toggleFullscreen}>
            <IconFull exit={fullscreen} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
