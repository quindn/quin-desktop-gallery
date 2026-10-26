import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getFolders, getStartupInfo, listAllTags, openRoot, type ScanProgress } from "./lib/api";
import { useRootStore } from "./stores/rootStore";
import { useGalleryStore } from "./stores/galleryStore";
import { clearThumbnails, setThumbFailed, setThumbReady } from "./stores/thumbnailStore";
import { TitleBar } from "./components/TitleBar";
import { Onboarding } from "./components/Onboarding";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { GalleryGrid } from "./components/GalleryGrid";
import { Dashboard } from "./components/Dashboard";
import { BrowserView } from "./components/BrowserView";
import { DownloadsView } from "./components/DownloadsView";
import { LockScreen } from "./components/LockScreen";
import { OnlineView } from "./components/OnlineView";
import { Studio } from "./components/Studio";
import { EnhanceDialog } from "./components/EnhanceDialog";
import { RainOverlay } from "./components/RainOverlay";
import { useLockStore } from "./stores/lockStore";
import { initWebEvents } from "./stores/webStores";

function App() {
  const phase = useRootStore((s) => s.phase);
  const root = useRootStore((s) => s.root);
  const setOnboarding = useRootStore((s) => s.setOnboarding);
  const setRoot = useRootStore((s) => s.setRoot);
  const setScanProgress = useRootStore((s) => s.setScanProgress);
  const setError = useRootStore((s) => s.setError);
  const notice = useRootStore((s) => s.notice);
  const noticeAction = useRootStore((s) => s.noticeAction);
  const setNotice = useRootStore((s) => s.setNotice);
  const setFolders = useGalleryStore((s) => s.setFolders);
  const setTags = useGalleryStore((s) => s.setTags);
  const mainView = useGalleryStore((s) => s.mainView);
  const bumpRefresh = useGalleryStore((s) => s.bumpRefresh);
  const resetForRoot = useGalleryStore((s) => s.resetForRoot);
  const lastProgressBump = useRef(0);
  const locked = useLockStore((s) => s.locked);
  const lock = useLockStore((s) => s.lock);

  useEffect(() => {
    initWebEvents();
  }, []);

  // The backend says "lock" whenever the window is hidden to / brought back
  // from the tray.
  useEffect(() => {
    const unlisten = listen("app://lock", () => lock());
    return () => {
      unlisten.then((f) => f());
    };
  }, [lock]);

  // Startup: reopen the last root automatically, or show onboarding.
  useEffect(() => {
    (async () => {
      try {
        const info = await getStartupInfo();
        if (info.lastRootPath) {
          try {
            const rootInfo = await openRoot(info.lastRootPath);
            setRoot(rootInfo);
            if (info.restored) {
              setNotice("Restored the last library automatically from the data folder next to the app.");
            } else if (rootInfo.repaired) {
              setNotice("This library's index needed to be rebuilt after a problem — your files are safe, and it's re-scanning now.");
            }
            return;
          } catch (e) {
            setError(String(e));
          }
        }
        setOnboarding(info.recentRoots);
      } catch (e) {
        setError(String(e));
        setOnboarding([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A background check after a crash found the library index damaged: it is rebuilt on restart.
  useEffect(() => {
    const unlisten = listen("library://damaged", () =>
      setNotice("The library index was damaged by the last crash. Restart to rebuild it — your files are safe.", "restart"),
    );
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live scan progress -> status pill + throttled data refresh.
  useEffect(() => {
    const unlisten = listen<any>("scan://progress", (event) => {
      const raw = event.payload;
      const progress: ScanProgress = {
        scanned: raw.scanned,
        touched: raw.touched,
        currentFolder: raw.current_folder,
        done: raw.done,
        phase: raw.phase,
      };
      setScanProgress(progress.done ? null : progress);

      const now = Date.now();
      if (progress.done || now - lastProgressBump.current > 3000) {
        lastProgressBump.current = now;
        bumpRefresh();
        getFolders().then(setFolders).catch(() => {});
        listAllTags().then(setTags).catch(() => {});
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A newly opened root invalidates the previous root's in-memory state —
  // ids are only unique within one root's own database.
  useEffect(() => {
    if (phase === "ready" && root) {
      resetForRoot(root.id);
      clearThumbnails();
      getFolders().then(setFolders).catch(() => {});
      listAllTags().then(setTags).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, root?.id]);

  // Thumbnails generated in the background arrive as events rather than
  // blocking the command that requested them (see thumbnails::queue).
  useEffect(() => {
    const unlistenReady = listen<any>("thumbnail://ready", (event) => {
      setThumbReady(event.payload.id, event.payload.path);
    });
    const unlistenFailed = listen<any>("thumbnail://failed", (event) => {
      setThumbFailed(event.payload.id);
    });
    return () => {
      unlistenReady.then((f) => f());
      unlistenFailed.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative isolate flex h-screen w-screen flex-col overflow-hidden text-text-primary">
      <div className="app-backdrop" aria-hidden>
        <RainOverlay />
      </div>
      <TitleBar />
      {notice && !locked && (
        <div className="animate-fade-in flex shrink-0 items-center gap-3 border-b border-hairline bg-accent/10 px-4 py-2 text-[12px] text-text-primary">
          <span className="flex-1">{notice}</span>
          {noticeAction === "restart" && (
            <button
              onClick={() => void invoke("restart_app")}
              className="shrink-0 rounded-control bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
            >
              Restart now
            </button>
          )}
          <button onClick={() => setNotice(null)} className="shrink-0 text-text-tertiary transition-colors hover:text-text-primary">
            Dismiss
          </button>
        </div>
      )}
      {!locked && phase === "ready" && <EnhanceDialog />}
      {locked && <LockScreen />}
      {!locked && phase === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">Loading…</div>
      )}
      {!locked && phase === "onboarding" && (
        <div className="flex-1 overflow-hidden">
          <Onboarding />
        </div>
      )}
      {!locked && phase === "ready" && (
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <div className="flex flex-1 flex-col overflow-hidden">
            {mainView === "dashboard" ? (
              <Dashboard />
            ) : mainView === "online" ? (
              <OnlineView />
            ) : mainView === "downloads" ? (
              <DownloadsView />
            ) : mainView === "browser" ? (
              <BrowserView />
            ) : mainView === "studio" ? (
              <Studio />
            ) : (
              <>
                <Toolbar />
                <GalleryGrid />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
