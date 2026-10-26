import { invoke } from "@tauri-apps/api/core";

/** [header name, value] pairs a download / stream needs (Referer, Cookie, User-Agent...). */
export type HeaderList = [string, string][];

export interface QualityOption {
  height: number;
  label: string;
}

export interface PlayInfo {
  id: string;
  title: string;
  duration: number | null;
  /** "direct": a plain file the browser seeks natively. "pipe": FFmpeg's stream, restarted with `?t=`. */
  mode: "direct" | "pipe";
  src: string;
  thumbnail: string | null;
  pageUrl: string;
  isLive: boolean;
  quality: number | null;
  qualities: QualityOption[];
  source: "media" | "page";
  hasVideo: boolean;
  hasAudio: boolean;
  extractor: string | null;
}

export interface PrepareRequest {
  url: string;
  headers?: HeaderList | null;
  quality?: number | null;
  forcePipe?: boolean;
}

export async function onlinePrepare(req: PrepareRequest): Promise<PlayInfo> {
  const r = await invoke<any>("online_prepare", {
    req: { url: req.url, headers: req.headers ?? null, quality: req.quality ?? null, force_pipe: req.forcePipe ?? null },
  });
  return {
    id: r.id,
    title: r.title,
    duration: r.duration,
    mode: r.mode,
    src: r.src,
    thumbnail: r.thumbnail,
    pageUrl: r.page_url,
    isLive: r.is_live,
    quality: r.quality,
    qualities: r.qualities,
    source: r.source,
    hasVideo: r.has_video,
    hasAudio: r.has_audio,
    extractor: r.extractor,
  };
}

export function onlineForget(id: string) {
  invoke("online_forget", { id }).catch(() => {});
}

export interface DownloadTask {
  id: string;
  url: string;
  title: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  percent: number;
  speed: number | null;
  eta: number | null;
  downloaded: number | null;
  total: number | null;
  file: string | null;
  dir: string;
  error: string | null;
  started: number;
  /** Integrity check of the finished file (opens, decodes to the end, not shorter than the source). */
  verified: boolean | null;
  warning: string | null;
}

export interface DownloadRequest {
  url: string;
  headers?: HeaderList | null;
  title?: string | null;
  quality?: number | null;
  audioOnly?: boolean;
  dir: string;
  /** Length of the source when known, so a cut-off download is flagged. */
  expectedDuration?: number | null;
  /** Name for the saved file (without extension). */
  filename?: string | null;
}

export const defaultDownloadDir = () => invoke<string>("default_download_dir");
export const downloadStart = (req: DownloadRequest) =>
  invoke<string>("download_start", {
    req: { url: req.url, headers: req.headers ?? null, title: req.title ?? null, quality: req.quality ?? null, audio_only: req.audioOnly ?? false, dir: req.dir, expected_duration: req.expectedDuration ?? null, filename: req.filename ?? null },
  });
export const downloadList = () => invoke<DownloadTask[]>("download_list");
export const downloadCancel = (id: string) => invoke("download_cancel", { id });
export const downloadRemove = (id: string) => invoke("download_remove", { id });
export const downloadClearFinished = () => invoke("download_clear_finished");
export const downloadReveal = (path: string) => invoke("download_reveal", { path });
export const pickDownloadFolder = () => invoke<string | null>("pick_download_folder");
export const engineInfo = () => invoke<{ ytdlp: string; ffmpeg: string }>("engine_info");
export const engineUpdate = () => invoke<string>("engine_update");

/* ---------------------------------------------------------------- browser --- */
export interface BrowserTab {
  id: string;
  profile: string;
  url: string;
  title: string;
  loading: boolean;
  favicon: string;
  private: boolean;
  pinned: boolean;
  audible: boolean;
  /** Has a real webview (restored / new-tab-page tabs get one when first shown). */
  live: boolean;
  newtab: boolean;
  zoom: number;
  canBack: boolean;
  canForward: boolean;
}

export interface Sniffed {
  id: string;
  url: string;
  kind: "hls" | "dash" | "video" | "audio";
  mime: string;
  size: number | null;
  headers: HeaderList;
  pageUrl: string;
  pageTitle: string;
  time: number;
  hint: string | null;
}

export function mapSniffed(r: any): Sniffed {
  return {
    id: r.id,
    url: r.url,
    kind: r.kind,
    mime: r.mime,
    size: r.size,
    headers: r.headers,
    pageUrl: r.page_url,
    pageTitle: r.page_title,
    time: r.time,
    hint: r.hint,
  };
}

export const browserOpen = (profile: string, url?: string, priv?: boolean) => invoke<string>("browser_open", { profile, url: url ?? null, private: priv ?? false });
export const browserTabs = () => invoke<BrowserTab[]>("browser_tabs");
export const browserNavigate = (id: string, url: string) => invoke("browser_navigate", { id, url });
export const browserAction = (id: string, action: "back" | "forward" | "reload" | "hard-reload" | "stop") => invoke("browser_action", { id, action });
export const browserClose = (id: string) => invoke("browser_close", { id });
export const browserActivate = (id: string) => invoke("browser_activate", { id });
export const browserHideAll = () => invoke("browser_hide_all");
export const browserShowActive = () => invoke("browser_show_active");
export const browserSetBounds = (x: number, y: number, w: number, h: number) => invoke("browser_set_bounds", { x, y, w, h });
export const browserSniffed = async (id: string) => (await invoke<any[]>("browser_sniffed", { id })).map(mapSniffed);
export const browserClearSniffed = (id: string) => invoke("browser_clear_sniffed", { id });

/* ------------------------------------------------------- media on the page --- */
export type MediaGroup = "video" | "audio" | "other";
export type MediaMode = "auto" | "gestures" | "site" | "off";

export interface MediaVariant {
  height: number;
  label: string;
}

export interface MediaItem {
  id: string;
  domId: string | null;
  variants: MediaVariant[];
  filename: string;
  group: MediaGroup;
  format: string;
  url: string | null;
  headers: HeaderList;
  title: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  size: number | null;
  live: boolean;
  dvr: boolean;
  protected: string | null;
  aes: boolean;
  /** Base64 JPEG. */
  thumb: string | null;
  active: boolean;
  playing: boolean;
  buffer: string | null;
  viaPage: boolean;
  canPlay: boolean;
  canDownload: boolean;
  note: string | null;
  source: "network" | "page" | "both";
  pageUrl: string;
  pageTitle: string;
  time: number;
}

export interface MediaConfig {
  mode: MediaMode;
  origins: Record<string, MediaMode>;
  seek: number;
  corner: "br" | "bl" | "tr" | "tl";
  longPress: boolean;
  preload: boolean;
  popupKey: string;
  fab: boolean;
  badge: boolean;
}

export const browserMediaItems = (id: string) => invoke<MediaItem[]>("browser_media_items", { id });
export const browserMediaConfig = (cfg: MediaConfig) => invoke("browser_media_config", { cfg });
export const browserMediaCmd = (id: string, op: string, value?: number) => invoke("browser_media_cmd", { id, op, value: value ?? null });
export const browserMediaAction = (id: string, op: string, item?: string, group?: MediaGroup) =>
  invoke("browser_media_action", { id, op, item: item ?? null, group: group ?? null });
export const browserPopup = (id: string, op: "open" | "close" | "toggle") => invoke("browser_popup", { id, op });
export const browserPopupNotice = (id: string, text: string) => invoke("browser_popup_notice", { id, text });

export const browserPopupTask = (id: string, item: string, task: string) => invoke("browser_popup_task", { id, item, task });

/* -------------------------------------------------------- profiles, bookmarks, history --- */
export interface BrowserProfile {
  id: string;
  name: string;
  color: string;
  created: number;
  lastUsed: number;
  tabs: number;
  bookmarks: number;
  size: number;
}
export interface Bookmark {
  id: string;
  title: string;
  url: string;
  created: number;
}
export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  time: number;
  visits: number;
}
export interface Suggestion {
  kind: "history" | "bookmark";
  title: string;
  url: string;
}
export interface BrowserSettings {
  search: "duckduckgo" | "google" | "bing" | "brave" | "ecosia";
  bookmarksBar: boolean;
  restoreTabs: boolean;
}

export const browserProfiles = () => invoke<BrowserProfile[]>("browser_profiles");
export const browserProfileCreate = (name: string, color?: string) => invoke<BrowserProfile>("browser_profile_create", { name, color: color ?? null });
export const browserProfileRename = (id: string, name: string, color?: string) => invoke<BrowserProfile>("browser_profile_rename", { id, name, color: color ?? null });
export const browserProfileDelete = (id: string) => invoke("browser_profile_delete", { id });
export const browserProfileClear = (id: string) => invoke("browser_profile_clear", { id });
export const browserRestoreSession = (profile: string) => invoke<{ ids: string[]; active: number }>("browser_restore_session", { profile });
export const browserReorder = (ids: string[]) => invoke("browser_reorder", { ids });
export const browserPin = (id: string, pinned: boolean) => invoke("browser_pin", { id, pinned });
export const browserDuplicate = (id: string) => invoke<string>("browser_duplicate", { id });
export const browserReopen = (profile: string) => invoke<string>("browser_reopen", { profile });
export const browserZoom = (id: string, op: "in" | "out" | "reset") => invoke<number>("browser_zoom", { id, op });
export const browserDevtools = (id: string) => invoke("browser_devtools", { id });
export const browserPrint = (id: string) => invoke("browser_print", { id });
export const browserFind = (id: string, text: string, forward: boolean, caseSensitive: boolean) => invoke("browser_find", { id, text, forward, caseSensitive });
export const browserFindClear = (id: string) => invoke("browser_find_clear", { id });
export const browserBookmarks = (profile: string) => invoke<Bookmark[]>("browser_bookmarks", { profile });
export const browserBookmarkToggle = (profile: string, url: string, title: string) => invoke<boolean>("browser_bookmark_toggle", { profile, url, title });
export const browserIsBookmarked = (profile: string, url: string) => invoke<boolean>("browser_is_bookmarked", { profile, url });
export const browserBookmarkRemove = (profile: string, id: string) => invoke("browser_bookmark_remove", { profile, id });
export const browserHistory = (profile: string, query?: string, limit?: number) => invoke<HistoryEntry[]>("browser_history", { profile, query: query ?? null, limit: limit ?? null });
export const browserHistoryRemove = (profile: string, id: string) => invoke("browser_history_remove", { profile, id });
export const browserHistoryClear = (profile: string) => invoke("browser_history_clear", { profile });
export const browserSuggest = (profile: string, query: string) => invoke<Suggestion[]>("browser_suggest", { profile, query });
export const browserSettings = () => invoke<BrowserSettings>("browser_settings");
export const browserSettingsSet = (settings: BrowserSettings) => invoke<BrowserSettings>("browser_settings_set", { settings });

/* ------------------------------------------------------------------ extensions --- */
export interface Extension {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
  source: "builtin" | "store" | "folder";
  icon: string | null;
  manifest: number;
}
export const browserExtensions = () => invoke<Extension[]>("browser_extensions");
export const browserExtensionToggle = (id: string, enabled: boolean) => invoke("browser_extension_toggle", { id, enabled });
export const browserExtensionRemove = (id: string) => invoke("browser_extension_remove", { id });
export const browserExtensionInstall = (input: string) => invoke<Extension>("browser_extension_install", { input });
export const browserExtensionInstallFolder = () => invoke<Extension | null>("browser_extension_install_folder");
export const browserReloadEngines = (profile: string) => invoke("browser_reload_engines", { profile });
