import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen } from "@tauri-apps/api/event";
import { deleteMedia, getMediaPage, getMediaPositionFirst, type MediaListItem } from "../lib/api";
import { copyFilesToClipboard } from "../lib/fileDrag";
import { useGalleryStore } from "../stores/galleryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { ContextMenu } from "./ContextMenu";
import { ListHeader } from "./ListHeader";
import { ListRow, LIST_ROW_HEIGHT } from "./ListRow";
import { MediaCard } from "./MediaCard";
import { Viewer } from "./Viewer";

const GAP = 10;
const HEADER_ROW_HEIGHT = 36;
const PAGE_SIZE_OPTIONS = [60, 120, 240, 500];

type Row =
  | { kind: "items"; startIndex: number; items: MediaListItem[] }
  | { kind: "header"; label: string };

function timelineLabel(item: MediaListItem): string {
  const ts = item.dateTaken ?? item.createdTime ?? item.modifiedTime;
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function PaginationBar({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  // What's typed in the jump box; kept in sync with the real page whenever
  // that changes (prev/next, filter reset, ...), free-form while editing.
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);

  if (total === 0) return null;
  const lastPage = Math.max(1, totalPages);

  function jump(e?: FormEvent) {
    e?.preventDefault();
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || draft.trim() === "") {
      setDraft(String(page));
      return;
    }
    const target = Math.min(lastPage, Math.max(1, n));
    setDraft(String(target));
    onPageChange(target);
  }

  const navBtn =
    "rounded-control bg-card px-3 py-1 transition-colors hover:bg-card-hover hover:text-text-primary disabled:opacity-30";
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-t border-hairline px-3 py-2 text-[12px] text-text-secondary">
      <button onClick={() => onPageChange(1)} disabled={page <= 1} aria-label="First page" className={navBtn}>
        «
      </button>
      <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} className={navBtn}>
        ‹ Prev
      </button>
      <form onSubmit={jump} className="flex items-center gap-1.5 tabular-nums text-text-tertiary">
        <span>Page</span>
        <input
          type="number"
          min={1}
          max={lastPage}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Jump to page"
          className="w-16 rounded-control bg-card px-2 py-1 text-center text-text-primary outline-none [appearance:textfield] focus:ring-1 focus:ring-accent [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span>of {lastPage.toLocaleString()} · {total.toLocaleString()} items</span>
        <button type="submit" className="rounded-control bg-accent px-2.5 py-1 text-[11px] text-white transition-colors hover:opacity-90">
          Go
        </button>
      </form>
      <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} className={navBtn}>
        Next ›
      </button>
      <button onClick={() => onPageChange(lastPage)} disabled={page >= totalPages} aria-label="Last page" className={navBtn}>
        »
      </button>
      <div className="ml-2 flex items-center gap-1">
        <span className="mr-1 text-text-tertiary">Per page</span>
        {PAGE_SIZE_OPTIONS.map((n) => (
          <button
            key={n}
            onClick={() => onPageSizeChange(n)}
            className={`rounded-control px-2.5 py-1 text-[11px] transition-colors ${
              pageSize === n ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

export function GalleryGrid() {
  const selectedFolder = useGalleryStore((s) => s.selectedFolder);
  const includeSubfolders = useGalleryStore((s) => s.includeSubfolders);
  const mediaType = useGalleryStore((s) => s.mediaType);
  const sortBy = useGalleryStore((s) => s.sortBy);
  const sortDesc = useGalleryStore((s) => s.sortDesc);
  const setSort = useGalleryStore((s) => s.setSort);
  const viewMode = useGalleryStore((s) => s.viewMode);
  const thumbnailSizeRaw = useGalleryStore((s) => s.thumbnailSize);
  const thumbnailSize = viewMode === "dense" ? Math.max(90, Math.round(thumbnailSizeRaw * 0.55)) : thumbnailSizeRaw;
  const selectedIds = useGalleryStore((s) => s.selectedIds);
  const toggleSelected = useGalleryStore((s) => s.toggleSelected);
  const buildQuery = useGalleryStore((s) => s.buildQuery);
  const refreshKey = useGalleryStore((s) => s.refreshKey);
  const activeRootId = useGalleryStore((s) => s.activeRootId);
  const filters = useGalleryStore((s) => s.filters);
  const pageSize = useSettingsStore((s) => s.pageSize);
  const setPageSize = useSettingsStore((s) => s.setPageSize);

  const clearSelection = useGalleryStore((s) => s.clearSelection);

  const [items, setItems] = useState<MediaListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [listExpanded, setListExpanded] = useState(false);
  const [openEditorOnView, setOpenEditorOnView] = useState(false);
  const viewerChangedFilterRef = useRef(false);

  /** Next / previous in the viewer; past either end of this page it continues on the neighbouring page. */
  const stepViewer = useCallback(
    async (delta: number) => {
      if (viewerIndex === null) return;
      const i = viewerIndex + delta;
      if (i >= 0 && i < items.length) {
        setViewerIndex(i);
        return;
      }
      const target = page + (delta > 0 ? 1 : -1);
      if (target < 1 || target > Math.max(1, Math.ceil(total / pageSize))) return;
      const myRequestId = ++requestIdRef.current;
      const result = await getMediaPage(buildQuery(pageSize, (target - 1) * pageSize));
      if (requestIdRef.current !== myRequestId || result.items.length === 0) return;
      setItems(result.items);
      setTotal(result.total);
      setPage(target);
      setViewerIndex(delta > 0 ? 0 : result.items.length - 1);
    },
    [viewerIndex, items.length, page, total, pageSize, buildQuery],
  );

  /** Only the files in this item's folder (all media types, no other filter), landing on the item. */
  const showFolder = useCallback((item: MediaListItem) => {
    setViewerIndex(null);
    setOpenEditorOnView(false);
    anchorRef.current = [item.id];
    const st = useGalleryStore.getState();
    st.clearFilters();
    st.setMediaType("all");
    st.setIncludeSubfolders(false);
    st.selectFolder(item.folderRelPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);
  // The item the user is "at" — the selected one, or else the first one in view — followed by its
  // neighbours on the page (nearest first). Whenever the list reloads for any reason (sort, filter,
  // folder, favourites, media type, page size…), the grid opens the page that holds the first of
  // these that is still in the new result and scrolls to it, instead of starting over at page 1.
  // The neighbours matter when the item itself drops out (un-favourited in Favorites, say).
  const anchorRef = useRef<number[] | null>(null);
  const prevSearchRef = useRef(filters.search);
  const pendingScrollIdRef = useRef<number | null>(null);
  const pendingOpenIdRef = useRef<number | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const loadPage = useCallback(
    async (pageToLoad: number, myRequestId: number) => {
      loadingRef.current = true;
      try {
        const offset = (pageToLoad - 1) * pageSize;
        const result = await getMediaPage(buildQuery(pageSize, offset));
        if (requestIdRef.current !== myRequestId) return; // stale response from a superseded query
        setItems(result.items);
        setTotal(result.total);
      } finally {
        loadingRef.current = false;
      }
    },
    [buildQuery, pageSize],
  );

  function goToPage(next: number) {
    const clamped = Math.min(totalPages, Math.max(1, next));
    if (clamped === page && items.length > 0) return;
    setPage(clamped);
    clearSelection();
    scrollRef.current?.scrollTo({ top: 0 });
    const myRequestId = ++requestIdRef.current;
    loadPage(clamped, myRequestId);
  }

  // Reset to page 1 and reload whenever the scope/filter/sort/page-size
  // changes, or the root itself switches (a previous root's items are
  // meaningless once its database is no longer the one open).
  //
  // When the reload is caused by a *sort change* and something is selected,
  // don't dump the user at page 1: find where the selected item landed in the
  // new order, open that page, and scroll to it (selection is kept).
  useEffect(() => {
    const myRequestId = ++requestIdRef.current;
    // A new search starts from its first result; everything else follows the item the user was at.
    const searchChanged = prevSearchRef.current !== filters.search;
    prevSearchRef.current = filters.search;
    // a file picked in the search box's suggestions: land on it (and open it)
    const reveal = useGalleryStore.getState().reveal;
    if (reveal) useGalleryStore.setState({ reveal: null });
    pendingOpenIdRef.current = reveal?.open ? reveal.id : null;
    const candidates = reveal ? [reveal.id] : searchChanged ? null : anchorRef.current;

    pendingScrollIdRef.current = null;
    setItems([]);
    setTotal(0);

    if (!candidates || candidates.length === 0) {
      setPage(1);
      loadPage(1, myRequestId);
      return;
    }
    (async () => {
      const hit = await getMediaPositionFirst(buildQuery(pageSize, 0), candidates).catch(() => null);
      if (requestIdRef.current !== myRequestId) return; // superseded meanwhile
      if (hit) {
        pendingScrollIdRef.current = hit.id;
        const target = Math.floor(hit.position / pageSize) + 1;
        setPage(target);
        loadPage(target, myRequestId);
        return;
      }
      setPage(1);
      loadPage(1, myRequestId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder, includeSubfolders, mediaType, sortBy, sortDesc, activeRootId, filters, pageSize, reloadTick]);

  /** The item at `index` on this page, then its neighbours, nearest first. */
  const candidatesAround = useCallback(
    (index: number) => {
      const out = [items[index].id];
      for (let d = 1; d <= 8; d++) {
        if (items[index + d]) out.push(items[index + d].id);
        if (items[index - d]) out.push(items[index - d].id);
      }
      return out;
    },
    [items],
  );
  /** Re-centres the anchor on the selected item (or the first one in view). */
  const updateAnchor = useCallback(() => {
    if (items.length === 0) return;
    const sel = useGalleryStore.getState().selectedIds;
    let index = -1;
    if (sel.size > 0) {
      const id = [...sel][sel.size - 1];
      index = items.findIndex((it) => it.id === id);
    }
    if (index < 0) index = Math.min(items.length - 1, Math.max(0, topVisibleIndexRef.current));
    anchorRef.current = candidatesAround(index);
  }, [items, candidatesAround]);
  const topVisibleIndexRef = useRef(0);
  useEffect(() => {
    updateAnchor();
  }, [selectedIds, updateAnchor]);

  // Video metadata (duration, codec, dimensions) arrives asynchronously
  // from the background probe queue — patch matching rows in place rather
  // than waiting for a full reload.
  useEffect(() => {
    // A metadata sweep can fire hundreds of these a second. Collect them and
    // apply once every 300 ms — one re-render of the page instead of one per
    // event, and none at all for ids that aren't on this page.
    const pending = new Map<number, any>();
    let timer: number | undefined;

    function flush() {
      timer = undefined;
      if (pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      setItems((prev) => {
        let changed = false;
        const next = prev.map((item) => {
          const u = batch.get(item.id);
          if (!u) return item;
          changed = true;
          const { duration_ms, width, height, metadata_state } = u;
          return {
            ...item,
            ...(duration_ms !== undefined ? { durationMs: duration_ms } : {}),
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            ...(metadata_state !== undefined ? { metadataState: metadata_state } : {}),
          };
        });
        return changed ? next : prev;
      });
    }

    const unlisten = listen<any>("metadata://ready", (event) => {
      pending.set(event.payload.id, { ...pending.get(event.payload.id), ...event.payload });
      if (timer === undefined) timer = window.setTimeout(flush, 300);
    });
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten.then((f) => f());
    };
  }, []);

  // While a background scan is still populating an empty library, pick up
  // newly indexed rows as they land — but only while nothing is loaded
  // yet, so this never yanks the view out from under active browsing.
  useEffect(() => {
    if (items.length === 0 && !loadingRef.current) {
      loadPage(page, requestIdRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const isList = viewMode === "list";
  const isTimeline = viewMode === "timeline";
  const columns = isList ? 1 : Math.max(1, Math.floor((containerWidth + GAP) / (thumbnailSize + GAP)));
  const itemRowHeight = isList ? LIST_ROW_HEIGHT : thumbnailSize + GAP;

  // A single row model covers grid/dense/list (uniform item rows) and
  // timeline (day-grouped, with an inserted sticky-feeling header row per
  // group) — one virtualizer serves every view mode instead of forking
  // the whole render tree per mode. Pagination means `items` is always
  // exactly the current page's rows, so there's no "loader" row to append
  // anymore — the whole page loads in one request.
  const rows: Row[] = useMemo(() => {
    const result: Row[] = [];
    if (isTimeline) {
      let i = 0;
      while (i < items.length) {
        const label = timelineLabel(items[i]);
        const groupStart = i;
        const groupItems: MediaListItem[] = [];
        while (i < items.length && timelineLabel(items[i]) === label) {
          groupItems.push(items[i]);
          i++;
        }
        result.push({ kind: "header", label });
        for (let c = 0; c < groupItems.length; c += columns) {
          result.push({ kind: "items", startIndex: groupStart + c, items: groupItems.slice(c, c + columns) });
        }
      }
    } else {
      for (let i = 0; i < items.length; i += columns) {
        result.push({ kind: "items", startIndex: i, items: items.slice(i, i + columns) });
      }
    }
    return result;
  }, [items, columns, isTimeline]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === "header" ? HEADER_ROW_HEIGHT : itemRowHeight),
    overscan: 4,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  {
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const firstRow = virtualItems.find((v) => v.end > scrollTop + 4 && rows[v.index]?.kind === "items");
    const r = firstRow ? rows[firstRow.index] : undefined;
    if (r && r.kind === "items") topVisibleIndexRef.current = r.startIndex;
  }

  // After a re-sort, bring the previously selected item into view once its
  // page has loaded.
  const scrollToItem = useCallback(
    (id: number, align: "center" | "auto" = "center") => {
      const index = items.findIndex((it) => it.id === id);
      if (index < 0) return false;
      const rowIndex = rows.findIndex((r) => r.kind === "items" && index >= r.startIndex && index < r.startIndex + r.items.length);
      if (rowIndex >= 0) requestAnimationFrame(() => rowVirtualizer.scrollToIndex(rowIndex, { align }));
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, rows],
  );
  useEffect(() => {
    const id = pendingScrollIdRef.current;
    if (id === null || items.length === 0) return;
    pendingScrollIdRef.current = null;
    if (scrollToItem(id)) {
      // the item we landed on is the one the user is at now
      if (!useGalleryStore.getState().selectedIds.has(id)) toggleSelected(id, true);
    }
    if (pendingOpenIdRef.current === id) {
      pendingOpenIdRef.current = null;
      const idx = items.findIndex((it) => it.id === id);
      if (idx >= 0) setViewerIndex(idx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, rows]);

  // A different layout (grid / dense / list / timeline, thumbnail size, window width) keeps the
  // same item in view.
  const layoutKey = `${columns}|${isTimeline}|${isList}`;
  const prevLayoutRef = useRef(layoutKey);
  useEffect(() => {
    if (prevLayoutRef.current === layoutKey) return;
    prevLayoutRef.current = layoutKey;
    const anchor = anchorRef.current?.[0];
    if (anchor !== undefined) scrollToItem(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Stable handlers (see MediaCard): they read current state through the
  // store / setters rather than closing over per-render values.
  const handleSelect = useCallback(
    (id: number, e: MouseEvent) => toggleSelected(id, !(e.ctrlKey || e.metaKey)),
    [toggleSelected],
  );
  const handleOpen = useCallback((index: number) => setViewerIndex(index), []);
  const handleContextMenu = useCallback(
    (id: number, e: MouseEvent) => {
      e.preventDefault();
      if (!useGalleryStore.getState().selectedIds.has(id)) toggleSelected(id, true);
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [toggleSelected],
  );

  // Keyboard shortcuts (spec §29): Space = Quick Look, Enter = Open, arrow
  // keys move the single-selection cursor, PageUp/PageDown flip pages.
  // Skipped while the viewer itself is open (it owns its own key handling)
  // or an input has focus (so typing in the search box doesn't trigger these).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (viewerIndex !== null) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      if (e.key === "PageUp") {
        e.preventDefault();
        goToPage(page - 1);
        return;
      }
      if (e.key === "PageDown") {
        e.preventDefault();
        goToPage(page + 1);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C") && selectedIds.size > 0) {
        e.preventDefault();
        const ids = [...selectedIds];
        copyFilesToClipboard(ids)
          .then((n) => showToast(n === 1 ? "Copied 1 file — paste it anywhere" : `Copied ${n} files — paste them anywhere`))
          .catch((err) => showToast(String(err)));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A") && items.length > 0) {
        e.preventDefault();
        useGalleryStore.setState({ selectedIds: new Set(items.map((it) => it.id)) });
        return;
      }

      if ((e.key === " " || e.key === "Enter") && selectedIds.size === 1) {
        const id = [...selectedIds][0];
        const idx = items.findIndex((it) => it.id === id);
        if (idx >= 0) {
          e.preventDefault();
          setViewerIndex(idx);
        }
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) {
        e.preventDefault();
        const ids = [...selectedIds];
        deleteMedia(ids).then((result) => {
          setItems((prev) => prev.filter((it) => !result.succeeded.includes(it.id)));
          setTotal((t) => t - result.succeeded.length);
          clearSelection();
        });
        return;
      }
      if (e.key === "Escape" && selectedIds.size > 0) {
        clearSelection();
        return;
      }

      const arrowDelta: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -columns,
        ArrowDown: columns,
      };
      if (e.key in arrowDelta && items.length > 0) {
        e.preventDefault();
        const currentId = selectedIds.size === 1 ? [...selectedIds][0] : items[0].id;
        const currentIdx = Math.max(0, items.findIndex((it) => it.id === currentId));
        const nextIdx = Math.min(items.length - 1, Math.max(0, currentIdx + arrowDelta[e.key]));
        toggleSelected(items[nextIdx].id, true);
        if (!isTimeline) rowVirtualizer.scrollToIndex(Math.floor(nextIdx / columns));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerIndex, selectedIds, items, columns, toggleSelected, rowVirtualizer, isTimeline, page, totalPages]);

  return (
    // flex-1 + min-h-0 (not h-full): this is a flex sibling of Toolbar
    // inside App's flex-col wrapper, not the sole child — h-full resolves
    // to 100% of that *whole* wrapper (Toolbar's own height included),
    // silently overflowing by Toolbar's height and getting clipped by the
    // wrapper's overflow-hidden. Harmless when GalleryGrid was one
    // scrollable box, but it clipped the pagination bar right off the
    // bottom. min-h-0 is the standard fix for a flex child that needs to
    // actually shrink to fit instead of growing to its content's height.
    <div className="flex w-full flex-1 flex-col min-h-0">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3"
        onScroll={() => {
          // after the virtualizer has re-rendered for the new scroll position
          if (useGalleryStore.getState().selectedIds.size === 0) requestAnimationFrame(updateAnchor);
        }}
      >
        {items.length === 0 && total === 0 && !loadingRef.current && (
          <div className="flex h-full w-full items-center justify-center text-sm text-text-tertiary">
            {filters.search.trim() ? `Nothing matches “${filters.search.trim()}” here.` : "No media in this view yet."}
          </div>
        )}
        {isList && items.length > 0 && (
          <ListHeader
            expanded={listExpanded}
            onToggleExpanded={() => setListExpanded((v) => !v)}
            sortBy={sortBy}
            sortDesc={sortDesc}
            setSort={setSort}
          />
        )}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {virtualItems.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                  display: "flex",
                  alignItems: row.kind === "header" ? "flex-end" : undefined,
                  gap: isList || row.kind === "header" ? 0 : GAP,
                }}
              >
                {row.kind === "header" ? (
                  <div className="pb-1.5 text-[13px] font-semibold text-text-primary">{row.label}</div>
                ) : isList ? (
                  <ListRow
                    item={row.items[0]}
                    index={row.startIndex}
                    selected={selectedIds.has(row.items[0].id)}
                    expanded={listExpanded}
                    onSelect={handleSelect}
                    onOpen={handleOpen}
                    onContextMenu={handleContextMenu}
                  />
                ) : (
                  row.items.map((item, i) => (
                    <MediaCard
                      key={item.id}
                      item={item}
                      index={row.startIndex + i}
                      size={thumbnailSize}
                      selected={selectedIds.has(item.id)}
                      onSelect={handleSelect}
                      onOpen={handleOpen}
                      onContextMenu={handleContextMenu}
                    />
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>

      {toast && (
        <div data-testid="grid-toast" className="pointer-events-none fixed bottom-16 left-1/2 z-[90] -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-[12px] text-white shadow-lg">
          {toast}
        </div>
      )}

      <PaginationBar
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={pageSize}
        onPageChange={goToPage}
        onPageSizeChange={setPageSize}
      />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ids={[...selectedIds]}
          items={items}
          onClose={() => setContextMenu(null)}
          onDeleted={(ids) => {
            setItems((prev) => prev.filter((it) => !ids.includes(it.id)));
            setTotal((t) => t - ids.length);
            clearSelection();
          }}
          onRenamed={(id, filename, relPath) => {
            setItems((prev) => prev.map((it) => (it.id === id ? { ...it, filename, relPath } : it)));
          }}
          onFavoriteChanged={(ids, favorite) => {
            setItems((prev) => prev.map((it) => (ids.includes(it.id) ? { ...it, favorite } : it)));
            // in Favorites, an un-favourited item leaves the view: reload around where it was
            if (!favorite && useGalleryStore.getState().filters.favoritesOnly) setReloadTick((t) => t + 1);
          }}
          onShowFolder={(id) => {
            const it = items.find((x) => x.id === id);
            if (it) showFolder(it);
          }}
          onCopyFiles={(ids) =>
            copyFilesToClipboard(ids)
              .then((n) => showToast(n === 1 ? "Copied 1 file — paste it anywhere" : `Copied ${n} files — paste them anywhere`))
              .catch((err) => showToast(String(err)))
          }
          onEditRequested={(id) => {
            const idx = items.findIndex((it) => it.id === id);
            if (idx >= 0) {
              setOpenEditorOnView(true);
              setViewerIndex(idx);
            }
          }}
        />
      )}

      {viewerIndex !== null && (
        <Viewer
          items={items}
          total={items.length}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          globalIndex={(page - 1) * pageSize + viewerIndex}
          globalTotal={total}
          onStep={stepViewer}
          onShowFolder={showFolder}
          onItemChanged={(id, patch) => {
            setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
            viewerChangedFilterRef.current = true;
          }}
          onClose={() => {
            const viewed = items[viewerIndex];
            setViewerIndex(null);
            setOpenEditorOnView(false);
            if (!viewed) return;
            // the grid follows the viewer: the last item viewed is selected and in view
            toggleSelected(viewed.id, true);
            scrollToItem(viewed.id);
            anchorRef.current = candidatesAround(viewerIndex);
            const f = useGalleryStore.getState().filters;
            if (viewerChangedFilterRef.current && (f.favoritesOnly || f.minRating !== null)) setReloadTick((t) => t + 1);
            viewerChangedFilterRef.current = false;
          }}
          onNeedMore={() => {}}
          initialEditorOpen={openEditorOnView}
        />
      )}
    </div>
  );
}
