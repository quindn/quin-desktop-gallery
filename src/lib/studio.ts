import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

// Studio: the CapCut-style editor. Types mirror src-tauri/src/editor/studio.rs (camelCase JSON).

export interface Transition {
  kind: string;
  durationMs: number;
}
export interface Clip {
  id: string;
  path: string;
  name: string;
  mediaId: number | null;
  kind: "video" | "photo";
  srcInMs: number;
  srcOutMs: number;
  speed: number;
  volume: number;
  muted: boolean;
  hasAudio: boolean;
  fit: "contain" | "cover";
  brightness: number;
  contrast: number;
  saturation: number;
  transition: Transition | null;
  /** Full length of the source (not saved by the backend; filled in on load). */
  sourceMs?: number;
}
export interface TextItem {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  size: number;
  color: string;
  background: boolean;
  bold: boolean;
}
export interface AudioItem {
  id: string;
  path: string;
  name: string;
  startMs: number;
  srcInMs: number;
  srcOutMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
}
export interface Project {
  id: string;
  name: string;
  aspect: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  resolution: number;
  fps: number;
  clips: Clip[];
  texts: TextItem[];
  audio: AudioItem[];
  createdAt: number;
  updatedAt: number;
}
export interface FileInfo {
  path: string;
  name: string;
  durationMs: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

export const TRANSITIONS: { kind: string; label: string }[] = [
  { kind: "fade", label: "Cross fade" },
  { kind: "fadeblack", label: "Dip to black" },
  { kind: "fadewhite", label: "Dip to white" },
  { kind: "dissolve", label: "Dissolve" },
  { kind: "slideleft", label: "Slide left" },
  { kind: "slideright", label: "Slide right" },
  { kind: "slideup", label: "Slide up" },
  { kind: "wipeleft", label: "Wipe left" },
  { kind: "wiperight", label: "Wipe right" },
  { kind: "circleopen", label: "Circle open" },
  { kind: "zoomin", label: "Zoom in" },
  { kind: "smoothleft", label: "Smooth left" },
  { kind: "radial", label: "Radial" },
  { kind: "pixelize", label: "Pixelize" },
];

export const newId = () => Math.random().toString(36).slice(2, 10);

export function emptyProject(): Project {
  return { id: "", name: "Untitled project", aspect: "16:9", resolution: 1080, fps: 30, clips: [], texts: [], audio: [], createdAt: 0, updatedAt: 0 };
}

export const clipLen = (c: Clip) => Math.max(0, Math.round((c.srcOutMs - c.srcInMs) / Math.min(10, Math.max(0.1, c.speed))));

/** The transition into clip i, made to fit (same rule as the renderer). */
export function transitionMs(p: Project, i: number): number {
  if (i === 0) return 0;
  const t = p.clips[i].transition;
  if (!t) return 0;
  const room = Math.min(clipLen(p.clips[i - 1]), clipLen(p.clips[i])) - 100;
  return Math.max(0, Math.min(t.durationMs, Math.max(0, room)));
}

/** Where each clip starts on the timeline, and the total length. */
export function layout(p: Project): { starts: number[]; total: number } {
  const starts: number[] = [];
  let at = 0;
  p.clips.forEach((c, i) => {
    at -= transitionMs(p, i);
    starts.push(at);
    at += clipLen(c);
  });
  return { starts, total: Math.max(0, at) };
}

/** The clip shown at timeline time t (the incoming one during a transition), or -1. */
export function clipAt(p: Project, starts: number[], t: number): number {
  for (let i = p.clips.length - 1; i >= 0; i--) if (t >= starts[i] && t < starts[i] + clipLen(p.clips[i])) return i;
  return p.clips.length && t >= 0 ? p.clips.length - 1 : -1;
}

export function frameSize(p: Project): { w: number; h: number } {
  const [a, b] = p.aspect.split(":").map(Number);
  const short = p.resolution;
  return a >= b ? { w: Math.round((short * a) / b / 2) * 2, h: short } : { w: short, h: Math.round((short * b) / a / 2) * 2 };
}

/** Splits clip i at timeline time t (both halves keep the clip's settings; the second has no transition). */
export function splitClip(p: Project, i: number, t: number): Project | null {
  const { starts } = layout(p);
  const c = p.clips[i];
  const into = (t - starts[i]) * c.speed;
  if (into < 150 || c.srcOutMs - c.srcInMs - into < 150) return null;
  const cut = Math.round(c.srcInMs + into);
  const a = { ...c, srcOutMs: cut };
  const b = { ...c, id: newId(), srcInMs: cut, transition: null };
  return { ...p, clips: [...p.clips.slice(0, i), a, b, ...p.clips.slice(i + 1)] };
}

// ------------------------------------------------------------------ backend

export const studioList = () => invoke<Project[]>("studio_list");
export const studioLoad = (id: string) => invoke<Project>("studio_load", { id });
export const studioSave = (project: Project) => invoke<Project>("studio_save", { project });
export const studioDelete = (id: string) => invoke("studio_delete", { id });
export const studioFileInfo = (path: string) => invoke<FileInfo>("studio_file_info", { path });
export const studioPickFiles = (kind: "audio" | "media") => invoke<FileInfo[]>("studio_pick_files", { kind });
export const studioStreamUrl = (path: string) => invoke<string>("studio_stream_url", { path });
export const studioExport = (project: Project) => invoke<{ jobId: string; outputPath: string }>("studio_export", { project });

/** Library items asked to be added to the Studio ("Add to Studio" in the grid). */
export const useStudioInbox = create<{ ids: number[]; push: (ids: number[]) => void; take: () => number[] }>((set, get) => ({
  ids: [],
  push: (ids) => set((s) => ({ ids: [...s.ids, ...ids] })),
  take: () => {
    const ids = get().ids;
    set({ ids: [] });
    return ids;
  },
}));
