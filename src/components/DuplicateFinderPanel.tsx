import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { deleteMedia, findDuplicates, openInExplorer, type DuplicateGroup } from "../lib/api";
import { formatBytes, formatDate } from "../lib/format";
import { Portal } from "./Portal";

export function DuplicateFinderPanel({ onClose }: { onClose: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ hashed: number; total: number } | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const unlistenProgress = listen<any>("duplicates://progress", (e) => {
      setProgress({ hashed: e.payload.hashed, total: e.payload.total });
    });
    const unlistenResult = listen<any>("duplicates://result", (e) => {
      const raw: any[] = e.payload;
      setGroups(
        raw.map((g) => ({
          method: g.method,
          members: g.members.map((m: any) => ({
            id: m.id,
            relPath: m.rel_path,
            filename: m.filename,
            fileSize: m.file_size,
            modifiedTime: m.modified_time,
          })),
        })),
      );
      setScanning(false);
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenResult.then((f) => f());
    };
  }, []);

  async function handleScan() {
    setScanning(true);
    setGroups(null);
    setDeletedIds(new Set());
    await findDuplicates();
  }

  async function handleDelete(id: number) {
    const result = await deleteMedia([id]);
    if (result.succeeded.length) {
      setDeletedIds((prev) => new Set(prev).add(id));
    }
  }

  return (
    <Portal>
    <div
      className="animate-fade-in fixed inset-x-0 top-9 bottom-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="sheet-surface animate-sheet-in flex max-h-[80vh] w-[560px] flex-col rounded-sheet p-5"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[15px] font-semibold text-text-primary">Find Duplicates</span>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            ✕
          </button>
        </div>
        <p className="mb-3 text-[12px] text-text-secondary">
          Exact content-matches and same-size candidates. Nothing is ever deleted automatically — review each group
          and delete individual files yourself.
        </p>

        <button
          onClick={handleScan}
          disabled={scanning}
          className="mb-3 self-start rounded-control bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {scanning ? `Scanning… ${progress ? `${progress.hashed}/${progress.total}` : ""}` : "Scan for Duplicates"}
        </button>

        <div className="flex-1 overflow-y-auto">
          {groups === null && !scanning && (
            <p className="text-[12px] text-text-tertiary">Run a scan to look for duplicate files.</p>
          )}
          {groups !== null && groups.length === 0 && (
            <p className="text-[12px] text-text-tertiary">No duplicates found.</p>
          )}
          {groups?.map((group, gi) => (
            <div key={gi} className="mb-3 rounded-card bg-card/50 p-3">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                {group.method === "exact_hash" ? "Exact match" : "Same size (candidate)"}
              </div>
              <div className="flex flex-col divide-y divide-white/5">
                {group.members.map((m) => (
                  <div
                    key={m.id}
                    className={`flex items-center gap-2 py-1.5 text-[12px] ${deletedIds.has(m.id) ? "opacity-30" : ""}`}
                  >
                    <span className="flex-1 truncate text-text-primary">{m.relPath}</span>
                    <span className="shrink-0 text-text-tertiary">{formatBytes(m.fileSize)}</span>
                    <span className="shrink-0 text-text-tertiary">{formatDate(m.modifiedTime)}</span>
                    <button
                      onClick={() => openInExplorer(m.relPath)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-text-tertiary hover:text-text-primary"
                    >
                      ⧉
                    </button>
                    <button
                      onClick={() => handleDelete(m.id)}
                      disabled={deletedIds.has(m.id)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-red-400 hover:bg-red-500/15 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
    </Portal>
  );
}
