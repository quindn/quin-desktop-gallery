import { memo, useEffect, useState, type MouseEvent } from "react";
import type { MediaListItem } from "../lib/api";
import { setFavorite } from "../lib/api";
import { formatDuration, formatResolution } from "../lib/format";
import { requestThumbnail, useThumbUrl } from "../stores/thumbnailStore";
import { beginPossibleFileDrag, clickSuppressed } from "../lib/fileDrag";

function PlaceholderIcon({ mediaType }: { mediaType: string }) {
  if (mediaType === "video") {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-text-tertiary">
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10 9.5l5 2.5-5 2.5v-5z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-text-tertiary">
      <rect x="3" y="3" width="18" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="9" cy="9" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 16l5.5-5 4 3.5L18 10l3 3.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Memoized, with callbacks that take the id/index instead of being closed
// over per card: scrolling re-renders the grid every frame, and without this
// every visible card re-rendered with it.
export const MediaCard = memo(function MediaCard({
  item,
  index,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  size,
}: {
  item: MediaListItem;
  index: number;
  selected: boolean;
  onSelect: (id: number, e: MouseEvent) => void;
  onOpen: (index: number) => void;
  onContextMenu: (id: number, e: MouseEvent) => void;
  size: number;
}) {
  const url = useThumbUrl(item.id);
  const resolution = formatResolution(item.width, item.height);
  const [favorite, setFavoriteState] = useState(item.favorite);

  useEffect(() => {
    setFavoriteState(item.favorite);
  }, [item.favorite]);

  useEffect(() => {
    if (item.thumbnailState !== "failed") requestThumbnail(item.id);
  }, [item.id, item.thumbnailState]);

  async function toggleFavorite(e: MouseEvent) {
    e.stopPropagation();
    const next = !favorite;
    setFavoriteState(next);
    await setFavorite(item.id, next);
  }

  return (
    <div
      data-media-id={item.id}
      title="Drag to drop the file anywhere (web page, chat, Explorer…)"
      onPointerDown={(e) => beginPossibleFileDrag(item.id, e)}
      onClick={(e) => !clickSuppressed() && onSelect(item.id, e)}
      onDoubleClick={() => !clickSuppressed() && onOpen(index)}
      onContextMenu={(e) => onContextMenu(item.id, e)}
      style={{ width: size, height: size }}
      className={`group relative shrink-0 cursor-default overflow-hidden rounded-card bg-card transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.98] ${
        selected
          ? "shadow-[0_0_0_2px_var(--color-accent)]"
          : "shadow-[0_1px_3px_rgba(0,0,0,0.3)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.45)] hover:-translate-y-0.5"
      }`}
    >
      {url ? (
        <img src={url} draggable={false} decoding="async" className="h-full w-full object-cover" alt={item.filename} />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-card">
          <PlaceholderIcon mediaType={item.mediaType} />
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/70 via-black/0 to-transparent p-1.5 pt-6 opacity-0 transition-opacity group-hover:opacity-100">
        <span className={`truncate text-[11px] text-white/90 ${item.mediaType === "video" ? "pr-16" : ""}`}>{item.filename}</span>
      </div>

      <div className="pointer-events-none absolute left-1.5 top-1.5 flex gap-1">
        {item.metadataState === "needs_deep_scan" && (
          <span className="rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-amber-300">Needs deep scan</span>
        )}
        {item.metadataState === "failed" && (
          <span className="rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-red-400">Metadata error</span>
        )}
      </div>

      <div className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1">
        {item.mediaType === "video" && (
          // Large, high-contrast pill: the old 10px chip on 55% black vanished
          // against bright thumbnails.
          <span
            className={`rounded-md bg-black/80 font-semibold tabular-nums leading-none text-white shadow-[0_1px_4px_rgba(0,0,0,0.6)] ring-1 ring-white/25 ${
              size < 140 ? "px-1.5 py-1 text-[11px]" : "px-2 py-1.5 text-[13px]"
            }`}
          >
            {formatDuration(item.durationMs)}
          </span>
        )}
        {resolution && (
          <span className="rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/70 opacity-0 transition-opacity group-hover:opacity-100">
            {resolution}
          </span>
        )}
      </div>

      <button
        onClick={toggleFavorite}
        aria-label="Toggle favorite"
        className={`absolute right-1.5 top-1.5 rounded-full bg-black/45 p-1 text-white transition-opacity ${
          favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill={favorite ? "#0A84FF" : "none"} stroke="currentColor" strokeWidth="1.8">
          <path d="M12 21s-6.5-4.35-9.5-8.15C.6 10.2 1.2 6.7 4 5.2c2-1.07 4.4-.4 6 1.5 1.6-1.9 4-2.57 6-1.5 2.8 1.5 3.4 5 1.5 7.65C18.5 16.65 12 21 12 21z" />
        </svg>
      </button>
    </div>
  );
});
