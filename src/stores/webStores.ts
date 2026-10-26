import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  browserMediaConfig,
  browserMediaItems,
  browserPopupNotice,
  browserPopupTask,
  browserSettings,
  browserSettingsSet,
  browserSniffed,
  downloadReveal,
  defaultDownloadDir,
  downloadList,
  downloadStart,
  mapSniffed,
  type BrowserSettings,
  type BrowserTab,
  type DownloadTask,
  type HeaderList,
  type MediaConfig,
  type MediaItem,
  type MediaMode,
  type Sniffed,
} from "../lib/online";
import { copyText } from "../lib/clipboard";
import { useGalleryStore } from "./galleryStore";

/* A native browser view sits ABOVE all web content, so any HTML overlay
 * (dialogs, menus) has to tell the browser to step aside while it is open. */
interface OverlayStore {
  count: number;
  push: () => void;
  pop: () => void;
}
export const useOverlayStore = create<OverlayStore>((set) => ({
  count: 0,
  push: () => set((s) => ({ count: s.count + 1 })),
  pop: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}));

/* "Play this link" from anywhere (the browser's video list, a pasted URL...) to the Online view. */
export interface PlayRequest {
  url: string;
  headers?: HeaderList | null;
  title?: string;
  key: number;
}
interface HandoffStore {
  request: PlayRequest | null;
  play: (url: string, headers?: HeaderList | null, title?: string) => void;
  clear: () => void;
}
export const useHandoffStore = create<HandoffStore>((set) => ({
  request: null,
  play: (url, headers, title) => set({ request: { url, headers: headers ?? null, title, key: Date.now() } }),
  clear: () => set({ request: null }),
}));

/* ---------------------------------------------------------------- downloads --- */
const DIR_KEY = "qpg.downloadDir";
function loadDir(): string | null {
  try {
    return localStorage.getItem(DIR_KEY) || null;
  } catch {
    return null;
  }
}

interface DownloadStore {
  tasks: DownloadTask[];
  /** User's chosen folder; null = "<library>/Downloads". */
  dir: string | null;
  setDir: (dir: string | null) => void;
  upsert: (t: DownloadTask) => void;
  remove: (id: string) => void;
  start: (req: { url: string; headers?: HeaderList | null; title?: string | null; quality?: number | null; audioOnly?: boolean; expectedDuration?: number | null; filename?: string | null }) => Promise<string>;
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  tasks: [],
  dir: loadDir(),
  setDir: (dir) => {
    try {
      if (dir) localStorage.setItem(DIR_KEY, dir);
      else localStorage.removeItem(DIR_KEY);
    } catch {
      // storage disabled
    }
    set({ dir });
  },
  upsert: (t) =>
    set((s) => {
      const i = s.tasks.findIndex((x) => x.id === t.id);
      if (i < 0) return { tasks: [t, ...s.tasks] };
      const next = s.tasks.slice();
      next[i] = t;
      return { tasks: next };
    }),
  remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  start: async (req) => {
    const dir = get().dir ?? (await defaultDownloadDir());
    return downloadStart({ ...req, dir });
  },
}));

/* ------------------------------------------------------------------- browser --- */
interface BrowserStore {
  tabs: BrowserTab[];
  activeId: string | null;
  /** The profile whose tabs are shown; null = the Profile Manager. */
  profileId: string | null;
  setProfile: (id: string | null) => void;
  reorder: (ids: string[]) => void;
  sniffed: Record<string, Sniffed[]>;
  setActive: (id: string | null) => void;
  upsertTab: (t: BrowserTab) => void;
  removeTab: (id: string) => void;
  setSniffed: (tab: string, items: Sniffed[]) => void;
  addSniffed: (tab: string, item: Sniffed) => void;
}

export const useBrowserStore = create<BrowserStore>((set) => ({
  tabs: [],
  activeId: null,
  profileId: null,
  setProfile: (profileId) => set({ profileId }),
  reorder: (ids) =>
    set((s) => {
      const byId = new Map(s.tabs.map((t) => [t.id, t]));
      const sorted = ids.map((i) => byId.get(i)).filter((t): t is BrowserTab => !!t);
      const rest = s.tabs.filter((t) => !ids.includes(t.id));
      return { tabs: [...sorted, ...rest] };
    }),
  sniffed: {},
  setActive: (activeId) => set({ activeId }),
  upsertTab: (t) =>
    set((s) => {
      const i = s.tabs.findIndex((x) => x.id === t.id);
      if (i < 0) return { tabs: [...s.tabs, t] };
      const next = s.tabs.slice();
      next[i] = t;
      return { tabs: next };
    }),
  removeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const { [id]: _gone, ...sniffed } = s.sniffed;
      return { tabs, sniffed, activeId: s.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeId };
    }),
  setSniffed: (tab, items) => set((s) => ({ sniffed: { ...s.sniffed, [tab]: items } })),
  addSniffed: (tab, item) =>
    set((s) => {
      const list = (s.sniffed[tab] ?? []).slice();
      const key = (u: string) => {
        try {
          const p = new URL(u);
          return p.host + p.pathname;
        } catch {
          return u;
        }
      };
      const i = list.findIndex((x) => x.id === item.id || key(x.url) === key(item.url));
      if (i >= 0) list[i] = item;
      else list.push(item);
      return { sniffed: { ...s.sniffed, [tab]: list } };
    }),
}));

/* ------------------------------------------------ media list + player settings --- */
interface MediaStore {
  items: Record<string, MediaItem[]>;
  set: (tab: string, items: MediaItem[]) => void;
}
export const useMediaStore = create<MediaStore>((set) => ({
  items: {},
  set: (tab, items) => set((s) => ({ items: { ...s.items, [tab]: items } })),
}));

const MEDIA_CFG_KEY = "qg.mediaCfg";
const DEFAULT_MEDIA_CFG: MediaConfig = { mode: "auto", origins: {}, seek: 10, corner: "br", longPress: true, preload: true, popupKey: "Alt+M", fab: true, badge: true };

function loadMediaCfg(): MediaConfig {
  try {
    const raw = localStorage.getItem(MEDIA_CFG_KEY);
    if (raw) return { ...DEFAULT_MEDIA_CFG, ...JSON.parse(raw) };
  } catch {
    // corrupt or unavailable: defaults
  }
  return DEFAULT_MEDIA_CFG;
}

interface MediaCfgStore {
  cfg: MediaConfig;
  patch: (p: Partial<MediaConfig>) => void;
  /** null = follow the default mode for that site. */
  setSiteMode: (host: string, mode: MediaMode | null) => void;
}
export const useMediaCfg = create<MediaCfgStore>((set, get) => {
  const commit = (cfg: MediaConfig) => {
    try {
      localStorage.setItem(MEDIA_CFG_KEY, JSON.stringify(cfg));
    } catch {
      // storage disabled
    }
    set({ cfg });
    void browserMediaConfig(cfg).catch(() => {});
  };
  return {
    cfg: loadMediaCfg(),
    patch: (p) => commit({ ...get().cfg, ...p }),
    setSiteMode: (host, mode) => {
      const origins = { ...get().cfg.origins };
      if (mode) origins[host] = mode;
      else delete origins[host];
      commit({ ...get().cfg, origins });
    },
  };
});

/** Sends the saved player settings to the backend (it applies them to every open page). */
export function pushMediaConfig() {
  void browserMediaConfig(useMediaCfg.getState().cfg).catch(() => {});
}

/** Re-reads a tab's media list (after switching tabs). */
export async function refreshMedia(tab: string) {
  try {
    useMediaStore.getState().set(tab, await browserMediaItems(tab));
  } catch {
    // tab closed meanwhile
  }
}

const targetOf = (item: MediaItem) => ({ url: item.url ?? item.pageUrl, headers: item.url ? item.headers : null });

/** Starts one download and tells the page popup which row it belongs to (so progress shows there). */
async function startItemDownload(tab: string, item: MediaItem, opts: { quality?: number | null; name?: string | null } = {}) {
  const { url, headers } = targetOf(item);
  const id = await useDownloadStore.getState().start({
    url,
    headers,
    title: item.title,
    quality: opts.quality || null,
    expectedDuration: item.live ? null : item.duration,
    filename: opts.name || null,
  });
  void browserPopupTask(tab, item.id, id).catch(() => {});
  return id;
}

/** Plays / downloads / copies one item of the media list. Used by the panel AND by the popup inside the page. */
export async function runMediaAction(tab: string, op: string, item: MediaItem, opts: { quality?: number | null; name?: string | null } = {}): Promise<string> {
  const { url, headers } = targetOf(item);
  let note = "";
  try {
    if (op === "download") {
      await startItemDownload(tab, item, opts);
      note = "Download started";
    } else if (op === "play") {
      useHandoffStore.getState().play(url, headers, item.title);
      useGalleryStore.getState().setMainView("online");
      note = "Opening in the player";
    } else if (op === "copy") {
      note = (await copyText(url)) ? "Link copied" : "Copy failed";
    }
  } catch (e) {
    note = String(e);
  }
  void browserPopupNotice(tab, note).catch(() => {});
  return note;
}

/** "Download all": a few at a time, so a page with twenty videos does not start twenty engines. */
export async function runDownloadAll(tab: string, items: MediaItem[]) {
  const MAX_PARALLEL = 3;
  const running = () => useDownloadStore.getState().tasks.filter((t) => t.status === "running" || t.status === "queued").length;
  let started = 0;
  for (const item of items) {
    while (running() >= MAX_PARALLEL) await new Promise((r) => setTimeout(r, 600));
    try {
      await startItemDownload(tab, item);
      started++;
      void browserPopupNotice(tab, `Started ${started} of ${items.length}`).catch(() => {});
    } catch {
      // keep going with the rest
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  void browserPopupNotice(tab, started === items.length ? `${started} downloads started` : `${started} of ${items.length} started`).catch(() => {});
}

/* ------------------------------------------------ browser settings + shortcut bus --- */
interface BrowserSettingsStore {
  settings: BrowserSettings;
  load: () => Promise<void>;
  patch: (p: Partial<BrowserSettings>) => Promise<void>;
}
export const useBrowserSettings = create<BrowserSettingsStore>((set, get) => ({
  settings: { search: "duckduckgo", bookmarksBar: true, restoreTabs: true },
  load: async () => {
    try {
      set({ settings: await browserSettings() });
    } catch {
      // keep defaults
    }
  },
  patch: async (p) => {
    const next = { ...get().settings, ...p };
    set({ settings: next });
    try {
      set({ settings: await browserSettingsSet(next) });
    } catch {
      // keep the local value
    }
  },
}));

type ShortcutFn = (key: string, tab: string) => void;
const shortcutListeners = new Set<ShortcutFn>();
/** Browser shortcuts pressed while a page has the keyboard (forwarded by the page agent). */
export function onBrowserShortcut(fn: ShortcutFn): () => void {
  shortcutListeners.add(fn);
  return () => shortcutListeners.delete(fn);
}
type FindFn = (r: { tab: string; ok: boolean; count: number }) => void;
const findListeners = new Set<FindFn>();
export function onFindResult(fn: FindFn): () => void {
  findListeners.add(fn);
  return () => findListeners.delete(fn);
}

let started = false;

/** Wires the backend's events into the stores. Call once at startup. */
export function initWebEvents() {
  if (started) return;
  started = true;

  downloadList()
    .then((list) => list.forEach((t) => useDownloadStore.getState().upsert(t)))
    .catch(() => {});
  listen<DownloadTask>("dl://update", (e) => useDownloadStore.getState().upsert(e.payload));
  listen<string>("dl://removed", (e) => useDownloadStore.getState().remove(e.payload));

  listen<BrowserTab>("browser://tab", (e) => useBrowserStore.getState().upsertTab(e.payload));
  listen<string>("browser://closed", (e) => useBrowserStore.getState().removeTab(e.payload));
  listen<{ tab: string; item: any }>("browser://sniff", (e) => useBrowserStore.getState().addSniffed(e.payload.tab, mapSniffed(e.payload.item)));
  listen<string>("browser://sniff-cleared", (e) => useBrowserStore.getState().setSniffed(e.payload, []));
  listen<{ tab: string; items: MediaItem[] }>("browser://media-items", (e) => useMediaStore.getState().set(e.payload.tab, e.payload.items));
  // A button or shortcut in the popup inside the page.
  listen<{ tab: string; op: string; item?: MediaItem; items?: MediaItem[]; quality?: number | null; name?: string | null; file?: string; text?: string }>("browser://media-action", (e) => {
    const { tab, op, item, items, quality, name, file, text } = e.payload;
    if (op === "downloadAll" && items) void runDownloadAll(tab, items);
    else if (op === "reveal" && file) void downloadReveal(file).catch(() => {});
    else if (op === "copy-text" && text) void copyText(text);
    else if (item) void runMediaAction(tab, op, item, { quality, name });
  });
  listen<string[]>("browser://order", (e) => useBrowserStore.getState().reorder(e.payload));
  listen<{ tab: string; key: string }>("browser://shortcut", (e) => shortcutListeners.forEach((f) => f(e.payload.key, e.payload.tab)));
  listen<{ tab: string; ok: boolean; count: number }>("browser://find", (e) => findListeners.forEach((f) => f(e.payload)));
  listen<string>("browser://focus-tab", (e) => useBrowserStore.getState().setActive(e.payload));
  void useBrowserSettings.getState().load();
  pushMediaConfig();
  // A download started by clicking a file link inside a page.
  listen<{ url: string; referer: string }>("browser://download-request", (e) => {
    const headers: HeaderList | null = e.payload.referer ? [["Referer", e.payload.referer]] : null;
    useDownloadStore
      .getState()
      .start({ url: e.payload.url, headers })
      .catch(() => {});
  });
}

/** Re-reads the sniffed list for a tab (after switching tabs). */
export async function refreshSniffed(tab: string) {
  try {
    useBrowserStore.getState().setSniffed(tab, await browserSniffed(tab));
  } catch {
    // tab closed meanwhile
  }
}
