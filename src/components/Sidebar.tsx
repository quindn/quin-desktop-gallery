import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { FolderNode } from "../lib/api";
import { openInExplorer, pickRootFolder, rescanRoot, scanNewFolders } from "../lib/api";
import { useGalleryStore } from "../stores/galleryStore";
import { useRootStore } from "../stores/rootStore";
import { useBrowserStore, useDownloadStore } from "../stores/webStores";
import { DuplicateFinderPanel } from "./DuplicateFinderPanel";
import { LanPanel } from "./LanPanel";
import { SettingsPanel } from "./SettingsPanel";

function Row({
  name,
  depth = 0,
  count,
  active,
  icon,
  chevron,
  onSelect,
}: {
  name: string;
  depth?: number;
  count?: number;
  active: boolean;
  icon?: ReactNode;
  chevron?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      style={{ paddingLeft: 8 + depth * 16 }}
      className={`group flex w-full items-center gap-1.5 rounded-control py-[7px] pr-2.5 text-left text-[13px] transition-colors active:scale-[0.99] ${
        active ? "bg-accent-soft text-text-primary" : "text-text-secondary hover:bg-card-hover hover:text-text-primary"
      }`}
    >
      {chevron}
      {icon}
      <span className="truncate">{name}</span>
      {!!count && (
        <span
          className={`ml-auto shrink-0 rounded-full px-1.5 py-px text-[10px] tabular-nums ${
            active ? "bg-accent/25 text-text-secondary" : "text-text-tertiary group-hover:text-text-secondary"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 mt-4 px-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary first:mt-0">{children}</div>;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-text-tertiary transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="shrink-0 text-[#5eb1ff]">
      {open ? (
        <path
          d="M3 8a2 2 0 0 1 2-2h4.2l1.6 2H19a2 2 0 0 1 2 2v.4H7.2a2 2 0 0 0-1.94 1.51L3.6 17.5 3 17V8z M4.9 18.5l1.9-7.3A1 1 0 0 1 7.76 10.5H21a1 1 0 0 1 .97 1.24l-1.8 6.76a1 1 0 0 1-.97.74H5.87a1 1 0 0 1-.97-1.24z"
          fill="currentColor"
        />
      ) : (
        <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.4l2 2.2H19.5A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12z" fill="currentColor" />
      )}
    </svg>
  );
}

interface TreeNode {
  folder: FolderNode;
  children: TreeNode[];
  /** Search only: this node is an ancestor of a match, so it stays open. */
  forceOpen?: boolean;
}

/** Lower-cased and accent-stripped, so "anh dep" finds "Ảnh Đẹp". */
function normalizeForSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
}

/**
 * Keeps folders whose name (or path) contains the query, plus the ancestors
 * needed to reach them. A folder that matches itself keeps its whole
 * subtree so you can drill into it; ancestors of a match are opened.
 */
function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    const selfMatch =
      normalizeForSearch(node.folder.name).includes(query) || normalizeForSearch(node.folder.relPath).includes(query);
    const matchingChildren = filterTree(node.children, query);
    if (matchingChildren.length > 0) {
      out.push({ ...node, children: selfMatch ? node.children : matchingChildren, forceOpen: true });
    } else if (selfMatch) {
      out.push(node);
    }
  }
  return out;
}

function countNodes(nodes: TreeNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

function buildFolderTree(folders: FolderNode[]): TreeNode[] {
  const relevant = folders.filter((f) => f.relPath !== "");
  const byPath = new Map<string, TreeNode>();
  for (const f of relevant) byPath.set(f.relPath, { folder: f, children: [] });
  const roots: TreeNode[] = [];
  for (const f of relevant) {
    const node = byPath.get(f.relPath)!;
    const parent = f.parentRelPath ? byPath.get(f.parentRelPath) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function FolderTree({
  nodes,
  expanded,
  toggleExpanded,
  selectedFolder,
  onSelect,
}: {
  nodes: TreeNode[];
  expanded: Set<string>;
  toggleExpanded: (relPath: string) => void;
  selectedFolder: string | null;
  onSelect: (relPath: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isExpanded = !!node.forceOpen || expanded.has(node.folder.relPath);
        const hasChildren = node.children.length > 0;
        return (
          <div key={node.folder.relPath}>
            <Row
              name={node.folder.name}
              depth={node.folder.depth}
              count={node.folder.mediaCount}
              active={selectedFolder === node.folder.relPath}
              onSelect={() => onSelect(node.folder.relPath)}
              chevron={
                hasChildren ? (
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(node.folder.relPath);
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/10"
                  >
                    <Chevron expanded={isExpanded} />
                  </span>
                ) : (
                  <span className="w-4 shrink-0" />
                )
              }
              icon={<FolderIcon open={isExpanded} />}
            />
            {hasChildren && isExpanded && (
              <FolderTree
                nodes={node.children}
                expanded={expanded}
                toggleExpanded={toggleExpanded}
                selectedFolder={selectedFolder}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function Sidebar() {
  const root = useRootStore((s) => s.root);
  const setRoot = useRootStore((s) => s.setRoot);
  const folders = useGalleryStore((s) => s.folders);
  const tags = useGalleryStore((s) => s.tags);
  const mainView = useGalleryStore((s) => s.mainView);
  const setMainView = useGalleryStore((s) => s.setMainView);
  const selectedFolder = useGalleryStore((s) => s.selectedFolder);
  const selectFolder = useGalleryStore((s) => s.selectFolder);
  const filters = useGalleryStore((s) => s.filters);
  const setFilters = useGalleryStore((s) => s.setFilters);
  const clearFilters = useGalleryStore((s) => s.clearFilters);
  const [rescanning, setRescanning] = useState(false);
  const [scanningNew, setScanningNew] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [lanOpen, setLanOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const activeDownloads = useDownloadStore((st) => st.tasks.filter((t) => t.status === "running" || t.status === "queued").length);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const [folderQuery, setFolderQuery] = useState("");
  const normalizedQuery = normalizeForSearch(folderQuery.trim());
  const visibleTree = useMemo(
    () => (normalizedQuery ? filterTree(tree, normalizedQuery) : tree),
    [tree, normalizedQuery],
  );

  // Keep the currently-selected folder's ancestor chain visible without
  // forcing the whole tree open — collapsed-by-default stays uncluttered.
  useEffect(() => {
    if (!selectedFolder) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = selectedFolder.split("/");
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [selectedFolder]);

  function toggleExpanded(relPath: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  }

  async function handleChangeRoot() {
    const info = await pickRootFolder();
    if (info) setRoot(info);
  }

  async function handleRescan() {
    setRescanning(true);
    try {
      await rescanRoot();
    } finally {
      setTimeout(() => setRescanning(false), 800);
    }
  }

  /** Fast path: only indexes folders added since the last scan, instead of re-walking the whole
   *  library. Deleted/renamed files still need the full "Rescan" (or just wait — the live
   *  watcher already reacts to those on its own). */
  async function handleScanNewFolders() {
    setScanningNew(true);
    try {
      await scanNewFolders();
    } finally {
      setTimeout(() => setScanningNew(false), 800);
    }
  }

  function goToAllMedia() {
    selectFolder(null);
    clearFilters();
  }

  const inLibraryAll = mainView === "library" && selectedFolder === null;
  const isFavorites = inLibraryAll && filters.favoritesOnly;
  const isNeedsDeepScan = inLibraryAll && !!filters.metadataStates?.includes("needs_deep_scan");
  const isMetadataErrors = inLibraryAll && !!filters.metadataStates?.includes("failed");
  const isPlainAllMedia = inLibraryAll && !isFavorites && !isNeedsDeepScan && !isMetadataErrors;

  return (
    <div className="glass relative z-20 flex h-full w-64 shrink-0 flex-col border-r border-hairline">
      <div className="flex flex-col gap-1 border-b border-hairline p-3">
        <div className="truncate text-[13px] font-semibold text-text-primary">{root?.displayName}</div>
        <div className="truncate text-[11px] text-text-tertiary">{root?.canonicalPath}</div>
        <div className="mt-2 flex gap-1.5">
          <button
            onClick={handleChangeRoot}
            className="flex-1 rounded-control bg-card px-2 py-1.5 text-[11px] text-text-secondary transition-colors active:scale-[0.97] hover:bg-card-hover hover:text-text-primary"
          >
            Change Root
          </button>
          <button
            onClick={() => openInExplorer(null)}
            aria-label="Open in Explorer"
            className="rounded-control bg-card px-2 py-1.5 text-[11px] text-text-secondary transition-colors active:scale-[0.97] hover:bg-card-hover hover:text-text-primary"
          >
            ⧉
          </button>
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <button
            onClick={handleScanNewFolders}
            title="Only scans folders added since the last scan — fast even on a huge library"
            className="flex-1 rounded-control bg-card px-2 py-1.5 text-[11px] text-text-secondary transition-colors active:scale-[0.97] hover:bg-card-hover hover:text-text-primary"
          >
            {scanningNew ? "Scanning…" : "Scan New Folders"}
          </button>
          <button
            onClick={handleRescan}
            title="Walks the whole library again — also catches files moved, renamed or deleted outside the app"
            className="flex-1 rounded-control bg-card px-2 py-1.5 text-[11px] text-text-secondary transition-colors active:scale-[0.97] hover:bg-card-hover hover:text-text-primary"
          >
            {rescanning ? "Rescanning…" : "Full Rescan"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <SectionLabel>Library</SectionLabel>
        <Row name="Dashboard" active={mainView === "dashboard"} onSelect={() => setMainView("dashboard")} />
        <Row name="All Media" active={isPlainAllMedia} onSelect={goToAllMedia} />
        <Row name="Studio (video editor)" active={mainView === "studio"} onSelect={() => setMainView("studio")} />

        <SectionLabel>Online</SectionLabel>
        <Row
          name="Browser"
          active={mainView === "browser"}
          onSelect={() => {
            // clicking Browser always starts at the Profile Manager
            useBrowserStore.getState().setProfile(null);
            setMainView("browser");
          }}
        />
        <Row name="Open a Link" active={mainView === "online"} onSelect={() => setMainView("online")} />
        <Row
          name="Downloads"
          count={activeDownloads || undefined}
          active={mainView === "downloads"}
          onSelect={() => setMainView("downloads")}
        />

        <SectionLabel>Smart Collections</SectionLabel>
        <Row
          name="Favorites"
          active={isFavorites}
          onSelect={() => {
            selectFolder(null);
            clearFilters();
            setFilters({ favoritesOnly: true });
          }}
        />
        <Row
          name="Needs Deep Scan"
          active={isNeedsDeepScan}
          onSelect={() => {
            selectFolder(null);
            clearFilters();
            setFilters({ metadataStates: ["needs_deep_scan"] });
          }}
        />
        <Row
          name="Metadata Errors"
          active={isMetadataErrors}
          onSelect={() => {
            selectFolder(null);
            clearFilters();
            setFilters({ metadataStates: ["failed"] });
          }}
        />

        {tree.length > 0 && (
          <>
            <SectionLabel>Folders</SectionLabel>
            <div className="relative mb-1.5 px-1">
              <input
                type="text"
                value={folderQuery}
                onChange={(e) => setFolderQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setFolderQuery("");
                }}
                placeholder="Search folders…"
                aria-label="Search folders"
                className="w-full rounded-control bg-card py-1.5 pl-2.5 pr-7 text-[12px] text-text-primary outline-none placeholder:text-text-tertiary focus:ring-1 focus:ring-accent"
              />
              {folderQuery && (
                <button
                  onClick={() => setFolderQuery("")}
                  aria-label="Clear folder search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 px-1 text-[13px] leading-none text-text-tertiary hover:text-text-primary"
                >
                  ×
                </button>
              )}
            </div>
            {normalizedQuery && (
              <div className="mb-1 px-2 text-[11px] text-text-tertiary">
                {visibleTree.length === 0 ? "No folders match" : `${countNodes(visibleTree).toLocaleString()} shown`}
              </div>
            )}
            <FolderTree
              nodes={visibleTree}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
              selectedFolder={mainView === "library" ? selectedFolder : null}
              onSelect={(relPath) => {
                selectFolder(relPath);
                clearFilters();
              }}
            />
          </>
        )}

        {tags.length > 0 && (
          <>
            <SectionLabel>Tags</SectionLabel>
            {tags.map((t) => (
              <Row
                key={t.id}
                name={t.name}
                count={t.count}
                active={mainView === "library" && filters.tag === t.name}
                onSelect={() => {
                  selectFolder(null);
                  clearFilters();
                  setFilters({ tag: t.name });
                }}
              />
            ))}
          </>
        )}

        <SectionLabel>Tools</SectionLabel>
        <Row name="Find Duplicates" active={false} onSelect={() => setDuplicatesOpen(true)} />
        <Row name="LAN Sharing" active={false} onSelect={() => setLanOpen(true)} />
      </div>

      <div className="border-t border-hairline p-2">
        <button
          onClick={() => setSettingsOpen(true)}
          className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[12px] text-text-secondary transition-colors active:scale-[0.99] hover:bg-card-hover hover:text-text-primary"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
          Settings
        </button>
      </div>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {duplicatesOpen && <DuplicateFinderPanel onClose={() => setDuplicatesOpen(false)} />}
      {lanOpen && <LanPanel onClose={() => setLanOpen(false)} />}
    </div>
  );
}
