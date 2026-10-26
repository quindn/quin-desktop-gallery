import { useEffect, useState } from "react";
import { getDashboardStats, getPendingCounts, type DashboardEntry, type DashboardStats } from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";
import { useGalleryStore } from "../stores/galleryStore";
import { useRootStore } from "../stores/rootStore";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      className="glass flex flex-col gap-1.5 rounded-card p-4 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-transform duration-150 hover:-translate-y-0.5"
    >
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-tertiary">{label}</span>
      <span className="text-2xl font-semibold tracking-tight text-text-primary">{value}</span>
      {sub && <span className="truncate text-[11px] text-text-tertiary">{sub}</span>}
    </div>
  );
}

function EntryList({
  title,
  entries,
  showDuration,
  onOpen,
}: {
  title: string;
  entries: DashboardEntry[];
  showDuration?: boolean;
  onOpen: (filename: string) => void;
}) {
  return (
    <div className="glass flex flex-col gap-2 rounded-card p-4">
      <span className="text-[12px] font-semibold text-text-primary">{title}</span>
      {entries.length === 0 ? (
        <span className="text-[12px] text-text-tertiary">Nothing yet</span>
      ) : (
        <div className="flex flex-col divide-y divide-white/5">
          {entries.map((e) => (
            <button
              key={e.id}
              onClick={() => onOpen(e.filename)}
              className="flex items-center justify-between py-1.5 text-left text-[12px] text-text-secondary transition-colors hover:text-text-primary"
            >
              <span className="truncate">{e.filename}</span>
              <span className="ml-3 shrink-0 text-text-tertiary">
                {showDuration && e.durationMs !== null ? formatDuration(e.durationMs) : formatBytes(e.fileSize)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const root = useRootStore((s) => s.root);
  const refreshKey = useGalleryStore((s) => s.refreshKey);
  const selectFolder = useGalleryStore((s) => s.selectFolder);
  const setFilters = useGalleryStore((s) => s.setFilters);
  const clearFilters = useGalleryStore((s) => s.clearFilters);

  // The numbers come from a few whole-library queries (a second or more on a big library while the
  // scan is busy): show the last ones at once and swap in the fresh ones when they arrive.
  const cacheKey = `qpg.dash.${root?.id}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      setStats(raw ? (JSON.parse(raw) as DashboardStats) : null);
    } catch {
      setStats(null);
    }
  }, [cacheKey]);
  useEffect(() => {
    getDashboardStats()
      .then((fresh) => {
        setStats(fresh);
        try {
          localStorage.setItem(cacheKey, JSON.stringify(fresh));
        } catch {
          // storage unavailable: nothing to remember
        }
      })
      .catch(() => {});
  }, [cacheKey, refreshKey]);

  // Thumbnails/durations finish in the background *after* the scan itself
  // reports done, and nothing else tells this view — so without polling it
  // kept showing a stale "In progress" until the user navigated away and
  // back. Poll only while work is actually outstanding.
  const scanning = !!stats && (stats.pendingMetadata > 0 || stats.pendingThumbnails > 0);
  useEffect(() => {
    if (!scanning) return;
    // Only the two pending counters are re-read while waiting; the full
    // aggregate set is fetched once more when the work has drained.
    const t = setInterval(() => {
      getPendingCounts()
        .then((c) => {
          if (c.pendingMetadata === 0 && c.pendingThumbnails === 0) {
            getDashboardStats().then(setStats).catch(() => {});
          } else {
            setStats((prev) => (prev ? { ...prev, ...c } : prev));
          }
        })
        .catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [scanning, root?.id]);

  if (!stats) {
    return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">Loading…</div>;
  }

  function jumpToFilename(filename: string) {
    selectFolder(null);
    setFilters({ search: filename });
  }

  function browseAll() {
    clearFilters();
    selectFolder(null);
  }

  return (
    <div className="relative h-full overflow-y-auto">
      {/* A stronger dose of the same misty-forest gradient used app-wide
          (--hero-glow, see globals.css) — the closest this app's "landing
          view" gets to a photographic hero without an actual photo asset. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        style={{ background: "var(--hero-glow)" }}
      />

      <div className="relative mx-auto flex max-w-5xl flex-col gap-10 px-8 py-14">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-text-tertiary">Local Library</span>
          <h1 className="text-[34px] font-semibold leading-tight tracking-tight text-text-primary">{root?.displayName}</h1>
          <p className="max-w-lg truncate text-[13px] text-text-tertiary">{root?.canonicalPath}</p>
          <button
            onClick={browseAll}
            className="mt-3 rounded-control bg-accent px-5 py-2.5 text-[13px] font-medium text-white shadow-[0_6px_24px_rgba(102,115,224,0.4)] transition-transform duration-150 hover:-translate-y-0.5 active:scale-[0.98]"
          >
            Browse All Media
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Total Media" value={stats.total.toLocaleString()} />
          <StatCard label="Photos" value={stats.photos.toLocaleString()} />
          <StatCard label="Videos" value={stats.videos.toLocaleString()} />
          <StatCard label="Storage" value={formatBytes(stats.totalSize)} />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Favorites"
            value={stats.favorites.toLocaleString()}
            sub={stats.favorites > 0 ? "View in sidebar" : undefined}
          />
          <StatCard
            label="Longest Video"
            value={stats.longestVideo ? formatDuration(stats.longestVideo.durationMs) : "—"}
            sub={stats.longestVideo?.filename}
          />
          <StatCard
            label="Scan Status"
            value={scanning ? "In progress" : "Up to date"}
            sub={scanning ? `${stats.pendingMetadata + stats.pendingThumbnails} pending` : undefined}
          />
          <StatCard label="Root" value={root ? "Sandboxed ✓" : "—"} sub="This folder only" />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <EntryList title="Recently Added" entries={stats.recentlyAdded} onOpen={jumpToFilename} />
          <EntryList title="Recently Modified" entries={stats.recentlyModified} onOpen={jumpToFilename} />
          <EntryList title="Largest Files" entries={stats.largestFiles} showDuration onOpen={jumpToFilename} />
        </div>
      </div>
    </div>
  );
}
