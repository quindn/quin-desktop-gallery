import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cancelEditJob, getMediaFilePaths, getMediaPage, getMediaStreamUrl, openInExplorer, type MediaListItem } from "../lib/api";
import {
  TRANSITIONS,
  clipAt,
  clipLen,
  emptyProject,
  frameSize,
  layout,
  newId,
  splitClip,
  studioDelete,
  studioExport,
  studioFileInfo,
  studioList,
  studioLoad,
  studioPickFiles,
  studioSave,
  studioStreamUrl,
  transitionMs,
  useStudioInbox,
  type AudioItem,
  type Clip,
  type Project,
  type TextItem,
} from "../lib/studio";
import { formatTime, parseTime } from "../lib/timecode";
import { requestThumbnail, useThumbUrl } from "../stores/thumbnailStore";

// Studio — a CapCut-style editor: clips from the library one after another on a main track (trim,
// split, reorder, speed, volume, colour, transitions between them), titles on a text track, music
// on an audio track, a live preview and one Export that renders it all with FFmpeg.

type Sel = { type: "clip" | "text" | "audio"; id: string } | null;
const LAST_KEY = "qpg.studio.last";
const PHOTO_MS = 3000;

// ------------------------------------------------------------------ small pieces

function Btn({ children, onClick, title, disabled, active, testId, className = "" }: { children: ReactNode; onClick: () => void; title?: string; disabled?: boolean; active?: boolean; testId?: string; className?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 shrink-0 items-center gap-1 rounded-control px-2.5 text-[11.5px] transition-colors disabled:opacity-30 ${
        active ? "bg-accent text-white" : "bg-white/10 text-white/85 hover:bg-white/20"
      } ${className}`}
    >
      {children}
    </button>
  );
}

function Num({ label, value, onChange, min, max, step = 1, suffix, testId }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; suffix?: string; testId?: string }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-white/55">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-white/80">
          {Number(value.toFixed(2))}
          {suffix}
        </span>
      </span>
      <input data-testid={testId} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-[#6673e0]" />
    </label>
  );
}

function TimeInput({ label, value, onCommit, testId }: { label: string; value: number; onCommit: (ms: number) => void; testId?: string }) {
  const [text, setText] = useState(formatTime(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(formatTime(value));
  }, [value, editing]);
  const commit = () => {
    const v = parseTime(text);
    setEditing(false);
    if (v !== null) onCommit(v);
    else setText(formatTime(value));
  };
  return (
    <label className="flex flex-col gap-1 text-[11px] text-white/55">
      {label}
      <input
        data-testid={testId}
        value={text}
        onFocus={(e) => {
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="rounded-control bg-white/10 px-2 py-1 font-mono text-[12px] text-white outline-none focus:ring-1 focus:ring-accent"
      />
    </label>
  );
}

function BinThumb({ item, onAdd }: { item: MediaListItem; onAdd: () => void }) {
  const url = useThumbUrl(item.id);
  useEffect(() => requestThumbnail(item.id), [item.id]);
  return (
    <div
      draggable
      data-bin-id={item.id}
      onDragStart={(e) => e.dataTransfer.setData("text/qg-media", String(item.id))}
      onDoubleClick={onAdd}
      title={`${item.filename} — double-click or drag onto the timeline`}
      className="group relative aspect-video cursor-grab overflow-hidden rounded-md bg-white/5"
    >
      {url && <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />}
      {item.mediaType === "video" && item.durationMs !== null && (
        <span className="absolute bottom-0.5 right-1 rounded bg-black/70 px-1 text-[9.5px] text-white">{formatTime(item.durationMs, false)}</span>
      )}
      <button
        onClick={onAdd}
        aria-label={`Add ${item.filename}`}
        className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-accent text-[13px] leading-none text-white group-hover:flex"
      >
        +
      </button>
    </div>
  );
}

function ClipThumb({ clip }: { clip: Clip }) {
  const url = useThumbUrl(clip.mediaId ?? -1);
  useEffect(() => {
    if (clip.mediaId != null) requestThumbnail(clip.mediaId);
  }, [clip.mediaId]);
  const bg = url ?? (clip.kind === "photo" && clip.mediaId == null ? convertFileSrc(clip.path) : null);
  return bg ? <div className="pointer-events-none absolute inset-0 opacity-70" style={{ backgroundImage: `url("${bg}")`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }} /> : null;
}

// ------------------------------------------------------------------ the editor

export function Studio() {
  const [project, setProject] = useState<Project>(emptyProject);
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const [, bump] = useState(0);
  const [sel, setSel] = useState<Sel>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(80); // px per second
  const [projects, setProjects] = useState<Project[]>([]);
  const [sourceMs, setSourceMs] = useState<Record<string, number>>({});
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [job, setJob] = useState<{ id: string; pct: number; status: "running" | "done" | "error"; out?: string; error?: string } | null>(null);
  const [binType, setBinType] = useState<"all" | "video" | "photo">("all");
  const [binSearch, setBinSearch] = useState("");
  const [bin, setBin] = useState<MediaListItem[]>([]);
  const [binTab, setBinTab] = useState<"media" | "text" | "music">("media");
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // the last project has been reopened
  const savedRef = useRef<string>("");

  const { starts, total } = useMemo(() => layout(project), [project]);
  const size = frameSize(project);

  // ---- history: commit() is one undo step; live() updates during a drag without one
  const commit = useCallback((next: Project | ((p: Project) => Project)) => {
    setProject((cur) => {
      const n = typeof next === "function" ? next(cur) : next;
      if (n === cur) return cur;
      past.current.push(cur);
      if (past.current.length > 200) past.current.shift();
      future.current = [];
      bump((x) => x + 1);
      return n;
    });
  }, []);
  const live = useCallback((next: (p: Project) => Project) => setProject((cur) => next(cur)), []);
  const snapshot = useCallback(() => {
    setProject((cur) => {
      past.current.push(cur);
      future.current = [];
      return cur;
    });
  }, []);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    setProject((cur) => {
      future.current.push(cur);
      return prev;
    });
    bump((x) => x + 1);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    setProject((cur) => {
      past.current.push(cur);
      return next;
    });
    bump((x) => x + 1);
  }, []);

  // ---- projects: open the last one, autosave
  const refreshList = useCallback(() => studioList().then(setProjects).catch(() => {}), []);
  useEffect(() => {
    void refreshList().then(async () => {
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_KEY);
      } catch {
        // storage disabled
      }
      if (last) {
        const p = await studioLoad(last).catch(() => null);
        if (p) {
          savedRef.current = JSON.stringify({ ...p, updatedAt: 0 });
          setProject(p);
        }
      }
      setReady(true);
    });
  }, [refreshList]);
  // leaving the Studio saves right away (the debounce below would be cancelled)
  const latest = useRef(project);
  latest.current = project;
  useEffect(
    () => () => {
      const p = latest.current;
      if (!(p.clips.length || p.texts.length || p.audio.length || p.id)) return;
      if (JSON.stringify({ ...p, updatedAt: 0 }) === savedRef.current) return;
      void studioSave(p)
        .then((sv) => {
          try {
            localStorage.setItem(LAST_KEY, sv.id);
          } catch {
            // storage disabled
          }
        })
        .catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!ready) return;
    if (project.clips.length === 0 && project.texts.length === 0 && project.audio.length === 0 && !project.id) return;
    const json = JSON.stringify({ ...project, updatedAt: 0 });
    if (json === savedRef.current) return;
    const timer = window.setTimeout(async () => {
      const saved = await studioSave(project).catch(() => null);
      if (!saved) return;
      savedRef.current = JSON.stringify({ ...saved, updatedAt: 0 });
      if (!project.id) setProject((p) => ({ ...p, id: saved.id, createdAt: saved.createdAt }));
      try {
        localStorage.setItem(LAST_KEY, saved.id);
      } catch {
        // storage disabled
      }
      void refreshList();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [project, refreshList, ready]);

  // ---- media bin (the library)
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      getMediaPage({
        folderRelPath: null,
        includeSubfolders: true,
        mediaType: binType,
        sortBy: "date_modified",
        sortDesc: true,
        limit: 300,
        offset: 0,
        search: binSearch.trim() || null,
        durationMinMs: null,
        durationMaxMs: null,
        sizeMinBytes: null,
        sizeMaxBytes: null,
        modifiedAfter: null,
        modifiedBefore: null,
        favoritesOnly: false,
        minRating: null,
        metadataStates: null,
        tag: null,
        orientation: null,
      })
        .then((p) => alive && setBin(p.items.filter((i) => i.mediaType === "video" || i.mediaType === "photo")))
        .catch(() => alive && setBin([]));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [binType, binSearch]);

  /** Library items → clips (inserted at `at`, or appended). */
  const addLibraryItems = useCallback(
    async (items: { id: number; filename: string; mediaType: string; durationMs: number | null }[], at?: number) => {
      if (items.length === 0) return;
      setBusy("Adding…");
      try {
        const paths = await getMediaFilePaths(items.map((i) => i.id));
        const clips: Clip[] = [];
        const lens: Record<string, number> = {};
        for (const it of items) {
          const path = paths.get(it.id);
          if (!path) continue;
          if (it.mediaType === "photo") {
            clips.push(baseClip({ path, name: it.filename, mediaId: it.id, kind: "photo", srcOutMs: PHOTO_MS, hasAudio: false }));
            continue;
          }
          const info = await studioFileInfo(path).catch(() => null);
          const dur = info?.durationMs ?? it.durationMs ?? 0;
          if (dur < 200) continue;
          lens[path] = dur;
          clips.push(baseClip({ path, name: it.filename, mediaId: it.id, kind: "video", srcOutMs: dur, hasAudio: info?.hasAudio ?? true }));
        }
        setSourceMs((s) => ({ ...s, ...lens }));
        if (clips.length === 0) return;
        commit((p) => {
          const idx = at === undefined ? p.clips.length : Math.max(0, Math.min(at, p.clips.length));
          return { ...p, clips: [...p.clips.slice(0, idx), ...clips, ...p.clips.slice(idx)] };
        });
        setSel({ type: "clip", id: clips[0].id });
      } finally {
        setBusy(null);
      }
    },
    [commit],
  );

  // "Add to Studio" from the grid
  const inbox = useStudioInbox((s) => s.ids);
  useEffect(() => {
    if (!ready || inbox.length === 0) return;
    const ids = useStudioInbox.getState().take();
    void (async () => {
      const paths = await getMediaFilePaths(ids);
      const items = [];
      for (const id of ids) {
        const path = paths.get(id);
        if (!path) continue;
        const name = path.split(/[\\/]/).pop() ?? "";
        const isPhoto = /\.(jpe?g|png|webp|bmp|gif|heic|heif|tiff?|avif)$/i.test(name);
        items.push({ id, filename: name, mediaType: isPhoto ? "photo" : "video", durationMs: null });
      }
      await addLibraryItems(items);
    })();
  }, [inbox, addLibraryItems, ready]);

  // full source lengths (for trimming) of clips loaded from a saved project
  useEffect(() => {
    for (const c of project.clips) {
      if (c.kind === "video" && sourceMs[c.path] === undefined) {
        setSourceMs((s) => ({ ...s, [c.path]: s[c.path] ?? -1 }));
        studioFileInfo(c.path)
          .then((i) => setSourceMs((s) => ({ ...s, [c.path]: i.durationMs ?? c.srcOutMs })))
          .catch(() => setSourceMs((s) => ({ ...s, [c.path]: c.srcOutMs })));
      }
    }
  }, [project.clips, sourceMs]);

  // stream URLs for the preview
  const urlFor = useCallback(
    (path: string, mediaId: number | null) => {
      if (path in urls) return urls[path]; // ready, or already being fetched
      setUrls((u) => (path in u ? u : { ...u, [path]: "" }));
      const get = mediaId != null ? getMediaStreamUrl(mediaId).catch(() => studioStreamUrl(path)) : studioStreamUrl(path);
      get.then((u) => setUrls((x) => ({ ...x, [path]: u }))).catch(() => {});
      return "";
    },
    [urls],
  );

  // ================================================================== preview engine
  const vRefs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const slotClip = useRef<(string | null)[]>([null, null]);
  const [front, setFront] = useState(0); // which <video> is shown
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const tRef = useRef(t);
  tRef.current = t;
  const projRef = useRef(project);
  projRef.current = project;

  /** Makes the preview show timeline time `time`. */
  const sync = useCallback(
    (time: number, isPlaying: boolean) => {
      const p = projRef.current;
      const { starts: st } = layout(p);
      const i = clipAt(p, st, time);
      const c = i >= 0 ? p.clips[i] : null;
      if (c && c.kind === "video") {
        const url = urls[c.path];
        // the element holding this clip, or load it into the hidden one
        let slot = slotClip.current.indexOf(c.id);
        if (slot < 0) {
          slot = 1 - front;
          const v = vRefs[slot].current;
          if (v && url) {
            slotClip.current[slot] = c.id;
            v.src = url;
          }
        }
        const v = vRefs[slot].current;
        if (v && slotClip.current[slot] === c.id) {
          if (slot !== front && v.readyState >= 2) setFront(slot);
          const local = (c.srcInMs + (time - st[i]) * c.speed) / 1000;
          v.playbackRate = c.speed;
          v.volume = Math.min(1, Math.max(0, c.volume));
          v.muted = c.muted || !c.hasAudio;
          if (isPlaying) {
            if (Math.abs(v.currentTime - local) > 0.3) v.currentTime = local;
            if (v.paused) void v.play().catch(() => {});
          } else {
            if (!v.paused) v.pause();
            if (Math.abs(v.currentTime - local) > 0.02) v.currentTime = local;
          }
        }
        // the other element: pause it, and preload the next clip near the end
        const other = vRefs[1 - slot].current;
        if (other && !other.paused && slotClip.current[1 - slot] !== c.id) other.pause();
        const next = p.clips[i + 1];
        if (next && next.kind === "video" && time > st[i] + clipLen(c) - 2000 && !slotClip.current.includes(next.id) && urls[next.path] && other) {
          slotClip.current[1 - slot] = next.id;
          other.src = urls[next.path];
          other.currentTime = next.srcInMs / 1000;
        }
      } else {
        for (const r of vRefs) if (r.current && !r.current.paused) r.current.pause();
      }
      // music
      for (const a of p.audio) {
        const el = audioRefs.current[a.id];
        if (!el) continue;
        const local = (a.srcInMs + time - a.startMs) / 1000;
        const inRange = time >= a.startMs && time < a.startMs + (a.srcOutMs - a.srcInMs);
        el.volume = Math.min(1, a.volume);
        if (isPlaying && inRange) {
          if (Math.abs(el.currentTime - local) > 0.3) el.currentTime = local;
          if (el.paused) void el.play().catch(() => {});
        } else if (!el.paused) el.pause();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [urls, front],
  );

  // the clock: wall time from an anchor (set when Play is pressed and on every seek). rAF gives
  // smooth updates; a timer keeps it going when the window is in the background and rAF is paused.
  // It depends on nothing but `playing`, so loading streams or swapping the two <video>s never
  // restarts (and stalls) it.
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const anchor = useRef({ t0: 0, wall0: 0 });
  useEffect(() => {
    if (!playing) {
      syncRef.current(tRef.current, false);
      return;
    }
    anchor.current = { t0: tRef.current, wall0: performance.now() };
    let raf = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const next = anchor.current.t0 + (performance.now() - anchor.current.wall0);
      const end = layout(projRef.current).total;
      if (next >= end) {
        stopped = true;
        setT(end);
        setPlaying(false);
        return;
      }
      tRef.current = next;
      setT(next);
      syncRef.current(next, true);
    };
    const loop = () => {
      tick();
      if (!stopped) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const timer = window.setInterval(tick, 250);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, [playing]);
  useEffect(() => {
    if (!playing) sync(t, false);
  }, [t, playing, sync, project]);

  const seek = useCallback((ms: number) => {
    const v = Math.max(0, Math.min(ms, layout(projRef.current).total));
    anchor.current = { t0: v, wall0: performance.now() };
    tRef.current = v;
    setT(v);
  }, []);

  // ================================================================== editing actions
  const selected = sel ? (sel.type === "clip" ? project.clips.find((c) => c.id === sel.id) : sel.type === "text" ? project.texts.find((x) => x.id === sel.id) : project.audio.find((x) => x.id === sel.id)) : null;
  const patchClip = (id: string, patch: Partial<Clip>) => commit((p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const patchText = (id: string, patch: Partial<TextItem>) => commit((p) => ({ ...p, texts: p.texts.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const patchAudio = (id: string, patch: Partial<AudioItem>) => commit((p) => ({ ...p, audio: p.audio.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

  const splitAtPlayhead = () => {
    const i = clipAt(project, starts, t);
    if (i < 0) return;
    const n = splitClip(project, i, t);
    if (n) {
      commit(n);
      setSel({ type: "clip", id: n.clips[i + 1].id });
    }
  };
  const removeSelected = () => {
    if (!sel) return;
    commit((p) => ({
      ...p,
      clips: sel.type === "clip" ? p.clips.filter((c) => c.id !== sel.id) : p.clips,
      texts: sel.type === "text" ? p.texts.filter((c) => c.id !== sel.id) : p.texts,
      audio: sel.type === "audio" ? p.audio.filter((c) => c.id !== sel.id) : p.audio,
    }));
    setSel(null);
  };
  const duplicateSelected = () => {
    if (!sel) return;
    commit((p) => {
      if (sel.type === "clip") {
        const i = p.clips.findIndex((c) => c.id === sel.id);
        if (i < 0) return p;
        return { ...p, clips: [...p.clips.slice(0, i + 1), { ...p.clips[i], id: newId() }, ...p.clips.slice(i + 1)] };
      }
      if (sel.type === "text") {
        const x = p.texts.find((c) => c.id === sel.id);
        if (!x) return p;
        const len = x.endMs - x.startMs;
        return { ...p, texts: [...p.texts, { ...x, id: newId(), startMs: x.endMs, endMs: x.endMs + len }] };
      }
      return p;
    });
  };
  const addText = (preset: Partial<TextItem>) => {
    const x: TextItem = { id: newId(), text: "Your text", startMs: Math.round(t), endMs: Math.round(t) + 3000, x: 0.5, y: 0.85, size: 72, color: "#ffffff", background: true, bold: true, ...preset };
    commit((p) => ({ ...p, texts: [...p.texts, x] }));
    setSel({ type: "text", id: x.id });
  };
  const addMusic = async () => {
    const files = await studioPickFiles("audio").catch(() => []);
    const items: AudioItem[] = files
      .filter((f) => f.hasAudio && (f.durationMs ?? 0) > 200)
      .map((f) => ({ id: newId(), path: f.path, name: f.name, startMs: 0, srcInMs: 0, srcOutMs: f.durationMs ?? 0, volume: 0.8, fadeInMs: 0, fadeOutMs: 1000 }));
    if (items.length) {
      commit((p) => ({ ...p, audio: [...p.audio, ...items] }));
      setSel({ type: "audio", id: items[0].id });
    }
  };
  const addFromDisk = async () => {
    const files = await studioPickFiles("media").catch(() => []);
    const clips: Clip[] = files.map((f) =>
      f.hasVideo && (f.durationMs ?? 0) > 200
        ? baseClip({ path: f.path, name: f.name, kind: "video", srcOutMs: f.durationMs ?? 0, hasAudio: f.hasAudio })
        : baseClip({ path: f.path, name: f.name, kind: "photo", srcOutMs: PHOTO_MS, hasAudio: false }),
    );
    if (clips.length) {
      setSourceMs((s) => ({ ...s, ...Object.fromEntries(files.filter((f) => f.durationMs).map((f) => [f.path, f.durationMs!])) }));
      commit((p) => ({ ...p, clips: [...p.clips, ...clips] }));
    }
  };

  // ---- export
  const exportNow = async () => {
    if (project.clips.length === 0) return;
    setJob({ id: "", pct: 0, status: "running" });
    try {
      const saved = await studioSave(project);
      const r = await studioExport(saved);
      setJob({ id: r.jobId, pct: 0, status: "running", out: r.outputPath });
    } catch (e) {
      setJob({ id: "", pct: 0, status: "error", error: String(e) });
    }
  };
  useEffect(() => {
    const p1 = listen<any>("edit://progress", (e) => setJob((j) => (j && j.id === e.payload.job_id ? { ...j, pct: e.payload.percent } : j)));
    const p2 = listen<any>("edit://done", (e) =>
      setJob((j) => (j && j.id === e.payload.job_id ? { ...j, pct: 100, status: e.payload.success ? "done" : "error", out: e.payload.output_path ?? j.out, error: e.payload.error } : j)),
    );
    return () => {
      p1.then((f) => f());
      p2.then((f) => f());
    };
  }, []);

  // ---- keyboard
  const keyRef = useRef({ splitAtPlayhead, removeSelected, duplicateSelected, undo, redo, seek, t, total, fps: project.fps });
  keyRef.current = { splitAtPlayhead, removeSelected, duplicateSelected, undo, redo, seek, t, total, fps: project.fps };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const k = keyRef.current;
      const frame = 1000 / (k.fps || 30);
      let handled = true;
      if (e.ctrlKey && (e.key === "z" || e.key === "Z") && !e.shiftKey) k.undo();
      else if (e.ctrlKey && (e.key === "y" || e.key === "Y" || ((e.key === "z" || e.key === "Z") && e.shiftKey))) k.redo();
      else if (e.ctrlKey && (e.key === "d" || e.key === "D")) k.duplicateSelected();
      else if (e.key === " ") setPlaying((x) => !x);
      else if (e.key === "s" || e.key === "S") k.splitAtPlayhead();
      else if (e.key === "Delete" || e.key === "Backspace") k.removeSelected();
      else if (e.key === "ArrowLeft") k.seek(k.t - (e.shiftKey ? 1000 : frame));
      else if (e.key === "ArrowRight") k.seek(k.t + (e.shiftKey ? 1000 : frame));
      else if (e.key === "Home") k.seek(0);
      else if (e.key === "End") k.seek(k.total);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ================================================================== timeline interactions
  const tracksRef = useRef<HTMLDivElement>(null);
  const pxToMs = (px: number) => (px / zoom) * 1000;
  const msToPx = (ms: number) => (ms / 1000) * zoom;
  const timeAtClient = (clientX: number) => {
    const el = tracksRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, pxToMs(clientX - r.left + el.scrollLeft - 12));
  };
  const drag = useRef<null | { kind: string; id: string; x0: number; orig: any; moved: boolean }>(null);
  const beginDrag = (e: ReactPointerEvent, kind: string, id: string, orig: any) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, id, x0: e.clientX, orig, moved: false };
    if (kind !== "seek") snapshot();
  };
  const onDragMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dms = pxToMs(e.clientX - d.x0);
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (d.kind === "seek") return seek(timeAtClient(e.clientX));
    if (d.kind === "clip-in" || d.kind === "clip-out") {
      live((p) => ({
        ...p,
        clips: p.clips.map((c) => {
          if (c.id !== d.id) return c;
          const o = d.orig as Clip;
          const src = dms * o.speed;
          if (d.kind === "clip-in") return { ...c, srcInMs: Math.round(Math.max(0, Math.min(o.srcOutMs - 200, o.srcInMs + src))) };
          const max = o.kind === "photo" ? 600_000 : sourceMs[o.path] > 0 ? sourceMs[o.path] : o.srcOutMs;
          return { ...c, srcOutMs: Math.round(Math.max(o.srcInMs + 200, Math.min(max, o.srcOutMs + src))) };
        }),
      }));
    } else if (d.kind === "clip-move") {
      // where the dragged clip would go: before the first clip whose middle is right of the pointer
      const tm = timeAtClient(e.clientX);
      live((p) => {
        const from = p.clips.findIndex((c) => c.id === d.id);
        if (from < 0) return p;
        const { starts: st } = layout(p);
        let to = p.clips.findIndex((c, i) => i !== from && tm < st[i] + clipLen(c) / 2);
        if (to < 0) to = p.clips.length;
        if (to > from) to -= 1;
        if (to === from) return p;
        const clips = [...p.clips];
        const [c] = clips.splice(from, 1);
        clips.splice(to, 0, c);
        return { ...p, clips };
      });
    } else if (d.kind === "text-move") {
      const o = d.orig as TextItem;
      const s = Math.max(0, Math.round(o.startMs + dms));
      live((p) => ({ ...p, texts: p.texts.map((x) => (x.id === d.id ? { ...x, startMs: s, endMs: s + (o.endMs - o.startMs) } : x)) }));
    } else if (d.kind === "text-end") {
      const o = d.orig as TextItem;
      live((p) => ({ ...p, texts: p.texts.map((x) => (x.id === d.id ? { ...x, endMs: Math.max(o.startMs + 200, Math.round(o.endMs + dms)) } : x)) }));
    } else if (d.kind === "audio-move") {
      const o = d.orig as AudioItem;
      live((p) => ({ ...p, audio: p.audio.map((x) => (x.id === d.id ? { ...x, startMs: Math.max(0, Math.round(o.startMs + dms)) } : x)) }));
    } else if (d.kind === "audio-end") {
      const o = d.orig as AudioItem;
      live((p) => ({ ...p, audio: p.audio.map((x) => (x.id === d.id ? { ...x, srcOutMs: Math.max(o.srcInMs + 200, Math.round(o.srcOutMs + dms)) } : x)) }));
    }
  };
  const onDragEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.kind !== "seek" && !d.moved) past.current.pop(); // a plain click is no edit
  };
  const onDropMedia = (e: DragEvent) => {
    const id = Number(e.dataTransfer.getData("text/qg-media"));
    if (!id) return;
    e.preventDefault();
    const tm = timeAtClient(e.clientX);
    let at = project.clips.findIndex((c, i) => tm < starts[i] + clipLen(c) / 2);
    if (at < 0) at = project.clips.length;
    const it = bin.find((b) => b.id === id);
    if (it) void addLibraryItems([it], at);
  };

  // text dragged on the preview
  const stageRef = useRef<HTMLDivElement>(null);
  const textDrag = useRef<null | { id: string }>(null);

  // ================================================================== render
  const timelineWidth = Math.max(msToPx(total) + 400, 1200);
  const ticks: number[] = [];
  const stepMs = zoom >= 120 ? 1000 : zoom >= 50 ? 2000 : zoom >= 20 ? 5000 : 10000;
  for (let x = 0; x <= total + 20000; x += stepMs) ticks.push(x);
  const curIdx = clipAt(project, starts, t);
  const cur = curIdx >= 0 ? project.clips[curIdx] : null;
  const visibleTexts = project.texts.filter((x) => t >= x.startMs && t < x.endMs);
  const inTransition = curIdx > 0 && t < starts[curIdx] + transitionMs(project, curIdx);
  const tProgress = inTransition ? (t - starts[curIdx]) / Math.max(1, transitionMs(project, curIdx)) : 1;

  // stream urls for everything on the timeline
  useEffect(() => {
    for (const c of project.clips) urlFor(c.path, c.mediaId);
    for (const a of project.audio) urlFor(a.path, null);
  }, [project.clips, project.audio, urlFor]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0b0f] text-white" data-testid="studio">
      {/* ------------------------------------------------ top bar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <span className="text-[13px] font-semibold text-white/90">Studio</span>
        <input
          data-testid="studio-name"
          value={project.name}
          onChange={(e) => live((p) => ({ ...p, name: e.target.value }))}
          onKeyDown={(e) => e.stopPropagation()}
          className="w-48 rounded-control bg-white/10 px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-accent"
        />
        <select
          data-testid="studio-projects"
          value={project.id}
          onChange={async (e) => {
            const v = e.target.value;
            setPlaying(false);
            past.current = [];
            future.current = [];
            setSel(null);
            setT(0);
            if (v === "__new") setProject(emptyProject());
            else if (v) {
              const p = await studioLoad(v).catch(() => null);
              if (p) {
                savedRef.current = JSON.stringify({ ...p, updatedAt: 0 });
                setProject(p);
              }
            }
          }}
          className="rounded-control bg-white/10 px-2 py-1 text-[12px] outline-none"
        >
          {!project.id && <option value="">(new project)</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__new">+ New project</option>
        </select>
        <Btn
          title="Delete this project"
          disabled={!project.id}
          onClick={async () => {
            if (!project.id || !window.confirm(`Delete the project "${project.name}"? (Exported videos are kept.)`)) return;
            await studioDelete(project.id).catch(() => {});
            setProject(emptyProject());
            void refreshList();
          }}
        >
          Delete
        </Btn>
        <div className="mx-2 h-5 w-px bg-white/15" />
        <select data-testid="studio-aspect" value={project.aspect} onChange={(e) => commit((p) => ({ ...p, aspect: e.target.value as Project["aspect"] }))} className="rounded-control bg-white/10 px-2 py-1 text-[12px] outline-none" title="Frame shape">
          {["16:9", "9:16", "1:1", "4:3", "3:4"].map((a) => (
            <option key={a} value={a}>
              {a}
              {a === "9:16" ? " (TikTok / Reels)" : a === "16:9" ? " (YouTube)" : ""}
            </option>
          ))}
        </select>
        <select value={project.resolution} onChange={(e) => commit((p) => ({ ...p, resolution: Number(e.target.value) }))} className="rounded-control bg-white/10 px-2 py-1 text-[12px] outline-none" title="Resolution">
          {[720, 1080, 1440, 2160].map((r) => (
            <option key={r} value={r}>
              {r === 2160 ? "4K" : `${r}p`}
            </option>
          ))}
        </select>
        <select value={project.fps} onChange={(e) => commit((p) => ({ ...p, fps: Number(e.target.value) }))} className="rounded-control bg-white/10 px-2 py-1 text-[12px] outline-none" title="Frame rate">
          {[24, 25, 30, 50, 60].map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
        <div className="flex-1" />
        {busy && <span className="text-[11px] text-white/50">{busy}</span>}
        {job?.status === "running" && (
          <div className="flex items-center gap-2 text-[11px]">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-white/15">
              <div className="h-full bg-accent transition-all" style={{ width: `${job.pct}%` }} />
            </div>
            <span className="tabular-nums">{Math.round(job.pct)}%</span>
            <button onClick={() => job.id && void cancelEditJob(job.id)} className="text-red-300">
              Cancel
            </button>
          </div>
        )}
        {job?.status === "done" && (
          <span data-testid="studio-done" className="flex items-center gap-2 text-[11.5px] text-emerald-300">
            Saved: {job.out?.split(/[\\/]/).pop()}
          </span>
        )}
        {job?.status === "error" && <span className="max-w-[260px] truncate text-[11.5px] text-red-300" title={job.error}>Failed: {job.error}</span>}
        <button
          data-testid="studio-export"
          onClick={() => void exportNow()}
          disabled={project.clips.length === 0 || job?.status === "running"}
          className="h-8 rounded-control bg-accent px-4 text-[12.5px] font-semibold text-white disabled:opacity-40"
        >
          Export
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ------------------------------------------------ media bin */}
        <div className="flex w-64 shrink-0 flex-col border-r border-white/10">
          <div className="flex gap-1 p-2">
            {(
              [
                ["media", "Media"],
                ["text", "Text"],
                ["music", "Music"],
              ] as const
            ).map(([k, l]) => (
              <Btn key={k} active={binTab === k} onClick={() => setBinTab(k)} className="flex-1 justify-center">
                {l}
              </Btn>
            ))}
          </div>
          {binTab === "media" && (
            <>
              <div className="flex gap-1 px-2">
                <input
                  value={binSearch}
                  onChange={(e) => setBinSearch(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder="Search the library…"
                  className="min-w-0 flex-1 rounded-control bg-white/10 px-2 py-1 text-[11.5px] outline-none"
                />
                <select value={binType} onChange={(e) => setBinType(e.target.value as typeof binType)} className="rounded-control bg-white/10 px-1 text-[11px] outline-none">
                  <option value="all">All</option>
                  <option value="video">Videos</option>
                  <option value="photo">Photos</option>
                </select>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-1.5 overflow-y-auto p-2" data-testid="studio-bin">
                {bin.map((it) => (
                  <BinThumb key={it.id} item={it} onAdd={() => void addLibraryItems([it])} />
                ))}
                {bin.length === 0 && <p className="col-span-2 p-2 text-[11px] text-white/40">No videos or photos in the library match.</p>}
              </div>
              <div className="border-t border-white/10 p-2">
                <Btn onClick={() => void addFromDisk()} className="w-full justify-center" title="Add videos or photos from anywhere on the computer">
                  + Add files from the computer…
                </Btn>
              </div>
            </>
          )}
          {binTab === "text" && (
            <div className="flex flex-col gap-2 p-2">
              {[
                { label: "Title", p: { text: "Title", y: 0.5, size: 110, background: false } },
                { label: "Subtitle", p: { text: "Subtitle", y: 0.86, size: 64, background: true } },
                { label: "Caption (top)", p: { text: "Caption", y: 0.12, size: 56, background: true } },
                { label: "Big yellow", p: { text: "WOW!", y: 0.5, size: 150, color: "#ffd400", background: false } },
              ].map((pr) => (
                <button
                  key={pr.label}
                  data-testid={`add-text-${pr.label}`}
                  onClick={() => addText(pr.p)}
                  className="rounded-md bg-white/5 px-3 py-3 text-left text-[13px] font-semibold hover:bg-white/10"
                  style={{ color: (pr.p as { color?: string }).color ?? "#fff" }}
                >
                  {pr.label}
                  <span className="block text-[10.5px] font-normal text-white/40">added at the playhead</span>
                </button>
              ))}
            </div>
          )}
          {binTab === "music" && (
            <div className="flex flex-col gap-2 p-2 text-[11.5px] text-white/60">
              <Btn onClick={() => void addMusic()} className="justify-center">
                + Add music from the computer…
              </Btn>
              <p>Music goes on the audio track under the clips' own sound. Drag it to move it, pull its right edge to shorten it, set its volume and fades on the right.</p>
            </div>
          )}
        </div>

        {/* ------------------------------------------------ preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <div
              ref={stageRef}
              data-testid="studio-stage"
              className="relative overflow-hidden bg-black shadow-2xl"
              style={{ aspectRatio: `${size.w} / ${size.h}`, height: size.w >= size.h ? "auto" : "100%", width: size.w >= size.h ? "100%" : "auto", maxHeight: "100%", maxWidth: "100%" }}
              onPointerMove={(e) => {
                const d = textDrag.current;
                if (!d || !stageRef.current) return;
                const r = stageRef.current.getBoundingClientRect();
                const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
                const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
                live((p) => ({ ...p, texts: p.texts.map((tt) => (tt.id === d.id ? { ...tt, x, y } : tt)) }));
              }}
              onPointerUp={() => (textDrag.current = null)}
            >
              {vRefs.map((r, k) => (
                <video
                  key={k}
                  ref={r}
                  playsInline
                  preload="auto"
                  className="absolute inset-0 h-full w-full"
                  style={{
                    objectFit: cur?.fit === "cover" ? "cover" : "contain",
                    opacity: cur?.kind === "video" && k === front ? (inTransition ? tProgress : 1) : 0,
                    filter: cur ? `brightness(${1 + cur.brightness}) contrast(${cur.contrast}) saturate(${cur.saturation})` : undefined,
                  }}
                  onCanPlay={() => sync(tRef.current, playing)}
                />
              ))}
              {cur?.kind === "photo" && (
                <img
                  src={urls[cur.path] || convertFileSrc(cur.path)}
                  alt=""
                  className="absolute inset-0 h-full w-full"
                  style={{ objectFit: cur.fit === "cover" ? "cover" : "contain", opacity: inTransition ? tProgress : 1, filter: `brightness(${1 + cur.brightness}) contrast(${cur.contrast}) saturate(${cur.saturation})` }}
                />
              )}
              {visibleTexts.map((x) => (
                <div
                  key={x.id}
                  data-testid="studio-text-overlay"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSel({ type: "text", id: x.id });
                    snapshot();
                    textDrag.current = { id: x.id };
                    (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
                  }}
                  className={`absolute cursor-move whitespace-pre text-center leading-tight ${sel?.id === x.id ? "outline outline-1 outline-accent" : ""}`}
                  style={{
                    left: `${x.x * 100}%`,
                    top: `${x.y * 100}%`,
                    transform: "translate(-50%, -50%)",
                    color: x.color,
                    fontWeight: x.bold ? 700 : 400,
                    fontSize: `calc(${x.size / 1080} * var(--stage-h, 360px))`,
                    background: x.background ? "rgba(0,0,0,0.55)" : undefined,
                    padding: x.background ? "0.15em 0.35em" : undefined,
                    textShadow: x.background ? undefined : "0 0 4px #000, 0 0 2px #000",
                    fontFamily: "'Segoe UI', Arial, sans-serif",
                  }}
                >
                  {x.text}
                </div>
              ))}
              {project.clips.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[13px] text-white/45">
                  Double-click (or drag) videos and photos from the left onto the timeline to start.
                </div>
              )}
            </div>
            <StageHeight target={stageRef} />
          </div>
          {project.audio.map((a) => (
            <audio key={a.id} ref={(el) => void (audioRefs.current[a.id] = el)} src={urls[a.path] || undefined} preload="auto" />
          ))}

          {/* transport */}
          <div className="flex shrink-0 items-center gap-2 border-t border-white/10 px-3 py-2">
            <Btn title="To the start (Home)" onClick={() => seek(0)}>⏮</Btn>
            <Btn title={playing ? "Pause (Space)" : "Play (Space)"} active onClick={() => setPlaying((x) => !x)} testId="studio-play">
              {playing ? "❚❚" : "▶"}
            </Btn>
            <Btn title="To the end (End)" onClick={() => seek(total)}>⏭</Btn>
            <span data-testid="studio-time" className="shrink-0 whitespace-nowrap font-mono text-[12px] tabular-nums text-white/80">
              {formatTime(t)} / {formatTime(total)}
            </span>
            <div className="mx-2 h-5 w-px bg-white/15" />
            <Btn title="Undo (Ctrl+Z)" disabled={past.current.length === 0} onClick={undo} testId="studio-undo">↶ Undo</Btn>
            <Btn title="Redo (Ctrl+Y)" disabled={future.current.length === 0} onClick={redo}>↷ Redo</Btn>
            <Btn title="Split the clip at the playhead (S)" onClick={splitAtPlayhead} disabled={project.clips.length === 0} testId="studio-split">✂ Split</Btn>
            <Btn title="Duplicate (Ctrl+D)" onClick={duplicateSelected} disabled={!sel || sel.type === "audio"}>⧉ Duplicate</Btn>
            <Btn title="Delete (Del)" onClick={removeSelected} disabled={!sel} testId="studio-delete">🗑 Delete</Btn>
            <div className="flex-1" />
            <span className="text-[11px] text-white/40">Zoom</span>
            <input type="range" min={10} max={300} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28 accent-[#6673e0]" />
          </div>
        </div>

        {/* ------------------------------------------------ inspector */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-white/10 p-3" data-testid="studio-inspector">
          {!selected && (
            <div className="flex flex-col gap-2 text-[11.5px] leading-relaxed text-white/50">
              <div className="text-[12px] font-semibold text-white/80">Nothing selected</div>
              <p>Click a clip, a text or a music block on the timeline to edit it.</p>
              <p>
                Keys: Space play · S split · Del delete · Ctrl+D duplicate · Ctrl+Z / Ctrl+Y undo / redo · ← → step a frame (Shift: 1 s)
              </p>
              <p>Output: {size.w}×{size.h}, {project.fps} fps · {formatTime(total)}</p>
            </div>
          )}
          {sel?.type === "clip" && selected && (() => {
            const c = selected as Clip;
            const i = project.clips.findIndex((x) => x.id === c.id);
            return (
              <div className="flex flex-col gap-3">
                <div className="truncate text-[12px] font-semibold" title={c.name}>{c.name}</div>
                <div className="grid grid-cols-2 gap-2">
                  <TimeInput label="From (source)" value={c.srcInMs} testId="clip-in" onCommit={(v) => patchClip(c.id, { srcInMs: Math.max(0, Math.min(v, c.srcOutMs - 200)) })} />
                  <TimeInput
                    label={c.kind === "photo" ? "Shown for" : "To (source)"}
                    value={c.kind === "photo" ? c.srcOutMs - c.srcInMs : c.srcOutMs}
                    testId="clip-out"
                    onCommit={(v) => patchClip(c.id, c.kind === "photo" ? { srcInMs: 0, srcOutMs: Math.max(200, v) } : { srcOutMs: Math.max(c.srcInMs + 200, Math.min(v, sourceMs[c.path] > 0 ? sourceMs[c.path] : v)) })}
                  />
                </div>
                <div className="text-[11px] text-white/45">On the timeline: {formatTime(clipLen(c))}</div>
                {c.kind === "video" && (
                  <>
                    <Num label="Speed" value={c.speed} min={0.25} max={4} step={0.05} suffix="×" testId="clip-speed" onChange={(v) => patchClip(c.id, { speed: v })} />
                    <Num label="Volume" value={c.volume} min={0} max={2} step={0.05} onChange={(v) => patchClip(c.id, { volume: v })} />
                    <label className="flex items-center gap-2 text-[11.5px] text-white/70">
                      <input type="checkbox" checked={c.muted} onChange={(e) => patchClip(c.id, { muted: e.target.checked })} /> Mute this clip
                    </label>
                  </>
                )}
                <div className="flex gap-1">
                  <Btn active={c.fit === "contain"} onClick={() => patchClip(c.id, { fit: "contain" })}>Fit</Btn>
                  <Btn active={c.fit === "cover"} onClick={() => patchClip(c.id, { fit: "cover" })}>Fill (crop)</Btn>
                </div>
                <Num label="Brightness" value={c.brightness} min={-0.5} max={0.5} step={0.02} onChange={(v) => patchClip(c.id, { brightness: v })} />
                <Num label="Contrast" value={c.contrast} min={0.5} max={1.5} step={0.02} onChange={(v) => patchClip(c.id, { contrast: v })} />
                <Num label="Saturation" value={c.saturation} min={0} max={2} step={0.02} onChange={(v) => patchClip(c.id, { saturation: v })} />
                {i > 0 && (
                  <div className="flex flex-col gap-1.5 rounded-md bg-white/5 p-2">
                    <span className="text-[11px] font-semibold text-white/70">Transition from the previous clip</span>
                    <select
                      data-testid="clip-transition"
                      value={c.transition?.kind ?? ""}
                      onChange={(e) => patchClip(c.id, { transition: e.target.value ? { kind: e.target.value, durationMs: c.transition?.durationMs ?? 600 } : null })}
                      className="rounded-control bg-white/10 px-2 py-1 text-[12px] outline-none"
                    >
                      <option value="">None (cut)</option>
                      {TRANSITIONS.map((tr) => (
                        <option key={tr.kind} value={tr.kind}>
                          {tr.label}
                        </option>
                      ))}
                    </select>
                    {c.transition && <Num label="Length" value={c.transition.durationMs / 1000} min={0.1} max={3} step={0.1} suffix=" s" onChange={(v) => patchClip(c.id, { transition: { ...c.transition!, durationMs: Math.round(v * 1000) } })} />}
                  </div>
                )}
              </div>
            );
          })()}
          {sel?.type === "text" && selected && (() => {
            const x = selected as TextItem;
            return (
              <div className="flex flex-col gap-3">
                <textarea
                  data-testid="text-content"
                  value={x.text}
                  onChange={(e) => live((p) => ({ ...p, texts: p.texts.map((tt) => (tt.id === x.id ? { ...tt, text: e.target.value } : tt)) }))}
                  onFocus={snapshot}
                  onKeyDown={(e) => e.stopPropagation()}
                  rows={3}
                  className="rounded-control bg-white/10 p-2 text-[13px] outline-none focus:ring-1 focus:ring-accent"
                />
                <div className="grid grid-cols-2 gap-2">
                  <TimeInput label="Start" value={x.startMs} testId="text-start" onCommit={(v) => patchText(x.id, { startMs: v, endMs: Math.max(v + 200, x.endMs) })} />
                  <TimeInput label="End" value={x.endMs} testId="text-end" onCommit={(v) => patchText(x.id, { endMs: Math.max(x.startMs + 200, v) })} />
                </div>
                <Num label="Size" value={x.size} min={16} max={240} onChange={(v) => patchText(x.id, { size: v })} />
                <label className="flex items-center justify-between text-[11.5px] text-white/70">
                  Colour <input type="color" value={x.color} onChange={(e) => patchText(x.id, { color: e.target.value })} />
                </label>
                <label className="flex items-center gap-2 text-[11.5px] text-white/70">
                  <input type="checkbox" checked={x.background} onChange={(e) => patchText(x.id, { background: e.target.checked })} /> Dark box behind
                </label>
                <label className="flex items-center gap-2 text-[11.5px] text-white/70">
                  <input type="checkbox" checked={x.bold} onChange={(e) => patchText(x.id, { bold: e.target.checked })} /> Bold
                </label>
                <p className="text-[10.5px] text-white/40">Drag the text on the preview to place it.</p>
              </div>
            );
          })()}
          {sel?.type === "audio" && selected && (() => {
            const a = selected as AudioItem;
            return (
              <div className="flex flex-col gap-3">
                <div className="truncate text-[12px] font-semibold" title={a.name}>♪ {a.name}</div>
                <div className="grid grid-cols-2 gap-2">
                  <TimeInput label="Starts at" value={a.startMs} onCommit={(v) => patchAudio(a.id, { startMs: v })} />
                  <TimeInput label="Length" value={a.srcOutMs - a.srcInMs} onCommit={(v) => patchAudio(a.id, { srcOutMs: a.srcInMs + Math.max(200, v) })} />
                </div>
                <TimeInput label="Skip the first" value={a.srcInMs} onCommit={(v) => patchAudio(a.id, { srcInMs: Math.max(0, Math.min(v, a.srcOutMs - 200)) })} />
                <Num label="Volume" value={a.volume} min={0} max={2} step={0.05} onChange={(v) => patchAudio(a.id, { volume: v })} />
                <Num label="Fade in" value={a.fadeInMs / 1000} min={0} max={10} step={0.1} suffix=" s" onChange={(v) => patchAudio(a.id, { fadeInMs: Math.round(v * 1000) })} />
                <Num label="Fade out" value={a.fadeOutMs / 1000} min={0} max={10} step={0.1} suffix=" s" onChange={(v) => patchAudio(a.id, { fadeOutMs: Math.round(v * 1000) })} />
              </div>
            );
          })()}
          {job?.status === "done" && job.out && (
            <div className="mt-4 flex flex-col gap-2 rounded-md bg-emerald-500/10 p-2 text-[11.5px] text-emerald-200">
              Exported to {job.out}
              <Btn onClick={() => void openInExplorer(null)}>Open the library folder</Btn>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------ timeline */}
      <div
        ref={tracksRef}
        data-testid="studio-timeline"
        className="relative h-[210px] shrink-0 select-none overflow-x-auto overflow-y-hidden border-t border-white/10 bg-[#0e0e14]"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDropMedia}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <div className="relative h-full" style={{ width: timelineWidth, paddingLeft: 12 }}>
          {/* ruler */}
          <div className="relative h-6 cursor-pointer border-b border-white/10" onPointerDown={(e) => beginDrag(e, "seek", "", null)} data-testid="studio-ruler">
            {ticks.map((x) => (
              <span key={x} className="absolute top-1 -translate-x-1/2 font-mono text-[9.5px] text-white/35" style={{ left: 12 + msToPx(x) }}>
                {formatTime(x, false)}
              </span>
            ))}
          </div>
          {/* text track */}
          <Track label="T">
            {project.texts.map((x) => (
              <div
                key={x.id}
                data-testid="studio-text-block"
                onPointerDown={(e) => {
                  setSel({ type: "text", id: x.id });
                  beginDrag(e, "text-move", x.id, x);
                }}
                className={`absolute inset-y-1 cursor-grab overflow-hidden rounded bg-amber-500/70 px-1.5 text-[10.5px] leading-[30px] text-black ${sel?.id === x.id ? "ring-2 ring-white" : ""}`}
                style={{ left: msToPx(x.startMs), width: Math.max(8, msToPx(x.endMs - x.startMs)) }}
              >
                {x.text}
                <div onPointerDown={(e) => beginDrag(e, "text-end", x.id, x)} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-black/25" />
              </div>
            ))}
          </Track>
          {/* main video track */}
          <Track label="▶" tall>
            {project.clips.map((c, i) => {
              const tr = transitionMs(project, i);
              return (
                <div
                  key={c.id}
                  data-testid="studio-clip"
                  data-clip-index={i}
                  onPointerDown={(e) => {
                    setSel({ type: "clip", id: c.id });
                    beginDrag(e, "clip-move", c.id, c);
                  }}
                  className={`absolute inset-y-1 cursor-grab overflow-hidden rounded-md border ${sel?.id === c.id ? "border-white ring-2 ring-accent" : "border-white/20"} ${c.kind === "photo" ? "bg-teal-700/60" : "bg-indigo-700/60"}`}
                  style={{ left: msToPx(starts[i]), width: Math.max(10, msToPx(clipLen(c))) }}
                  title={`${c.name} · ${formatTime(clipLen(c))}`}
                >
                  <ClipThumb clip={c} />
                  <span className="relative block truncate px-2 pt-1 text-[10.5px] font-medium drop-shadow">
                    {c.kind === "photo" ? "🖼 " : ""}
                    {c.name}
                  </span>
                  <span className="relative block px-2 text-[9.5px] text-white/70 drop-shadow">
                    {formatTime(clipLen(c), false)}
                    {c.speed !== 1 ? ` · ${c.speed}×` : ""}
                    {c.muted ? " · muted" : ""}
                  </span>
                  {tr > 0 && <div className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-white/40 to-transparent" style={{ width: msToPx(tr) }} title="transition" />}
                  <div data-testid="clip-handle-in" onPointerDown={(e) => beginDrag(e, "clip-in", c.id, c)} className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize bg-white/30 hover:bg-white/60" />
                  <div data-testid="clip-handle-out" onPointerDown={(e) => beginDrag(e, "clip-out", c.id, c)} className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize bg-white/30 hover:bg-white/60" />
                </div>
              );
            })}
          </Track>
          {/* music track */}
          <Track label="♪">
            {project.audio.map((a) => (
              <div
                key={a.id}
                data-testid="studio-audio-block"
                onPointerDown={(e) => {
                  setSel({ type: "audio", id: a.id });
                  beginDrag(e, "audio-move", a.id, a);
                }}
                className={`absolute inset-y-1 cursor-grab overflow-hidden rounded bg-emerald-600/70 px-1.5 text-[10.5px] leading-[30px] ${sel?.id === a.id ? "ring-2 ring-white" : ""}`}
                style={{ left: msToPx(a.startMs), width: Math.max(8, msToPx(a.srcOutMs - a.srcInMs)) }}
              >
                ♪ {a.name}
                <div onPointerDown={(e) => beginDrag(e, "audio-end", a.id, a)} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-black/25" />
              </div>
            ))}
          </Track>
          {/* playhead */}
          <div className="pointer-events-none absolute bottom-0 top-0 w-0.5 bg-white" style={{ left: 12 + msToPx(t) }}>
            <span className="absolute -left-1 top-0 h-2.5 w-2.5 rotate-45 bg-white" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Lets text on the preview scale with the stage (CSS var --stage-h). */
function StageHeight({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.style.setProperty("--stage-h", `${el.clientHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [target]);
  return null;
}

function Track({ label, tall, children }: { label: string; tall?: boolean; children: ReactNode }) {
  return (
    <div className={`relative border-b border-white/5 ${tall ? "h-[88px]" : "h-[44px]"}`}>
      <span className="pointer-events-none absolute -left-0 top-1 z-10 w-3 text-center text-[9px] text-white/30">{label}</span>
      <div className="absolute inset-y-0 left-3 right-0">{children}</div>
    </div>
  );
}

function baseClip(p: Partial<Clip> & Pick<Clip, "path" | "name" | "kind" | "srcOutMs" | "hasAudio">): Clip {
  return {
    id: newId(),
    mediaId: null,
    srcInMs: 0,
    speed: 1,
    volume: 1,
    muted: false,
    fit: "contain",
    brightness: 0,
    contrast: 1,
    saturation: 1,
    transition: null,
    ...p,
  };
}
