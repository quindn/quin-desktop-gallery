import { create } from "zustand";
import type { RecentRoot, RootInfo, ScanProgress } from "../lib/api";

export type AppPhase = "loading" | "onboarding" | "ready";

interface RootStore {
  phase: AppPhase;
  root: RootInfo | null;
  recentRoots: RecentRoot[];
  scanProgress: ScanProgress | null;
  error: string | null;
  /** A one-line, dismissible note about something the app did on its own (recovered the
   *  library automatically, rebuilt a damaged index) — not an error, just worth mentioning. */
  notice: string | null;
  /** A button next to the notice. */
  noticeAction: "restart" | null;

  setLoading: () => void;
  setOnboarding: (recentRoots: RecentRoot[]) => void;
  setRoot: (root: RootInfo) => void;
  setRecentRoots: (recentRoots: RecentRoot[]) => void;
  setScanProgress: (progress: ScanProgress | null) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null, action?: "restart" | null) => void;
}

export const useRootStore = create<RootStore>((set) => ({
  phase: "loading",
  root: null,
  recentRoots: [],
  scanProgress: null,
  error: null,
  notice: null,
  noticeAction: null,

  setLoading: () => set({ phase: "loading" }),
  setOnboarding: (recentRoots) => set({ phase: "onboarding", recentRoots, root: null }),
  setRoot: (root) => set({ phase: "ready", root, error: null }),
  setRecentRoots: (recentRoots) => set({ recentRoots }),
  setScanProgress: (scanProgress) => set({ scanProgress }),
  setError: (error) => set({ error }),
  setNotice: (notice, action = null) => set({ notice, noticeAction: notice ? action : null }),
}));
