import { memo, useEffect, type MouseEvent } from "react";
import type { MediaListItem } from "../lib/api";
import { formatBytes, formatDate, formatDuration, formatResolution } from "../lib/format";
import { requestThumbnail, useThumbUrl } from "../stores/thumbnailStore";
import { beginPossibleFileDrag, clickSuppressed } from "../lib/fileDrag";

export const LIST_ROW_HEIGHT = 52;

function StarRating({ rating }: { rating: number }) {
  if (!rating) return <span className="text-text-tertiary">—</span>;
  return (
    <div className="flex items-center gap-px">
      {[1, 2, 3, 4, 5].map((n) => (
        <svg key={n} width="8" height="8" viewBox="0 0 24 24" fill={n <= rating ? "#f5c451" : "none"} stroke="#f5c451" strokeWidth="2">
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ))}
    </div>
  );
}

export const ListRow = memo(function ListRow({
  item,
  index,
  selected,
  expanded,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  item: MediaListItem;
  index: number;
  selected: boolean;
  expanded: boolean;
  onSelect: (id: number, e: MouseEvent) => void;
  onOpen: (index: number) => void;
  onContextMenu: (id: number, e: MouseEvent) => void;
}) {
  const url = useThumbUrl(item.id);
  const resolution = formatResolution(item.width, item.height);
  const camera = [item.cameraMake, item.cameraModel].filter(Boolean).join(" ");

  useEffect(() => {
    if (item.thumbnailState !== "failed") requestThumbnail(item.id);
  }, [item.id, item.thumbnailState]);

  return (
    <div
      data-media-id={item.id}
      onPointerDown={(e) => beginPossibleFileDrag(item.id, e)}
      onClick={(e) => !clickSuppressed() && onSelect(item.id, e)}
      onDoubleClick={() => !clickSuppressed() && onOpen(index)}
      onContextMenu={(e) => onContextMenu(item.id, e)}
      style={{ height: LIST_ROW_HEIGHT - 4 }}
      className={`flex w-full cursor-default items-center gap-3 rounded-control px-2 transition-colors ${
        selected ? "bg-accent-soft" : "hover:bg-card-hover"
      }`}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-card">
        {url && <img src={url} className="h-full w-full object-cover" alt="" draggable={false} decoding="async" />}
      </div>
      <span className="w-64 shrink-0 truncate text-[13px] text-text-primary">{item.filename}</span>
      <span className="w-40 shrink-0 truncate text-[12px] text-text-tertiary">{item.folderRelPath || "(root)"}</span>
      <span className="w-16 shrink-0 text-[12px] text-text-tertiary">
        {item.mediaType === "video" ? formatDuration(item.durationMs) : ""}
      </span>
      <span className="w-20 shrink-0 text-[12px] text-text-tertiary">{resolution ?? ""}</span>
      <span className="w-20 shrink-0 text-[12px] text-text-tertiary">{formatBytes(item.fileSize)}</span>
      <span className="w-28 shrink-0 text-[12px] text-text-tertiary">{formatDate(item.modifiedTime)}</span>
      {expanded && (
        <>
          <span className="w-28 shrink-0 text-[12px] text-text-tertiary">{formatDate(item.createdTime)}</span>
          <span className="w-28 shrink-0 text-[12px] text-text-tertiary">
            {item.dateTaken ? formatDate(item.dateTaken) : "—"}
          </span>
          <span className="w-16 shrink-0">
            <StarRating rating={item.rating} />
          </span>
          <span className="w-36 shrink-0 truncate text-[12px] text-text-tertiary">{camera || "—"}</span>
          <span className="w-14 shrink-0 text-[12px] text-text-tertiary">
            {item.gpsLat !== null && item.gpsLon !== null ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-[#5eb1ff]">
                <path d="M12 22s7-7.58 7-13a7 7 0 1 0-14 0c0 5.42 7 13 7 13z" />
                <circle cx="12" cy="9" r="2.5" />
              </svg>
            ) : (
              "—"
            )}
          </span>
        </>
      )}
      {item.favorite && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="#0A84FF" className="ml-auto shrink-0">
          <path d="M12 21s-6.5-4.35-9.5-8.15C.6 10.2 1.2 6.7 4 5.2c2-1.07 4.4-.4 6 1.5 1.6-1.9 4-2.57 6-1.5 2.8 1.5 3.4 5 1.5 7.65C18.5 16.65 12 21 12 21z" />
        </svg>
      )}
    </div>
  );
});
