import type { MouseEvent } from "react";
import { openRoot, pickRootFolder, removeRecentRoot } from "../lib/api";
import logo from "../assets/logo.png";
import { useRootStore } from "../stores/rootStore";

export function Onboarding() {
  const { recentRoots, setRoot, setError, setRecentRoots, setNotice } = useRootStore();

  function noticeIfRepaired(info: { repaired: boolean }) {
    if (info.repaired) {
      setNotice("This library's index needed to be rebuilt after a problem — your files are safe, and it's re-scanning now.");
    }
  }

  async function handlePick() {
    try {
      const info = await pickRootFolder();
      if (info) {
        setRoot(info);
        noticeIfRepaired(info);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleOpenRecent(path: string) {
    try {
      const info = await openRoot(path);
      setRoot(info);
      noticeIfRepaired(info);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRemoveRecent(path: string, e: MouseEvent) {
    e.stopPropagation();
    await removeRecentRoot(path);
    setRecentRoots(recentRoots.filter((r) => r.canonicalPath !== path));
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-10 px-6">
      <div className="animate-fade-in flex flex-col items-center gap-3 text-center">
        <img src={logo} alt="" draggable={false} className="h-20 w-20 rounded-[22px] shadow-[0_8px_30px_rgba(60,70,180,0.35)]" />
        <h1 className="text-2xl font-semibold text-text-primary">Quin Gallery</h1>
        <p className="max-w-sm text-sm text-text-secondary">
          Choose a folder to use as your Gallery Root. Everything inside it — and only that —
          will be indexed and browsable.
        </p>
      </div>

      <button
        onClick={handlePick}
        className="no-drag rounded-control bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-[0_8px_30px_rgba(10,132,255,0.35)] transition-transform active:scale-[0.98]"
      >
        Choose Gallery Root Folder…
      </button>

      {recentRoots.length > 0 && (
        <div className="animate-fade-in flex w-full max-w-md flex-col gap-1.5">
          <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
            Recent Root Folders
          </div>
          {recentRoots.map((r) => (
            <button
              key={r.canonicalPath}
              onClick={() => handleOpenRecent(r.canonicalPath)}
              className="group flex items-center justify-between rounded-control bg-card px-3.5 py-2.5 text-left transition-colors hover:bg-card-hover"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-text-primary">{r.displayName}</span>
                <span className="truncate text-xs text-text-tertiary">{r.canonicalPath}</span>
              </div>
              <span
                onClick={(e) => handleRemoveRecent(r.canonicalPath, e)}
                className="ml-3 shrink-0 rounded px-1.5 py-0.5 text-xs text-text-tertiary opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
              >
                Remove
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
