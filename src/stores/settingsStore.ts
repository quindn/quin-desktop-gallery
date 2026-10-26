import { create } from "zustand";

const SEEK_STEP_KEY = "qpg.seekStepSec";
const DEFAULT_SEEK_STEP = 10;
const PAGE_SIZE_KEY = "qpg.pageSize";
const DEFAULT_PAGE_SIZE = 120;
const RAIN_KEY = "qpg.rainAnimation";
const RAIN_FPS_KEY = "qpg.rainFps";
const RESUME_KEY = "qpg.resumePlayback";
const FAV_KEY = "qpg.favoriteKey";

/** Keys next to the arrow keys that can toggle Favorite in the viewer. */
export const FAVORITE_KEYS = [
  { code: "Enter", label: "Enter" },
  { code: "End", label: "End" },
  { code: "Slash", label: "/" },
  { code: "ShiftRight", label: "Right Shift" },
  { code: "ControlRight", label: "Right Ctrl" },
  { code: "Numpad0", label: "Num 0" },
  { code: "Insert", label: "Insert" },
] as const;
export type FavoriteKey = (typeof FAVORITE_KEYS)[number]["code"];

function loadString<T extends string>(key: string, allowed: readonly string[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw && allowed.includes(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function loadNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw ? Number(raw) : fallback;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function saveNumber(key: string, n: number) {
  try {
    localStorage.setItem(key, String(n));
  } catch {
    // Private window / storage disabled — the in-memory value still works
    // for this session, it just won't persist across restarts.
  }
}

interface SettingsStore {
  /** Seconds ArrowLeft/ArrowRight seeks a video by in the viewer — a
   * per-device UI preference, not app data, so it lives in localStorage
   * rather than the sandboxed root's database. */
  seekStepSec: number;
  setSeekStepSec: (n: number) => void;
  /** How many items the gallery grid shows per page. */
  pageSize: number;
  setPageSize: (n: number) => void;
  /** Animated raindrops running down the window backdrop. */
  rainAnimation: boolean;
  setRainAnimation: (on: boolean) => void;
  /** Frames per second the rain is drawn at (a lower number is lighter on the machine and on remote screens). */
  rainFps: 15 | 30 | 60;
  setRainFps: (n: 15 | 30 | 60) => void;
  /** Reopening a video continues where it was left (otherwise always from the start). */
  resumePlayback: boolean;
  setResumePlayback: (on: boolean) => void;
  /** The key that toggles Favorite in the viewer. */
  favoriteKey: FavoriteKey;
  setFavoriteKey: (k: FavoriteKey) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  seekStepSec: loadNumber(SEEK_STEP_KEY, DEFAULT_SEEK_STEP),
  setSeekStepSec: (n) => {
    saveNumber(SEEK_STEP_KEY, n);
    set({ seekStepSec: n });
  },
  pageSize: loadNumber(PAGE_SIZE_KEY, DEFAULT_PAGE_SIZE),
  setPageSize: (n) => {
    saveNumber(PAGE_SIZE_KEY, n);
    set({ pageSize: n });
  },
  rainAnimation: loadBool(RAIN_KEY, true),
  setRainAnimation: (on) => {
    try {
      localStorage.setItem(RAIN_KEY, on ? "1" : "0");
    } catch {
      // Storage disabled: still applies for this session.
    }
    set({ rainAnimation: on });
  },
  rainFps: ((n) => (n === 15 || n === 60 ? n : 30) as 15 | 30 | 60)(loadNumber(RAIN_FPS_KEY, 30)),
  setRainFps: (n) => {
    saveNumber(RAIN_FPS_KEY, n);
    set({ rainFps: n });
  },
  resumePlayback: loadBool(RESUME_KEY, true),
  setResumePlayback: (on) => {
    try {
      localStorage.setItem(RESUME_KEY, on ? "1" : "0");
    } catch {
      // storage disabled: applies to this session
    }
    set({ resumePlayback: on });
  },
  favoriteKey: loadString<FavoriteKey>(FAV_KEY, FAVORITE_KEYS.map((k) => k.code), "Enter"),
  setFavoriteKey: (k) => {
    try {
      localStorage.setItem(FAV_KEY, k);
    } catch {
      // storage disabled
    }
    set({ favoriteKey: k });
  },
}));
