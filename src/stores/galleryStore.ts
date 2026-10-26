import { create } from "zustand";
import type { FolderNode, MediaQuery, MediaType, SortBy, TagWithCount } from "../lib/api";

export type ViewMode = "grid" | "dense" | "list" | "timeline";

export interface FilterState {
  search: string;
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

const EMPTY_FILTERS: FilterState = {
  search: "",
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
};

function countActiveFilters(f: FilterState): number {
  let n = 0;
  if (f.durationMinMs !== null || f.durationMaxMs !== null) n++;
  if (f.sizeMinBytes !== null || f.sizeMaxBytes !== null) n++;
  if (f.modifiedAfter !== null || f.modifiedBefore !== null) n++;
  if (f.favoritesOnly) n++;
  if (f.minRating !== null) n++;
  if (f.metadataStates) n++;
  if (f.tag) n++;
  if (f.orientation) n++;
  return n;
}

export type MainView = "dashboard" | "library" | "online" | "downloads" | "browser" | "studio";

// Scans re-fetch the folder list and tags every few seconds; installing an
// identical copy would rebuild the whole sidebar tree for nothing.
function sameFolders(a: FolderNode[], b: FolderNode[]): boolean {
  return a.length === b.length && a.every((f, i) => f.relPath === b[i].relPath && f.mediaCount === b[i].mediaCount);
}

function sameTags(a: TagWithCount[], b: TagWithCount[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.name === b[i].name && t.count === b[i].count);
}

interface GalleryStore {
  mainView: MainView;
  folders: FolderNode[];
  tags: TagWithCount[];
  selectedFolder: string | null;
  includeSubfolders: boolean;
  mediaType: MediaType;
  sortBy: SortBy;
  sortDesc: boolean;
  viewMode: ViewMode;
  thumbnailSize: number; // px, grid card edge
  selectedIds: Set<number>;
  filters: FilterState;
  /** Bumped while a scan is populating an as-yet-empty library, so the
   * grid/sidebar can pick up newly indexed rows without disturbing an
   * already-browsing user's scroll position. */
  refreshKey: number;
  /** The root the current filter/selection state belongs to — switching
   * roots must reset scope/selection rather than keep browsing the old
   * library's now-stale in-memory state. */
  activeRootId: string | null;
  /** A file the grid should land on at its next reload (and open in the viewer when `open`) —
   * picked from the search box's suggestions. */
  reveal: { id: number; open: boolean } | null;

  setMainView: (v: MainView) => void;
  setFolders: (folders: FolderNode[]) => void;
  setTags: (tags: TagWithCount[]) => void;
  bumpRefresh: () => void;
  resetForRoot: (rootId: string) => void;
  selectFolder: (relPath: string | null) => void;
  setIncludeSubfolders: (v: boolean) => void;
  setMediaType: (t: MediaType) => void;
  setSort: (sortBy: SortBy, sortDesc: boolean) => void;
  setViewMode: (v: ViewMode) => void;
  setThumbnailSize: (n: number) => void;
  toggleSelected: (id: number, exclusive?: boolean) => void;
  clearSelection: () => void;
  setFilters: (partial: Partial<FilterState>) => void;
  clearFilters: () => void;
  activeFilterCount: () => number;
  /** Shows this file: its page, selected, optionally opened — after applying `search`. */
  revealFile: (id: number, open: boolean, search?: string) => void;

  buildQuery: (limit: number, offset: number) => MediaQuery;
}

export const useGalleryStore = create<GalleryStore>((set, get) => ({
  mainView: "dashboard",
  reveal: null,
  folders: [],
  tags: [],
  selectedFolder: null,
  includeSubfolders: true,
  mediaType: "all",
  sortBy: "date_modified",
  sortDesc: true,
  viewMode: "grid",
  thumbnailSize: 200,
  selectedIds: new Set(),
  filters: EMPTY_FILTERS,
  refreshKey: 0,
  activeRootId: null,

  setMainView: (v) => set({ mainView: v }),
  setFolders: (folders) => set((s) => (sameFolders(s.folders, folders) ? s : { folders })),
  setTags: (tags) => set((s) => (sameTags(s.tags, tags) ? s : { tags })),
  bumpRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),
  resetForRoot: (rootId) =>
    set({
      activeRootId: rootId,
      mainView: "dashboard",
      selectedFolder: null,
      folders: [],
      tags: [],
      selectedIds: new Set(),
      filters: EMPTY_FILTERS,
      refreshKey: 0,
    }),
  selectFolder: (relPath) => set({ mainView: "library", selectedFolder: relPath, selectedIds: new Set() }),
  setIncludeSubfolders: (v) => set({ includeSubfolders: v }),
  setMediaType: (t) => set({ mediaType: t }),
  setSort: (sortBy, sortDesc) => set({ sortBy, sortDesc }),
  setViewMode: (v) => set({ viewMode: v }),
  setThumbnailSize: (n) => set({ thumbnailSize: n }),
  toggleSelected: (id, exclusive) =>
    set((state) => {
      if (exclusive) return { selectedIds: new Set([id]) };
      const next = new Set(state.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),
  clearSelection: () => set({ selectedIds: new Set() }),
  setFilters: (partial) => set((s) => ({ filters: { ...s.filters, ...partial } })),
  clearFilters: () => set({ filters: EMPTY_FILTERS }),
  activeFilterCount: () => countActiveFilters(get().filters),
  revealFile: (id, open, search) =>
    set((s) => ({ reveal: { id, open }, mainView: "library", filters: { ...s.filters, ...(search !== undefined ? { search } : {}) } })),

  buildQuery: (limit, offset) => {
    const s = get();
    return {
      folderRelPath: s.selectedFolder,
      includeSubfolders: s.includeSubfolders,
      mediaType: s.mediaType,
      sortBy: s.sortBy,
      sortDesc: s.sortDesc,
      limit,
      offset,
      search: s.filters.search.trim() || null,
      durationMinMs: s.filters.durationMinMs,
      durationMaxMs: s.filters.durationMaxMs,
      sizeMinBytes: s.filters.sizeMinBytes,
      sizeMaxBytes: s.filters.sizeMaxBytes,
      modifiedAfter: s.filters.modifiedAfter,
      modifiedBefore: s.filters.modifiedBefore,
      favoritesOnly: s.filters.favoritesOnly,
      minRating: s.filters.minRating,
      metadataStates: s.filters.metadataStates,
      tag: s.filters.tag,
      orientation: s.filters.orientation,
    };
  },
}));
