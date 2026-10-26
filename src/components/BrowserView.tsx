import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import {
  browserAction,
  browserActivate,
  browserBookmarkToggle,
  browserBookmarks,
  browserClose,
  browserDevtools,
  browserDuplicate,
  browserFind,
  browserFindClear,
  browserHideAll,
  browserIsBookmarked,
  browserNavigate,
  browserOpen,
  browserPin,
  browserPopup,
  browserPrint,
  browserProfileClear,
  browserProfiles,
  browserReopen,
  browserReorder,
  browserSetBounds,
  browserSuggest,
  browserZoom,
  type Bookmark,
  type BrowserProfile,
  type BrowserTab,
  type Suggestion,
} from "../lib/online";
import { useGalleryStore } from "../stores/galleryStore";
import {
  onBrowserShortcut,
  onFindResult,
  refreshMedia,
  useBrowserSettings,
  useBrowserStore,
  useMediaCfg,
  useMediaStore,
  useOverlayStore,
} from "../stores/webStores";
import { BookmarksPanel, BrowserSettingsPanel, ExtensionsPanel, Favicon, HistoryPanel, MediaPanel, hostOf, matchCombo } from "./BrowserPanels";
import { NewTabPage } from "./NewTabPage";
import { Avatar, ProfileManager } from "./ProfileManager";
import { Portal } from "./Portal";

type PanelKind = "media" | "bookmarks" | "history" | "extensions" | "settings";

const ico = (d: string, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

function NavButton({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors active:scale-90 disabled:opacity-30 ${
        active ? "bg-accent/25 text-text-primary" : "text-text-secondary hover:bg-white/10 hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function tabTitle(t: BrowserTab): string {
  if (t.newtab) return "New tab";
  return t.title || hostOf(t.url) || "New tab";
}

/* ----------------------------------------------------------------------- shell --- */
export function BrowserView() {
  const profileId = useBrowserStore((s) => s.profileId);
  if (!profileId) return <ProfileManager />;
  return <BrowserShell key={profileId} profileId={profileId} />;
}

function BrowserShell({ profileId }: { profileId: string }) {
  const allTabs = useBrowserStore((s) => s.tabs);
  const activeId = useBrowserStore((s) => s.activeId);
  const setActive = useBrowserStore((s) => s.setActive);
  const setProfile = useBrowserStore((s) => s.setProfile);
  const mediaAll = useMediaStore((s) => s.items);
  const settings = useBrowserSettings((s) => s.settings);
  const cfg = useMediaCfg((s) => s.cfg);
  const setMainView = useGalleryStore((s) => s.setMainView);

  const tabs = useMemo(() => allTabs.filter((t) => t.profile === profileId), [allTabs, profileId]);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const items = (activeId && mediaAll[activeId]) || [];
  const mediaCount = items.filter((i) => i.group !== "other").length;

  const stageRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [profile, setProfileMeta] = useState<BrowserProfile | null>(null);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestIdx, setSuggestIdx] = useState(-1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const [bookmarked, setBookmarked] = useState(false);
  const [bmVersion, setBmVersion] = useState(0);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findInfo, setFindInfo] = useState<{ ok: boolean; count: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const creating = useRef(false);

  useEffect(() => {
    void browserProfiles().then((l) => setProfileMeta(l.find((p) => p.id === profileId) ?? null));
  }, [profileId]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 2200);
  }, []);

  /* ---- tabs ---- */
  const newTab = useCallback(
    async (url?: string, priv?: boolean) => {
      const id = await browserOpen(profileId, url ?? "", priv ?? false);
      setActive(id);
      if (!url) window.setTimeout(() => addressRef.current?.focus(), 60);
      return id;
    },
    [profileId, setActive]
  );

  const closeTab = useCallback(
    async (id: string) => {
      const mine = useBrowserStore.getState().tabs.filter((t) => t.profile === profileId);
      const i = mine.findIndex((t) => t.id === id);
      const wasActive = useBrowserStore.getState().activeId === id;
      await browserClose(id);
      const left = mine.filter((t) => t.id !== id);
      if (left.length === 0) await newTab();
      else if (wasActive) setActive(left[Math.min(i, left.length - 1)].id);
    },
    [profileId, newTab, setActive]
  );

  // always a valid active tab inside this profile
  useEffect(() => {
    if (active || creating.current) return;
    if (tabs.length) return setActive(tabs[tabs.length - 1].id);
    // nothing yet: give a tab that is being opened right now a moment to show up before adding another
    const t = window.setTimeout(() => {
      const mine = useBrowserStore.getState().tabs.filter((x) => x.profile === profileId);
      if (mine.length || creating.current) return;
      creating.current = true;
      void newTab().finally(() => (creating.current = false));
    }, 900);
    return () => window.clearTimeout(t);
  }, [active, tabs, setActive, newTab, profileId]);

  /* ---- the native page view sits exactly on the stage ---- */
  const syncBounds = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    void browserSetBounds(r.x, r.y, r.width, r.height);
  }, []);
  useLayoutEffect(() => {
    syncBounds();
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(syncBounds);
    ro.observe(el);
    window.addEventListener("resize", syncBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [syncBounds, panel, findOpen, settings.bookmarksBar]);
  useEffect(() => () => void browserHideAll(), []);

  // (Portal overlays hide the native view themselves) show the active tab
  const overlays = useOverlayStore((s) => s.count);
  useEffect(() => {
    if (!activeId) return;
    if (overlays > 0) void browserHideAll();
    else {
      syncBounds();
      void browserActivate(activeId);
      void refreshMedia(activeId);
    }
  }, [activeId, overlays, syncBounds]);

  /* ---- address bar ---- */
  useEffect(() => {
    if (!editing) setAddress(active?.newtab ? "" : (active?.url ?? ""));
  }, [active?.url, active?.newtab, editing]);

  const go = useCallback(
    async (input: string) => {
      const text = input.trim();
      if (!text) return;
      let id = activeId;
      if (!id) id = await newTab();
      await browserNavigate(id, text);
      setEditing(false);
      setSuggestions([]);
      (document.activeElement as HTMLElement | null)?.blur();
    },
    [activeId, newTab]
  );

  useEffect(() => {
    if (!editing || !address.trim() || address === active?.url) {
      setSuggestions([]);
      return;
    }
    const q = address;
    const t = window.setTimeout(() => {
      void browserSuggest(profileId, q).then((s) => {
        setSuggestions(s);
        setSuggestIdx(-1);
      });
    }, 110);
    return () => window.clearTimeout(t);
  }, [address, editing, profileId, active?.url]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void go(suggestIdx >= 0 && suggestions[suggestIdx] ? suggestions[suggestIdx].url : address);
  }

  /* ---- bookmarks ---- */
  useEffect(() => {
    void browserBookmarks(profileId).then(setBookmarks);
  }, [profileId, bmVersion]);
  useEffect(() => {
    if (!active?.url || active.newtab) return setBookmarked(false);
    void browserIsBookmarked(profileId, active.url).then(setBookmarked);
  }, [profileId, active?.url, active?.newtab, bmVersion]);
  const toggleBookmark = useCallback(
    async (tabId?: string) => {
      const t = tabId ? useBrowserStore.getState().tabs.find((x) => x.id === tabId) : active;
      if (!t || t.newtab || !t.url) return;
      const now = await browserBookmarkToggle(profileId, t.url, t.title);
      if (!tabId || tabId === activeId) setBookmarked(now);
      setBmVersion((v) => v + 1);
      flash(now ? "Bookmarked" : "Bookmark removed");
    },
    [active, activeId, profileId, flash]
  );

  /* ---- find in page ---- */
  const runFind = useCallback(
    (text: string, forward = true, cs = findCase) => {
      if (!activeId || !text) return void setFindInfo(null);
      void browserFind(activeId, text, forward, cs);
    },
    [activeId, findCase]
  );
  useEffect(() => onFindResult((r) => r.tab === activeId && setFindInfo({ ok: r.ok, count: r.count })), [activeId]);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindInfo(null);
    if (activeId) void browserFindClear(activeId).catch(() => {});
  }, [activeId]);

  /* ---- shortcuts (from the page agent AND from this window) ---- */
  const actions = useRef<(key: string, tabId?: string) => boolean>(() => false);
  actions.current = (key: string, tabId?: string) => {
    const mine = useBrowserStore.getState().tabs.filter((t) => t.profile === profileId);
    // shortcuts pressed inside a page act on THAT page's tab
    if (tabId && tabId !== activeId && mine.some((t) => t.id === tabId)) setActive(tabId);
    const target = tabId && mine.some((t) => t.id === tabId) ? tabId : activeId;
    const idx = mine.findIndex((t) => t.id === target);
    switch (key) {
      case "Ctrl+T":
        void newTab();
        return true;
      case "Ctrl+Shift+N":
        void newTab("", true);
        return true;
      case "Ctrl+N":
        void newTab();
        return true;
      case "Ctrl+W":
        if (target) void closeTab(target);
        return true;
      case "Ctrl+Shift+T":
        void browserReopen(profileId).then((id) => setActive(id)).catch(() => flash("No closed tab to reopen"));
        return true;
      case "Ctrl+L":
        addressRef.current?.focus();
        addressRef.current?.select();
        return true;
      case "Ctrl+F":
        setFindOpen(true);
        window.setTimeout(() => document.getElementById("qg-find-input")?.focus(), 30);
        return true;
      case "Ctrl+D":
        void toggleBookmark(target ?? undefined);
        return true;
      case "Ctrl+H":
        setPanel((p) => (p === "history" ? null : "history"));
        return true;
      case "Ctrl+J":
        setMainView("downloads");
        return true;
      case "Ctrl+Tab":
      case "Ctrl+Shift+Tab":
        if (mine.length > 1) setActive(mine[(idx + (key === "Ctrl+Tab" ? 1 : mine.length - 1)) % mine.length].id);
        return true;
      case "Alt+Home":
        void go("https://duckduckgo.com/");
        return true;
      case "Escape":
        if (findOpen) closeFind();
        return false;
    }
    const m = /^Ctrl\+([1-9])$/.exec(key);
    if (m && mine.length) {
      setActive(m[1] === "9" ? mine[mine.length - 1].id : (mine[Number(m[1]) - 1] ?? mine[mine.length - 1]).id);
      return true;
    }
    return false;
  };
  useEffect(() => onBrowserShortcut((key, tab) => void actions.current(key, tab)), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (activeId && matchCombo(e, cfg.popupKey)) {
        e.preventDefault();
        void browserPopup(activeId, "toggle");
        return;
      }
      const name = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const combo = (e.ctrlKey ? "Ctrl+" : "") + ((e.shiftKey && name.length > 1) || (e.shiftKey && e.ctrlKey) ? "Shift+" : "") + (e.altKey ? "Alt+" : "") + name;
      if (combo === "F5" || combo === "Ctrl+R") {
        e.preventDefault();
        if (activeId) void browserAction(activeId, "reload");
      } else if (combo === "Ctrl+Shift+R") {
        e.preventDefault();
        if (activeId) void browserAction(activeId, "hard-reload");
      } else if (combo === "F12" && activeId) void browserDevtools(activeId);
      else if (combo === "Alt+ArrowLeft" && activeId) void browserAction(activeId, "back");
      else if (combo === "Alt+ArrowRight" && activeId) void browserAction(activeId, "forward");
      else if (actions.current(combo)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, cfg.popupKey]);

  /* ---- tab strip drag & drop ---- */
  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragId || dragId === targetId) return setDragId(null);
    const ids = tabs.map((t) => t.id).filter((i) => i !== dragId);
    const at = ids.indexOf(targetId);
    const dragged = tabs.find((t) => t.id === dragId);
    const target = tabs.find((t) => t.id === targetId);
    if (dragged && target && dragged.pinned === target.pinned) {
      ids.splice(at, 0, dragId);
      void browserReorder(ids);
    }
    setDragId(null);
  }

  const zoomPct = Math.round((active?.zoom ?? 1) * 100);
  const secure = /^https:/i.test(active?.url ?? "");
  const ctxTab = ctx ? tabs.find((t) => t.id === ctx.id) : null;

  const openPanel = (p: PanelKind) => setPanel((cur) => (cur === p ? null : p));
  const menuItem = (label: string, run: () => void, hint?: string, danger?: boolean) => (
    <button
      key={label}
      onClick={() => {
        setMenuOpen(false);
        run();
      }}
      className={`flex w-full items-center justify-between gap-6 rounded-[8px] px-3 py-1.5 text-left text-[12.5px] hover:bg-white/10 ${danger ? "text-red-300" : "text-text-primary"}`}
    >
      <span>{label}</span>
      {hint && <span className="text-[10.5px] text-text-tertiary">{hint}</span>}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Tabs */}
      <div className="glass flex h-10 shrink-0 items-end gap-0.5 border-b border-hairline px-2 pt-1.5" onDoubleClick={(e) => e.target === e.currentTarget && void newTab()}>
        {tabs.map((t) => (
          <div
            key={t.id}
            draggable
            onDragStart={() => setDragId(t.id)}
            onDragOver={(e) => dragId && e.preventDefault()}
            onDrop={(e) => onDrop(e, t.id)}
            onDragEnd={() => setDragId(null)}
            onClick={() => setActive(t.id)}
            onAuxClick={(e) => e.button === 1 && void closeTab(t.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, id: t.id });
            }}
            title={tabTitle(t)}
            className={`group flex h-8 cursor-default items-center gap-2 rounded-t-[10px] px-2.5 text-[12px] transition-colors ${
              t.pinned ? "w-[44px] shrink-0 justify-center px-0" : "min-w-[100px] max-w-[220px] flex-1"
            } ${t.id === activeId ? "bg-white/12 text-text-primary" : "text-text-secondary hover:bg-white/6"} ${dragId === t.id ? "opacity-40" : ""}`}
          >
            {t.loading ? (
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-white/25 border-t-white/80" />
            ) : t.private ? (
              <span className="shrink-0 text-[12px]" title="Private tab">
                🕶
              </span>
            ) : t.newtab ? (
              <span className="h-2 w-2 shrink-0 rounded-full bg-accent/70" />
            ) : (
              <Favicon url={t.url} icon={t.favicon} size={14} />
            )}
            {!t.pinned && <span className="min-w-0 flex-1 truncate">{tabTitle(t)}</span>}
            {t.audible && !t.pinned && <span className="shrink-0 text-[11px] text-accent">🔊</span>}
            {!t.pinned && (
              <button
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(t.id);
                }}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-text-tertiary opacity-0 transition-opacity hover:bg-white/15 hover:text-text-primary group-hover:opacity-100"
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          aria-label="New tab"
          title="New tab (Ctrl+T)"
          onClick={() => void newTab()}
          className="mb-0.5 ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[16px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
        >
          +
        </button>
      </div>

      {/* Toolbar */}
      <div className="glass relative flex h-12 shrink-0 items-center gap-1 border-b border-hairline px-2.5">
        <button
          onClick={() => setProfile(null)}
          title={profile ? `Profile: ${profile.name}. Click to switch profile` : "Profiles"}
          className="mr-0.5 shrink-0 rounded-full transition-transform hover:scale-105"
        >
          <Avatar profile={profile ?? { name: profileId, color: "#6673e0" }} size={28} />
        </button>
        <NavButton label="Back (Alt+←)" disabled={!active?.canBack} onClick={() => activeId && void browserAction(activeId, "back")}>
          {ico("M15 5l-7 7 7 7")}
        </NavButton>
        <NavButton label="Forward (Alt+→)" disabled={!active?.canForward} onClick={() => activeId && void browserAction(activeId, "forward")}>
          {ico("M9 5l7 7-7 7")}
        </NavButton>
        <NavButton label={active?.loading ? "Stop" : "Reload (F5)"} onClick={() => activeId && void browserAction(activeId, active?.loading ? "stop" : "reload")}>
          {active?.loading ? ico("M6 6l12 12M18 6L6 18") : ico("M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5")}
        </NavButton>
        <NavButton label="Home" onClick={() => void go("https://duckduckgo.com/")}>
          {ico("M4 11l8-7 8 7M6 10v9h4v-5h4v5h4v-9")}
        </NavButton>

        <form onSubmit={submit} className="relative mx-1 flex min-w-0 flex-1 items-center rounded-full bg-card/80 px-3 ring-1 ring-hairline focus-within:ring-accent">
          <span className={`mr-2 text-[11px] ${secure ? "text-emerald-400" : "text-amber-400"}`} title={secure ? "Secure connection. Ads and trackers are blocked by uBlock Origin" : "Not secure"}>
            {secure ? "🔒" : active?.newtab ? "🛡" : "⚠"}
          </span>
          <input
            ref={addressRef}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => window.setTimeout(() => setEditing(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && suggestions.length) {
                e.preventDefault();
                setSuggestIdx((i) => (i + 1) % suggestions.length);
              } else if (e.key === "ArrowUp" && suggestions.length) {
                e.preventDefault();
                setSuggestIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
              } else if (e.key === "Escape") {
                setSuggestions([]);
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            placeholder="Search or type a link"
            aria-label="Address"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          {zoomPct !== 100 && (
            <button type="button" onClick={() => activeId && void browserZoom(activeId, "reset")} title="Zoom: click to reset" className="ml-1 rounded-full bg-white/10 px-2 py-0.5 text-[10.5px] text-text-secondary hover:bg-white/15">
              {zoomPct}%
            </button>
          )}
          <button
            type="button"
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page (Ctrl+D)"}
            title={bookmarked ? "Remove bookmark" : "Bookmark this page (Ctrl+D)"}
            disabled={!active || active.newtab}
            onClick={() => void toggleBookmark()}
            className={`ml-1 flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-white/10 disabled:opacity-30 ${bookmarked ? "text-amber-300" : "text-text-secondary"}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill={bookmarked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
            </svg>
          </button>
          {editing && suggestions.length > 0 && (
            <Portal>
              <div
                className="fixed z-[80] overflow-hidden rounded-[14px] border border-hairline bg-[#16161e]/95 p-1.5 shadow-2xl backdrop-blur-xl"
                style={{
                  left: addressRef.current?.parentElement?.getBoundingClientRect().left ?? 0,
                  top: (addressRef.current?.parentElement?.getBoundingClientRect().bottom ?? 0) + 6,
                  width: addressRef.current?.parentElement?.getBoundingClientRect().width ?? 400,
                }}
              >
                {suggestions.map((s, i) => (
                  <button
                    key={s.url}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void go(s.url);
                    }}
                    onMouseEnter={() => setSuggestIdx(i)}
                    className={`flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2 text-left ${i === suggestIdx ? "bg-white/12" : "hover:bg-white/8"}`}
                  >
                    <span className={`shrink-0 text-[11px] ${s.kind === "bookmark" ? "text-amber-300" : "text-text-tertiary"}`}>{s.kind === "bookmark" ? "★" : "🕘"}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-text-primary">{s.title || s.url}</span>
                      <span className="block truncate text-[10.5px] text-text-tertiary">{s.url}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Portal>
          )}
        </form>

        <button
          onClick={() => openPanel("media")}
          className={`relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium transition-colors ${
            panel === "media" ? "bg-accent text-white" : "bg-card/80 text-text-secondary hover:bg-card-hover hover:text-text-primary"
          } ${mediaCount > 0 && panel !== "media" ? "ring-2 ring-accent/70" : ""}`}
          title="Media found on this page"
        >
          {ico("M12 4v11M7 11l5 5 5-5M5 20h14", 15)}
          Media
          {mediaCount > 0 && <span className="rounded-full bg-white/25 px-1.5 text-[11px] tabular-nums">{mediaCount}</span>}
        </button>
        <NavButton label="Extensions" active={panel === "extensions"} onClick={() => openPanel("extensions")}>
          {ico("M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z", 16)}
        </NavButton>
        <NavButton label="Menu" active={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
          {ico("M12 5v.01M12 12v.01M12 19v.01", 18)}
        </NavButton>
        {notice && <div className="pointer-events-none absolute right-16 top-full z-10 mt-1 rounded-full bg-black/70 px-3 py-1 text-[11.5px] text-white">{notice}</div>}
        {active?.loading && <div className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-gradient-to-r from-transparent via-accent to-transparent" />}
      </div>

      {/* Bookmarks bar */}
      {settings.bookmarksBar && bookmarks.length > 0 && (
        <div className="glass flex h-8 shrink-0 items-center gap-1 overflow-hidden border-b border-hairline px-2.5">
          {bookmarks.slice(0, 14).map((b) => (
            <button
              key={b.id}
              onClick={() => void go(b.url)}
              title={b.url}
              className="flex max-w-[170px] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
            >
              <Favicon url={b.url} size={13} />
              <span className="truncate">{b.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Find in page */}
      {findOpen && (
        <div className="glass flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <input
            id="qg-find-input"
            value={findText}
            onChange={(e) => {
              setFindText(e.target.value);
              runFind(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runFind(findText, !e.shiftKey);
              else if (e.key === "Escape") closeFind();
            }}
            placeholder="Find on page"
            className="h-8 w-64 rounded-full bg-card/80 px-4 text-[12.5px] text-text-primary outline-none ring-1 ring-hairline focus:ring-accent"
          />
          <span className={`min-w-[70px] text-[11.5px] ${findInfo && findInfo.count === 0 && findText ? "text-red-300" : "text-text-tertiary"}`}>
            {findInfo ? (findInfo.count ? `${findInfo.count} match${findInfo.count > 1 ? "es" : ""}` : "No matches") : ""}
          </span>
          <NavButton label="Previous (Shift+Enter)" onClick={() => runFind(findText, false)}>
            {ico("M6 15l6-6 6 6")}
          </NavButton>
          <NavButton label="Next (Enter)" onClick={() => runFind(findText, true)}>
            {ico("M6 9l6 6 6-6")}
          </NavButton>
          <label className="flex items-center gap-1.5 text-[11.5px] text-text-secondary">
            <input
              type="checkbox"
              checked={findCase}
              onChange={(e) => {
                setFindCase(e.target.checked);
                runFind(findText, true, e.target.checked);
              }}
            />
            Match case
          </label>
          <span className="flex-1" />
          <NavButton label="Close (Esc)" onClick={closeFind}>
            {ico("M6 6l12 12M18 6L6 18")}
          </NavButton>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* The native web page lives here */}
        <div ref={stageRef} className="relative min-w-0 flex-1 bg-black/20">
          {active?.newtab && (
            <NewTabPage profile={profileId} profileName={profile?.name ?? "Browser"} onGo={(v) => void go(v)} />
          )}
        </div>

        {panel && (
          <aside className="glass flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-hairline p-3">
            <div className="flex items-center gap-1 rounded-full bg-black/20 p-1 text-[11.5px]">
              {(
                [
                  ["media", "Media"],
                  ["bookmarks", "Bookmarks"],
                  ["history", "History"],
                  ["extensions", "Extensions"],
                  ["settings", "Settings"],
                ] as [PanelKind, string][]
              ).map(([k, label]) => (
                <button key={k} onClick={() => setPanel(k)} className={`flex-1 rounded-full px-2 py-1 transition-colors ${panel === k ? "bg-accent text-white" : "text-text-secondary hover:bg-white/10"}`}>
                  {label}
                </button>
              ))}
              <button onClick={() => setPanel(null)} aria-label="Close panel" className="rounded-full px-2 py-1 text-text-tertiary hover:bg-white/10 hover:text-text-primary">
                ×
              </button>
            </div>
            {panel === "media" && activeId && <MediaPanel tab={activeId} pageUrl={active?.newtab ? "" : (active?.url ?? "")} pageTitle={active?.title ?? ""} items={items} />}
            {panel === "bookmarks" && <BookmarksPanel profile={profileId} tab={activeId} version={bmVersion} />}
            {panel === "history" && <HistoryPanel profile={profileId} tab={activeId} />}
            {panel === "extensions" && <ExtensionsPanel profile={profileId} />}
            {panel === "settings" && <BrowserSettingsPanel profile={profile?.name ?? profileId} />}
          </aside>
        )}
      </div>

      {/* Tab context menu */}
      {ctx && ctxTab && (
        <Portal>
          <div className="fixed inset-0 z-[85]" onClick={() => setCtx(null)} onContextMenu={(e) => (e.preventDefault(), setCtx(null))}>
            <div
              className="absolute min-w-[210px] rounded-[12px] border border-hairline bg-[#16161e]/97 p-1.5 shadow-2xl backdrop-blur-xl"
              style={{ left: Math.min(ctx.x, window.innerWidth - 230), top: ctx.y + 4 }}
              onClick={(e) => e.stopPropagation()}
            >
              {[
                ["Reload", () => void browserAction(ctxTab.id, "reload"), !ctxTab.live],
                ["Duplicate", () => void browserDuplicate(ctxTab.id).then(setActive), false],
                [ctxTab.pinned ? "Unpin tab" : "Pin tab", () => void browserPin(ctxTab.id, !ctxTab.pinned), false],
                ["Bookmark this tab", () => void browserBookmarkToggle(profileId, ctxTab.url, ctxTab.title).then(() => setBmVersion((v) => v + 1)), ctxTab.newtab],
                ["Close tab", () => void closeTab(ctxTab.id), false],
                [
                  "Close other tabs",
                  () =>
                    void (async () => {
                      for (const t of tabs.filter((x) => x.id !== ctxTab.id && !x.pinned)) await browserClose(t.id);
                      setActive(ctxTab.id);
                    })(),
                  tabs.length < 2,
                ],
                [
                  "Close tabs to the right",
                  () =>
                    void (async () => {
                      const i = tabs.findIndex((x) => x.id === ctxTab.id);
                      for (const t of tabs.slice(i + 1).filter((x) => !x.pinned)) await browserClose(t.id);
                    })(),
                  tabs.findIndex((x) => x.id === ctxTab.id) >= tabs.length - 1,
                ],
              ].map(([label, run, disabled]) => (
                <button
                  key={label as string}
                  disabled={disabled as boolean}
                  onClick={() => {
                    setCtx(null);
                    (run as () => void)();
                  }}
                  className="flex w-full rounded-[8px] px-3 py-1.5 text-left text-[12.5px] text-text-primary hover:bg-white/10 disabled:opacity-35"
                >
                  {label as string}
                </button>
              ))}
            </div>
          </div>
        </Portal>
      )}

      {/* ⋮ menu */}
      {menuOpen && (
        <Portal>
          <div className="fixed inset-0 z-[85]" onClick={() => setMenuOpen(false)}>
            <div className="absolute right-3 top-[92px] w-[280px] rounded-[14px] border border-hairline bg-[#16161e]/97 p-1.5 shadow-2xl backdrop-blur-xl" onClick={(e) => e.stopPropagation()}>
              {menuItem("New tab", () => void newTab(), "Ctrl+T")}
              {menuItem("New private tab", () => void newTab("", true), "Ctrl+Shift+N")}
              {menuItem("Reopen closed tab", () => void browserReopen(profileId).then(setActive).catch(() => flash("No closed tab to reopen")), "Ctrl+Shift+T")}
              <div className="my-1 h-px bg-white/10" />
              {menuItem("Bookmarks", () => setPanel("bookmarks"))}
              {menuItem("History", () => setPanel("history"), "Ctrl+H")}
              {menuItem("Extensions", () => setPanel("extensions"))}
              {menuItem("Downloads", () => setMainView("downloads"), "Ctrl+J")}
              <div className="my-1 h-px bg-white/10" />
              <div className="flex items-center justify-between rounded-[8px] px-3 py-1.5 text-[12.5px] text-text-primary">
                <span>Zoom</span>
                <span className="flex items-center gap-1">
                  <button onClick={() => activeId && void browserZoom(activeId, "out")} className="h-6 w-6 rounded-full bg-white/10 hover:bg-white/20">
                    −
                  </button>
                  <button onClick={() => activeId && void browserZoom(activeId, "reset")} className="min-w-[46px] rounded-full bg-white/10 px-2 py-0.5 text-[11.5px] hover:bg-white/20">
                    {zoomPct}%
                  </button>
                  <button onClick={() => activeId && void browserZoom(activeId, "in")} className="h-6 w-6 rounded-full bg-white/10 hover:bg-white/20">
                    +
                  </button>
                </span>
              </div>
              {menuItem("Find on page", () => actions.current("Ctrl+F"), "Ctrl+F")}
              {menuItem("Print", () => activeId && void browserPrint(activeId).catch(() => flash("Nothing to print")), "Ctrl+P")}
              {menuItem("Developer tools", () => activeId && void browserDevtools(activeId).catch(() => {}), "F12")}
              <div className="my-1 h-px bg-white/10" />
              {menuItem("Clear browsing data…", () => void browserProfileClear(profileId).then(() => flash("Cookies, cache and history cleared")).catch((e) => flash(String(e))), undefined, true)}
              {menuItem("Browser settings", () => setPanel("settings"))}
              {menuItem("Switch profile", () => setProfile(null))}
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}
