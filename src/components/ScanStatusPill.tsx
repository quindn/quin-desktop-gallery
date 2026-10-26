import { useRootStore } from "../stores/rootStore";

export function ScanStatusPill() {
  const progress = useRootStore((s) => s.scanProgress);
  if (!progress || progress.done) return null;

  return (
    <div className="no-drag animate-fade-in flex items-center gap-2 rounded-control bg-card px-2.5 py-1.5 text-[12px] text-text-secondary">
      <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      {progress.phase === "new-folders"
        ? `New folder${progress.currentFolder ? ` “${progress.currentFolder.split("/").pop()}”` : ""}… ${progress.scanned.toLocaleString()} files`
        : `Scanning… ${progress.scanned.toLocaleString()} files`}
    </div>
  );
}
