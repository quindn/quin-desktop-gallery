import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MediaListItem } from "../lib/api";
import { deleteMedia, getMediaFilePaths, openInExplorer, renameMedia, retryMetadata, setFavoriteBatch } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { useRootStore } from "../stores/rootStore";
import { formatBytes, formatDuration, formatResolution } from "../lib/format";
import { Portal } from "./Portal";
import { useStudioInbox } from "../lib/studio";
import { useEnhance } from "../lib/ai";
import { useGalleryStore } from "../stores/galleryStore";

interface Props {
  x: number;
  y: number;
  ids: number[];
  items: MediaListItem[];
  onClose: () => void;
  onDeleted: (ids: number[]) => void;
  onRenamed: (id: number, filename: string, relPath: string) => void;
  onFavoriteChanged: (ids: number[], favorite: boolean) => void;
  onEditRequested: (id: number) => void;
  /** Explorer-style copy of the files themselves (paste into Explorer, an upload box, a chat…). */
  onCopyFiles?: (ids: number[]) => void;
  /** Show only the files in this item's folder. */
  onShowFolder?: (id: number) => void;
}

function MenuItem({
  label,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center rounded-[8px] px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:opacity-30 ${
        danger ? "text-red-400 hover:bg-red-500/15" : "text-text-primary hover:bg-white/10"
      }`}
    >
      {label}
    </button>
  );
}

/** Windows-style parent folder of an absolute path. */
function parentFolder(absPath: string): string {
  const i = Math.max(absPath.lastIndexOf("\\"), absPath.lastIndexOf("/"));
  return i > 0 ? absPath.slice(0, i) : absPath;
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function describe(item: MediaListItem, absPath: string): string {
  const lines = [
    `Name: ${item.filename}`,
    `Path: ${absPath}`,
    `Size: ${formatBytes(item.fileSize)} (${item.fileSize.toLocaleString()} bytes)`,
    `Type: ${item.mediaType}${item.extension ? ` (.${item.extension})` : ""}`,
  ];
  if (item.mediaType === "video" && item.durationMs !== null) lines.push(`Duration: ${formatDuration(item.durationMs)}`);
  const res = formatResolution(item.width, item.height);
  if (res) lines.push(`Resolution: ${res}`);
  lines.push(`Modified: ${new Date(item.modifiedTime).toLocaleString()}`);
  lines.push(`Created: ${new Date(item.createdTime).toLocaleString()}`);
  return lines.join("\n");
}

function Divider() {
  return <div className="my-1 h-px bg-white/10" />;
}

export function ContextMenu({ x, y, ids, items, onClose, onDeleted, onRenamed, onFavoriteChanged, onEditRequested, onCopyFiles, onShowFolder }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const rootPath = useRootStore((st) => st.root?.canonicalPath);
  // The real path when the file could be resolved; otherwise root + relative
  // path, so a copy is still a full, correct Windows path.
  const absFor = (it: MediaListItem, paths: Map<number, string | null>) =>
    paths.get(it.id) ?? [(rootPath ?? "").replace(/[\\/]+$/, ""), it.relPath.replace(/\//g, "\\")].join("\\");

  const selectedItems = items.filter((it) => ids.includes(it.id));
  const single = selectedItems.length === 1 ? selectedItems[0] : null;
  const allFavorite = selectedItems.length > 0 && selectedItems.every((it) => it.favorite);

  useEffect(() => {
    function onDocClick(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
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
  }, [onClose]);

  // Keep the menu fully on-screen: measure it (it grows when the Copy group
  // opens) rather than guessing a height.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, copyOpen, renaming]);
  const style = { left: pos.left, top: pos.top };

  // Every copy action works on the whole selection (one entry per line), and
  // paths are the real absolute Windows paths — not the library-relative,
  // forward-slash form stored in the database.
  async function copyWith(build: (paths: Map<number, string | null>) => string) {
    const paths = await getMediaFilePaths(selectedItems.map((it) => it.id));
    const ok = await copyText(build(paths));
    if (!ok) {
      setCopied("Copy failed");
      return;
    }
    onClose();
  }

  async function handleDelete() {
    const result = await deleteMedia(ids);
    onDeleted(result.succeeded);
    onClose();
  }

  async function handleFavorite() {
    await setFavoriteBatch(ids, !allFavorite);
    onFavoriteChanged(ids, !allFavorite);
    onClose();
  }

  async function handleRenameSubmit() {
    if (!single || !renameValue.trim()) {
      onClose();
      return;
    }
    try {
      await renameMedia(single.id, renameValue.trim());
      const newRelPath = single.folderRelPath ? `${single.folderRelPath}/${renameValue.trim()}` : renameValue.trim();
      onRenamed(single.id, renameValue.trim(), newRelPath);
    } finally {
      onClose();
    }
  }

  if (renaming && single) {
    return (
      <Portal>
      <div
        ref={ref}
        style={style}
        className="menu-surface animate-pop-in fixed z-[300] w-64 rounded-card p-2"
      >
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRenameSubmit();
            if (e.key === "Escape") onClose();
          }}
          className="w-full rounded-control bg-black/30 px-2 py-1.5 text-[13px] text-white outline-none ring-1 ring-accent"
        />
        <div className="mt-1.5 flex justify-end gap-1.5">
          <MenuItem label="Cancel" onClick={onClose} />
          <MenuItem label="Rename" onClick={handleRenameSubmit} />
        </div>
      </div>
      </Portal>
    );
  }

  return (
    <Portal>
    <div ref={ref} style={style} className="menu-surface animate-pop-in fixed z-[300] w-56 rounded-card p-1.5">
      {single && (
        <MenuItem
          label="Open in Folder"
          onClick={() => {
            openInExplorer(single.relPath);
            onClose();
          }}
        />
      )}
      <MenuItem label={allFavorite ? "Remove from Favorites" : "Add to Favorites"} onClick={handleFavorite} />
      {single && onShowFolder && (
        <MenuItem
          label="Show This Folder Only"
          onClick={() => {
            onShowFolder(single.id);
            onClose();
          }}
        />
      )}
      {single && (
        <MenuItem
          label="Rename…"
          onClick={() => {
            setRenameValue(single.filename);
            setRenaming(true);
          }}
        />
      )}
      {single && single.mediaType === "video" && (
        <MenuItem
          label="AI Enhance (smoother / sharper)…"
          onClick={() => {
            useEnhance.getState().open({ id: single.id, filename: single.filename });
            onClose();
          }}
        />
      )}
      {single && single.mediaType === "video" && (
        <MenuItem
          label="Edit Video…"
          onClick={() => {
            onEditRequested(single.id);
            onClose();
          }}
        />
      )}
      {selectedItems.some((it) => it.mediaType === "video" || it.mediaType === "photo") && (
        <MenuItem
          label={`Add to Studio${ids.length > 1 ? ` (${ids.length})` : ""}`}
          onClick={() => {
            useStudioInbox.getState().push(selectedItems.filter((it) => it.mediaType === "video" || it.mediaType === "photo").map((it) => it.id));
            useGalleryStore.getState().setMainView("studio");
            onClose();
          }}
        />
      )}
      {selectedItems.length > 0 && (
        <>
          {onCopyFiles && (
            <MenuItem
              label={`Copy ${ids.length > 1 ? `${ids.length} Files` : "File"}  (Ctrl+C)`}
              onClick={() => {
                onCopyFiles(ids);
                onClose();
              }}
            />
          )}
          <MenuItem label={copyOpen ? "Copy ▾" : "Copy ▸"} onClick={() => setCopyOpen((v) => !v)} />
          {copyOpen && (
            <div className="mb-1 ml-2 border-l border-white/10 pl-1">
              <MenuItem
                label="Full Path"
                onClick={() =>
                  copyWith((paths) => selectedItems.map((it) => absFor(it, paths)).join("\r\n"))
                }
              />
              <MenuItem
                label="Folder Path"
                onClick={() =>
                  copyWith((paths) =>
                    [...new Set(selectedItems.map((it) => parentFolder(absFor(it, paths))))].join("\r\n"),
                  )
                }
              />
              <MenuItem label="File Name" onClick={() => copyWith(() => selectedItems.map((it) => it.filename).join("\r\n"))} />
              <MenuItem
                label="Name without Extension"
                onClick={() => copyWith(() => selectedItems.map((it) => stripExtension(it.filename)).join("\r\n"))}
              />
              <MenuItem
                label="Relative Path"
                onClick={() => copyWith(() => selectedItems.map((it) => it.relPath.replace(/\//g, "\\")).join("\r\n"))}
              />
              <MenuItem
                label="Details"
                onClick={() => copyWith((paths) => selectedItems.map((it) => describe(it, absFor(it, paths))).join("\r\n\r\n"))}
              />
            </div>
          )}
          {copied && <div className="px-2.5 pb-1 text-[11px] text-red-400">{copied}</div>}
        </>
      )}
      {single && single.mediaType === "video" && (
        <MenuItem
          label="Rescan Metadata"
          onClick={async () => {
            await retryMetadata(single.id);
            onClose();
          }}
        />
      )}
      <Divider />
      <MenuItem label={`Move to Recycle Bin${ids.length > 1 ? ` (${ids.length})` : ""}`} danger onClick={handleDelete} />
    </div>
    </Portal>
  );
}
