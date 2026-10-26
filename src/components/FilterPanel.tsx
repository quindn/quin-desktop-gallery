import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useGalleryStore } from "../stores/galleryStore";
import { Portal } from "./Portal";

const DAY_MS = 24 * 60 * 60 * 1000;

const ORIENTATION_PRESETS: { label: string; value: "landscape" | "portrait" | "square" }[] = [
  { label: "Landscape", value: "landscape" },
  { label: "Portrait", value: "portrait" },
  { label: "Square", value: "square" },
];

const DURATION_PRESETS: { label: string; min: number | null; max: number | null }[] = [
  { label: "< 5 sec", min: null, max: 5_000 },
  { label: "5–15 sec", min: 5_000, max: 15_000 },
  { label: "15–30 sec", min: 15_000, max: 30_000 },
  { label: "30–60 sec", min: 30_000, max: 60_000 },
  { label: "1–3 min", min: 60_000, max: 180_000 },
  { label: "3–10 min", min: 180_000, max: 600_000 },
  { label: "10–30 min", min: 600_000, max: 1_800_000 },
  { label: "> 30 min", min: 1_800_000, max: null },
];

const MB = 1024 * 1024;
const GB = 1024 * MB;
const SIZE_PRESETS: { label: string; min: number | null; max: number | null }[] = [
  { label: "< 1 MB", min: null, max: 1 * MB },
  { label: "1–10 MB", min: 1 * MB, max: 10 * MB },
  { label: "10–100 MB", min: 10 * MB, max: 100 * MB },
  { label: "100–500 MB", min: 100 * MB, max: 500 * MB },
  { label: "500 MB–1 GB", min: 500 * MB, max: 1 * GB },
  { label: "> 1 GB", min: 1 * GB, max: null },
];

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfMonth(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfYear(): number {
  const d = new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DATE_PRESETS: { label: string; after: number | null; before: number | null }[] = [
  { label: "Today", after: startOfToday(), before: null },
  { label: "Yesterday", after: startOfToday() - DAY_MS, before: startOfToday() },
  { label: "Last 7 Days", after: startOfToday() - 7 * DAY_MS, before: null },
  { label: "Last 30 Days", after: startOfToday() - 30 * DAY_MS, before: null },
  { label: "This Month", after: startOfMonth(), before: null },
  { label: "This Year", after: startOfYear(), before: null },
];

function PresetRow<T extends { label: string }>({
  presets,
  isActive,
  onPick,
}: {
  presets: T[];
  isActive: (p: T) => boolean;
  onPick: (p: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {presets.map((p) => (
        <button
          key={p.label}
          onClick={() => onPick(p)}
          className={`rounded-control px-2.5 py-1 text-[11.5px] transition-colors ${
            isActive(p) ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{title}</div>
      {children}
    </div>
  );
}

export function FilterPanel({
  anchorRef,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const filters = useGalleryStore((s) => s.filters);
  const setFilters = useGalleryStore((s) => s.setFilters);
  const clearFilters = useGalleryStore((s) => s.clearFilters);
  const activeCount = useGalleryStore((s) => s.activeFilterCount());
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.bottom + 8, right: Math.max(12, window.innerWidth - rect.right) });
  }, [anchorRef]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  return (
    <Portal>
    <div
      ref={ref}
      style={pos ? { top: pos.top, right: pos.right } : { top: 52, right: 12 }}
      className="menu-surface animate-pop-in fixed z-[300] flex w-80 flex-col gap-4 rounded-card p-4"
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-text-primary">Filters</span>
        {activeCount > 0 && (
          <button onClick={clearFilters} className="text-[11px] text-accent hover:underline">
            Clear all
          </button>
        )}
      </div>

      <Section title="Video Duration">
        <PresetRow
          presets={DURATION_PRESETS}
          isActive={(p) => filters.durationMinMs === p.min && filters.durationMaxMs === p.max}
          onPick={(p) =>
            setFilters(
              filters.durationMinMs === p.min && filters.durationMaxMs === p.max
                ? { durationMinMs: null, durationMaxMs: null }
                : { durationMinMs: p.min, durationMaxMs: p.max },
            )
          }
        />
      </Section>

      <Section title="File Size">
        <PresetRow
          presets={SIZE_PRESETS}
          isActive={(p) => filters.sizeMinBytes === p.min && filters.sizeMaxBytes === p.max}
          onPick={(p) =>
            setFilters(
              filters.sizeMinBytes === p.min && filters.sizeMaxBytes === p.max
                ? { sizeMinBytes: null, sizeMaxBytes: null }
                : { sizeMinBytes: p.min, sizeMaxBytes: p.max },
            )
          }
        />
      </Section>

      <Section title="Date Modified">
        <PresetRow
          presets={DATE_PRESETS}
          isActive={(p) => filters.modifiedAfter === p.after && filters.modifiedBefore === p.before}
          onPick={(p) =>
            setFilters(
              filters.modifiedAfter === p.after && filters.modifiedBefore === p.before
                ? { modifiedAfter: null, modifiedBefore: null }
                : { modifiedAfter: p.after, modifiedBefore: p.before },
            )
          }
        />
      </Section>

      <Section title="Orientation">
        <PresetRow
          presets={ORIENTATION_PRESETS}
          isActive={(p) => filters.orientation === p.value}
          onPick={(p) => setFilters({ orientation: filters.orientation === p.value ? null : p.value })}
        />
      </Section>

      <Section title="Rating">
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setFilters({ minRating: filters.minRating === n ? null : n })}
              className="text-text-tertiary hover:text-amber-300"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill={filters.minRating !== null && n <= filters.minRating ? "#f5c451" : "none"}
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </button>
          ))}
          {filters.minRating !== null && <span className="ml-1 text-[11px] text-text-tertiary">& up</span>}
        </div>
      </Section>

      <Section title="Status">
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setFilters({ favoritesOnly: !filters.favoritesOnly })}
            className={`rounded-control px-2.5 py-1 text-[11.5px] transition-colors ${
              filters.favoritesOnly ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
            }`}
          >
            Favorites Only
          </button>
          <button
            onClick={() =>
              setFilters({
                metadataStates: filters.metadataStates?.includes("needs_deep_scan") ? null : ["needs_deep_scan"],
              })
            }
            className={`rounded-control px-2.5 py-1 text-[11.5px] transition-colors ${
              filters.metadataStates?.includes("needs_deep_scan")
                ? "bg-accent text-white"
                : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
            }`}
          >
            Needs Deep Scan
          </button>
          <button
            onClick={() =>
              setFilters({ metadataStates: filters.metadataStates?.includes("failed") ? null : ["failed"] })
            }
            className={`rounded-control px-2.5 py-1 text-[11.5px] transition-colors ${
              filters.metadataStates?.includes("failed")
                ? "bg-accent text-white"
                : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
            }`}
          >
            Metadata Errors
          </button>
        </div>
      </Section>
    </div>
    </Portal>
  );
}
