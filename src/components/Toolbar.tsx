import { useRef, useState } from "react";
import type { MediaType, SortBy } from "../lib/api";
import { useGalleryStore, type ViewMode } from "../stores/galleryStore";
import { FilterPanel } from "./FilterPanel";
import { ScanStatusPill } from "./ScanStatusPill";
import { SearchBox } from "./SearchBox";

const TYPE_FILTERS: { value: MediaType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "photo", label: "Photos" },
  { value: "video", label: "Videos" },
  { value: "animated", label: "Animated" },
];

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "date_modified", label: "Date Modified" },
  { value: "date_created", label: "Date Created" },
  { value: "name", label: "Name" },
  { value: "similar_name", label: "Similar Names" },
  { value: "duration", label: "Duration" },
  { value: "size", label: "File Size" },
];

const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "dense", label: "Dense" },
  { value: "list", label: "List" },
  { value: "timeline", label: "Timeline" },
];

export function Toolbar() {
  const mediaType = useGalleryStore((s) => s.mediaType);
  const setMediaType = useGalleryStore((s) => s.setMediaType);
  const sortBy = useGalleryStore((s) => s.sortBy);
  const sortDesc = useGalleryStore((s) => s.sortDesc);
  const setSort = useGalleryStore((s) => s.setSort);
  const viewMode = useGalleryStore((s) => s.viewMode);
  const setViewMode = useGalleryStore((s) => s.setViewMode);
  const thumbnailSize = useGalleryStore((s) => s.thumbnailSize);
  const setThumbnailSize = useGalleryStore((s) => s.setThumbnailSize);
  const activeFilterCount = useGalleryStore((s) => s.activeFilterCount());
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="glass relative z-20 flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-3 shadow-[0_1px_0_rgba(0,0,0,0.3)]">
      <div className="flex items-center gap-0.5 rounded-control bg-card p-0.5">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setMediaType(f.value)}
            className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-all duration-150 active:scale-[0.96] ${
              mediaType === f.value
                ? "bg-accent text-white shadow-[0_1px_4px_rgba(10,132,255,0.5)]"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <SearchBox />

      <button
        ref={filterBtnRef}
        onClick={() => setFilterOpen((v) => !v)}
        className={`no-drag relative flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-[12px] transition-colors active:scale-[0.97] ${
          filterOpen || activeFilterCount > 0
            ? "bg-accent text-white"
            : "bg-card text-text-secondary hover:text-text-primary"
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 5h18M6 12h12M10 19h4" strokeLinecap="round" />
        </svg>
        Filter
        {activeFilterCount > 0 && (
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white/90 text-[9px] font-semibold text-accent">
            {activeFilterCount}
          </span>
        )}
      </button>
      {filterOpen && <FilterPanel anchorRef={filterBtnRef} onClose={() => setFilterOpen(false)} />}

      <div className="flex-1" />

      <ScanStatusPill />

      {viewMode !== "timeline" && (
        <>
          <select
            value={sortBy}
            onChange={(e) => {
              const next = e.target.value as SortBy;
              // Grouping reads naturally A→Z; the other sorts keep the current direction.
              setSort(next, next === "similar_name" ? false : sortDesc);
            }}
            className="no-drag rounded-control bg-card px-2 py-1.5 text-[12px] text-text-secondary outline-none"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setSort(sortBy, !sortDesc)}
            aria-label="Toggle sort direction"
            className="rounded-control bg-card px-2 py-1.5 text-[12px] text-text-secondary transition-colors hover:text-text-primary"
          >
            {sortDesc ? "↓" : "↑"}
          </button>
        </>
      )}

      <div className="flex items-center gap-0.5 rounded-control bg-card p-0.5">
        {VIEW_MODES.map((v) => (
          <button
            key={v.value}
            onClick={() => {
              setViewMode(v.value);
              // Timeline groups by capture date, which only reads
              // sensibly as a single descending stream.
              if (v.value === "timeline") setSort("date_taken", true);
            }}
            className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-all duration-150 active:scale-[0.96] ${
              viewMode === v.value
                ? "bg-accent text-white shadow-[0_1px_4px_rgba(10,132,255,0.5)]"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <input
        type="range"
        min={120}
        max={320}
        step={10}
        value={thumbnailSize}
        onChange={(e) => setThumbnailSize(Number(e.target.value))}
        className="no-drag w-24 accent-[#0a84ff]"
        aria-label="Thumbnail size"
      />
    </div>
  );
}
