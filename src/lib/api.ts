import { invoke } from "@tauri-apps/api/core";

export interface RootInfo {
  canonicalPath: string;
  displayName: string;
  id: string;
  /** This library's index had to be rebuilt from scratch (its database looked corrupt); the
   *  media files themselves are untouched, but favorites/ratings/tags/thumbnails for it are
   *  gone and a rescan is already under way. */
  repaired: boolean;
}

export interface RecentRoot {
  canonicalPath: string;
  displayName: string;
  lastOpened: number;
  dbPath: string;
}

export interface StartupInfo {
  lastRootPath: string | null;
  recentRoots: RecentRoot[];
  /** `lastRootPath` was not on record (or its folder wasn't reachable) — it was instead found
   *  by looking for a library database under `data/roots/` whose folder still exists. */
  restored: boolean;
}

export type MediaType = "all" | "photo" | "video" | "animated" | "other";
export type SortBy = "name" | "similar_name" | "date_modified" | "date_created" | "date_taken" | "duration" | "size" | "width" | "height";

export interface MediaQuery {
  folderRelPath: string | null;
  includeSubfolders: boolean;
  mediaType: MediaType;
  sortBy: SortBy;
  sortDesc: boolean;
  limit: number;
  offset: number;
  search: string | null;
  durationMinMs: number | null;
  durationMaxMs: number | null;
  sizeMinBytes: number | null;
  sizeMaxBytes: number | null;
  modifiedAfter: number | null;
  modifiedBefore: number | null;
  favoritesOnly: boolean;
  minRating: number | null;
  metadataStates: string[] | null;
  tag: string | null;
  orientation: "landscape" | "portrait" | "square" | null;
}

export interface MediaListItem {
  id: number;
  relPath: string;
  filename: string;
  extension: string;
  folderRelPath: string;
  mediaType: string;
  fileSize: number;
  createdTime: number;
  modifiedTime: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbnailState: string;
  metadataState: string;
  favorite: boolean;
  rating: number;
  dateTaken: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
}

export interface MediaPage {
  items: MediaListItem[];
  total: number;
}

export interface FolderNode {
  relPath: string;
  parentRelPath: string | null;
  name: string;
  mediaCount: number;
  depth: number;
}

export interface LibraryStats {
  total: number;
  photos: number;
  videos: number;
  totalSize: number;
}

export interface ScanProgress {
  scanned: number;
  touched: number;
  currentFolder: string;
  done: boolean;
  /** "new-folders" while newly discovered folders are indexed first. */
  phase: "new-folders" | "full" | "watch";
}

// Tauri camelCases top-level command *parameter names* automatically, but
// struct fields (nested objects, return values) use whatever casing the
// Rust struct declares — snake_case here, since none of them opt into
// `rename_all`. This module is the one place that boundary is crossed,
// so the rest of the app can stay in camelCase.

export async function getStartupInfo(): Promise<StartupInfo> {
  const raw = await invoke<any>("get_startup_info");
  return {
    lastRootPath: raw.last_root_path,
    recentRoots: raw.recent_roots.map(mapRecentRoot),
    restored: raw.restored,
  };
}

function mapRecentRoot(r: any): RecentRoot {
  return {
    canonicalPath: r.canonical_path,
    displayName: r.display_name,
    lastOpened: r.last_opened,
    dbPath: r.db_path,
  };
}

function mapRootInfo(r: any): RootInfo {
  return { canonicalPath: r.canonical_path, displayName: r.display_name, id: r.id, repaired: r.repaired };
}

export async function openRoot(path: string): Promise<RootInfo> {
  const raw = await invoke<any>("open_root", { path });
  return mapRootInfo(raw);
}

export async function pickRootFolder(): Promise<RootInfo | null> {
  const raw = await invoke<any>("pick_root_folder");
  return raw ? mapRootInfo(raw) : null;
}

export async function removeRecentRoot(canonicalPath: string): Promise<void> {
  await invoke("remove_recent_root", { canonicalPath });
}

export async function rescanRoot(): Promise<void> {
  await invoke("rescan_root");
}

/** The fast path: only look for folders added since the last scan and index those, instead of
 *  re-walking and re-checking every existing file like `rescanRoot` does. */
export async function scanNewFolders(): Promise<void> {
  await invoke("scan_new_folders");
}

export async function openInExplorer(relPath: string | null): Promise<void> {
  await invoke("open_in_explorer", { relPath });
}

function mapMediaItem(r: any): MediaListItem {
  return {
    id: r.id,
    relPath: r.rel_path,
    filename: r.filename,
    extension: r.extension,
    folderRelPath: r.folder_rel_path,
    mediaType: r.media_type,
    fileSize: r.file_size,
    createdTime: r.created_time,
    modifiedTime: r.modified_time,
    width: r.width,
    height: r.height,
    durationMs: r.duration_ms,
    thumbnailState: r.thumbnail_state,
    metadataState: r.metadata_state,
    favorite: r.favorite,
    rating: r.rating,
    dateTaken: r.date_taken,
    cameraMake: r.camera_make,
    cameraModel: r.camera_model,
    gpsLat: r.gps_lat,
    gpsLon: r.gps_lon,
  };
}

function queryToRaw(query: MediaQuery) {
  return {
    folder_rel_path: query.folderRelPath,
    include_subfolders: query.includeSubfolders,
    media_type: query.mediaType,
    sort_by: query.sortBy,
    sort_desc: query.sortDesc,
    limit: query.limit,
    offset: query.offset,
    search: query.search,
    duration_min_ms: query.durationMinMs,
    duration_max_ms: query.durationMaxMs,
    size_min_bytes: query.sizeMinBytes,
    size_max_bytes: query.sizeMaxBytes,
    modified_after: query.modifiedAfter,
    modified_before: query.modifiedBefore,
    favorites_only: query.favoritesOnly,
    min_rating: query.minRating,
    metadata_states: query.metadataStates,
    tag: query.tag,
    orientation: query.orientation,
  };
}

export async function getMediaPage(query: MediaQuery): Promise<MediaPage> {
  const raw = await invoke<any>("get_media_page", { query: queryToRaw(query) });
  return { items: raw.items.map(mapMediaItem), total: raw.total };
}

export interface SearchChip {
  kind: "text" | "filter" | "exclude" | "unknown";
  label: string;
}
/** For the search box: how the text was understood, the first matches, how many in all. */
export async function searchSuggest(query: MediaQuery, limit = 8): Promise<{ chips: SearchChip[]; items: MediaListItem[]; total: number }> {
  const raw = await invoke<any>("search_suggest", { query: queryToRaw(query), limit });
  return { chips: raw.chips, items: raw.items.map(mapMediaItem), total: raw.total };
}

/** The first of `ids` (in order) still in the result of `query`, with its 0-based position. */
export async function getMediaPositionFirst(query: MediaQuery, ids: number[]): Promise<{ id: number; position: number } | null> {
  const r = await invoke<[number, number] | null>("get_media_position_first", { query: queryToRaw(query), ids });
  return r ? { id: r[0], position: r[1] } : null;
}

/** 0-based position of `id` in the full ordered result of `query`, or null if it isn't part of it. */
export async function getMediaPosition(query: MediaQuery, id: number): Promise<number | null> {
  return invoke<number | null>("get_media_position", { query: queryToRaw(query), id });
}

/** Absolute file paths (Windows form) for the given ids; null where a file is missing. */
export async function getMediaFilePaths(ids: number[]): Promise<Map<number, string | null>> {
  const rows = await invoke<[number, string | null][]>("get_media_file_paths", { ids });
  return new Map(rows);
}

export async function getFolders(): Promise<FolderNode[]> {
  const raw = await invoke<any[]>("get_folders");
  return raw.map((f) => ({
    relPath: f.rel_path,
    parentRelPath: f.parent_rel_path,
    name: f.name,
    mediaCount: f.media_count,
    depth: f.depth,
  }));
}

export async function setFavorite(id: number, favorite: boolean): Promise<void> {
  await invoke("set_favorite", { id, favorite });
}

export async function setRating(id: number, rating: number): Promise<void> {
  await invoke("set_rating", { id, rating });
}

export async function getLibraryStats(): Promise<LibraryStats> {
  const raw = await invoke<any>("get_library_stats");
  return { total: raw.total, photos: raw.photos, videos: raw.videos, totalSize: raw.total_size };
}

export interface DashboardEntry {
  id: number;
  filename: string;
  fileSize: number;
  durationMs: number | null;
}

export interface DashboardStats {
  total: number;
  photos: number;
  videos: number;
  totalSize: number;
  favorites: number;
  pendingMetadata: number;
  pendingThumbnails: number;
  longestVideo: DashboardEntry | null;
  largestFiles: DashboardEntry[];
  recentlyAdded: DashboardEntry[];
  recentlyModified: DashboardEntry[];
}

function mapEntry(e: any): DashboardEntry {
  return { id: e.id, filename: e.filename, fileSize: e.file_size, durationMs: e.duration_ms };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const raw = await invoke<any>("get_dashboard_stats");
  return {
    total: raw.total,
    photos: raw.photos,
    videos: raw.videos,
    totalSize: raw.total_size,
    favorites: raw.favorites,
    pendingMetadata: raw.pending_metadata,
    pendingThumbnails: raw.pending_thumbnails,
    longestVideo: raw.longest_video ? mapEntry(raw.longest_video) : null,
    largestFiles: raw.largest_files.map(mapEntry),
    recentlyAdded: raw.recently_added.map(mapEntry),
    recentlyModified: raw.recently_modified.map(mapEntry),
  };
}

/** One round trip for many thumbnails: `[id, path | null]` per requested id. */
export async function getThumbnailPaths(ids: number[]): Promise<[number, string | null][]> {
  return invoke<[number, string | null][]>("get_thumbnail_paths", { ids });
}

export async function getThumbnailPath(id: number): Promise<string | null> {
  return invoke<string | null>("get_thumbnail_path", { id });
}

export async function retryMetadata(id: number): Promise<void> {
  await invoke("retry_metadata", { id });
}

export async function retryThumbnail(id: number): Promise<void> {
  await invoke("retry_thumbnail", { id });
}

export async function getMediaFilePath(id: number): Promise<string> {
  return invoke<string>("get_media_file_path", { id });
}

/** A local http URL a <video> streams the file from (byte ranges: quick seeking, any file size). */
export async function getMediaStreamUrl(id: number): Promise<string> {
  return invoke<string>("get_media_stream_url", { id });
}

export interface BatchResult {
  succeeded: number[];
  failed: number[];
}

export async function deleteMedia(ids: number[]): Promise<BatchResult> {
  const raw = await invoke<any>("delete_media", { ids });
  return { succeeded: raw.succeeded, failed: raw.failed };
}

export async function renameMedia(id: number, newName: string): Promise<void> {
  await invoke("rename_media", { id, newName });
}

export async function setFavoriteBatch(ids: number[], favorite: boolean): Promise<void> {
  await invoke("set_favorite_batch", { ids, favorite });
}

export interface CacheStats {
  thumbnailBytes: number;
  playbackBytes: number;
}

export async function getCacheStats(): Promise<CacheStats> {
  const raw = await invoke<any>("get_cache_stats");
  return { thumbnailBytes: raw.thumbnail_bytes, playbackBytes: raw.playback_bytes };
}

export async function clearThumbnailCache(): Promise<void> {
  await invoke("clear_thumbnail_cache");
}

export async function clearPlaybackCache(): Promise<void> {
  await invoke("clear_playback_cache");
}

// ---------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------

export interface TagWithCount {
  id: number;
  name: string;
  count: number;
}

export async function listAllTags(): Promise<TagWithCount[]> {
  return invoke<TagWithCount[]>("list_all_tags");
}

export async function listTagsForMedia(id: number): Promise<string[]> {
  return invoke<string[]>("list_tags_for_media", { id });
}

export async function addTag(id: number, tag: string): Promise<void> {
  await invoke("add_tag", { id, tag });
}

export async function removeTag(id: number, tag: string): Promise<void> {
  await invoke("remove_tag", { id, tag });
}

// ---------------------------------------------------------------------
// Duplicate finder
// ---------------------------------------------------------------------

export interface DuplicateMember {
  id: number;
  relPath: string;
  filename: string;
  fileSize: number;
  modifiedTime: number;
}

export interface DuplicateGroup {
  method: "exact_hash" | "same_size";
  members: DuplicateMember[];
}

export async function findDuplicates(): Promise<void> {
  await invoke("find_duplicates");
}

// ---------------------------------------------------------------------
// Video editor
// ---------------------------------------------------------------------

/** Free-form crop rectangle, normalized 0..1 of the displayed frame. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditParams {
  trimStartMs: number | null;
  trimEndMs: number | null;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  aspect: "original" | "1:1" | "16:9" | "9:16" | "4:3";
  targetWidth: number | null;
  mute: boolean;
  speed: number;
  brightness: number;
  contrast: number;
  saturation: number;
  format: "source" | "mp4" | "webm";
  quality: "high" | "medium" | "compressed";
  accurateCut: boolean;
  replaceOriginal: boolean;
  crop: CropRect | null;
  /** Render original + reversed back to back (ping-pong loop). */
  loopPingpong: boolean;
  /** How many original+reversed cycles the output contains. */
  loopCount: number;
  /** Watermark / object removal regions, in original-frame pixel coordinates. */
  removal: RemovalRegion[];
  /** Two or more kept parts (source ms), joined in order; empty = the trim fields describe one range. */
  segments: Segment[];
}

export interface Segment {
  startMs: number;
  endMs: number;
}

export const DEFAULT_EDIT_PARAMS: EditParams = {
  trimStartMs: null,
  trimEndMs: null,
  segments: [],
  rotate: 0,
  flipH: false,
  flipV: false,
  aspect: "original",
  targetWidth: null,
  mute: false,
  speed: 1,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  format: "source",
  quality: "high",
  accurateCut: false,
  replaceOriginal: false,
  crop: null,
  loopPingpong: false,
  loopCount: 1,
  removal: [],
};

export interface StartEditResult {
  jobId: string;
  outputPath: string;
  streamCopy: boolean;
}

export async function startEditJob(id: number, params: EditParams): Promise<StartEditResult> {
  const raw = await invoke<any>("start_edit_job", {
    id,
    params: {
      trim_start_ms: params.trimStartMs,
      trim_end_ms: params.trimEndMs,
      rotate: params.rotate,
      flip_h: params.flipH,
      flip_v: params.flipV,
      aspect: params.aspect,
      target_width: params.targetWidth,
      mute: params.mute,
      speed: params.speed,
      brightness: params.brightness,
      contrast: params.contrast,
      saturation: params.saturation,
      format: params.format,
      quality: params.quality,
      accurate_cut: params.accurateCut,
      replace_original: params.replaceOriginal,
      crop: params.crop,
      loop_pingpong: params.loopPingpong,
      loop_count: params.loopCount,
      removal: params.removal.map(mapRegion),
      segments: params.segments.map((s) => ({ start_ms: Math.round(s.startMs), end_ms: Math.round(s.endMs) })),
    },
  });
  return { jobId: raw.job_id, outputPath: raw.output_path, streamCopy: raw.stream_copy };
}

export interface RemovalRegion {
  mode: "inpaint" | "blur" | "pixelate" | "cover";
  x: number;
  y: number;
  w: number;
  h: number;
  startMs: number | null;
  endMs: number | null;
  color: string | null;
  /** Freehand brush mask, row-major `w * h` bytes, nonzero = affected.
   * `null`/omitted means the whole rectangle is affected. */
  mask?: number[] | null;
}

function mapRegion(r: RemovalRegion) {
  return {
    mode: r.mode,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    start_ms: r.startMs,
    end_ms: r.endMs,
    color: r.color,
    mask: r.mask ?? null,
  };
}

export async function cancelEditJob(jobId: string): Promise<void> {
  await invoke("cancel_edit_job", { jobId });
}

export async function extractFrame(id: number, atMs: number): Promise<string> {
  return invoke<string>("extract_frame", { id, atMs });
}

export async function extractAudio(id: number): Promise<string> {
  return invoke<string>("extract_audio", { id });
}

// ---------------------------------------------------------------------
// LAN server
// ---------------------------------------------------------------------

export interface LanClient {
  ip: string;
  connectedAt: number;
  lastSeen: number;
}

export interface LanStatus {
  running: boolean;
  url: string | null;
  token: string | null;
  permission: string | null;
  connectedClients: LanClient[];
}

function mapLanStatus(raw: any): LanStatus {
  return {
    running: raw.running,
    url: raw.url,
    token: raw.token,
    permission: raw.permission,
    connectedClients: (raw.connected_clients ?? []).map((c: any) => ({
      ip: c.ip,
      connectedAt: c.connected_at,
      lastSeen: c.last_seen,
    })),
  };
}

export async function listLanInterfaces(): Promise<string[]> {
  return invoke<string[]>("list_lan_interfaces");
}

export async function startLanServer(
  bindIp: string,
  permission: "view" | "download",
  allowlist: string[] | null,
): Promise<LanStatus> {
  const raw = await invoke<any>("start_lan_server", {
    args: { bind_ip: bindIp, port: null, permission, allowlist },
  });
  return mapLanStatus(raw);
}

export async function stopLanServer(): Promise<void> {
  await invoke("stop_lan_server");
}

export async function getLanStatus(): Promise<LanStatus> {
  const raw = await invoke<any>("get_lan_status");
  return mapLanStatus(raw);
}

export async function getLanQrCode(url: string): Promise<string> {
  return invoke<string>("get_lan_qr_code", { url });
}

/** Outstanding background work: [videos awaiting metadata, thumbnails awaiting generation]. */
export async function getPendingCounts(): Promise<{ pendingMetadata: number; pendingThumbnails: number }> {
  const [pendingMetadata, pendingThumbnails] = await invoke<[number, number]>("get_pending_counts");
  return { pendingMetadata, pendingThumbnails };
}

/** Asks the backend whether `password` unlocks the app. */
export async function verifyPassword(password: string): Promise<boolean> {
  return invoke<boolean>("verify_password", { password });
}

/** Whether a lock password has been chosen yet (a fresh install asks for one). */
export async function lockStatus(): Promise<{ hasPassword: boolean }> {
  return invoke<{ hasPassword: boolean }>("lock_status");
}

/** Sets the lock password: the first one freely, then only with the current one. */
export async function setLockPassword(current: string | null, next: string): Promise<void> {
  await invoke("set_password", { current, new: next });
}

export interface EditorSourceInfo {
  durationMs: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

export async function editorSourceInfo(id: number): Promise<EditorSourceInfo> {
  const r = await invoke<any>("editor_source_info", { id });
  return { durationMs: r.duration_ms, fps: r.fps, width: r.width, height: r.height, hasAudio: r.has_audio };
}

/** Path of a strip of `count` frames side by side (cached), for the editor's timeline. */
export async function editorFilmstrip(id: number, count: number): Promise<string> {
  return invoke<string>("editor_filmstrip", { id, count });
}
