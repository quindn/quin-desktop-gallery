import { useEffect, useMemo, useState } from "react";
import {
  browserBookmarkRemove,
  browserBookmarks,
  browserClearSniffed,
  browserHistory,
  browserHistoryClear,
  browserExtensionInstall,
  browserExtensionInstallFolder,
  browserExtensionRemove,
  browserExtensions,
  browserExtensionToggle,
  browserHistoryRemove,
  browserNavigate,
  browserReloadEngines,
  type Extension,
  type Bookmark,
  type HistoryEntry,
  type MediaGroup,
  type MediaItem,
  type MediaMode,
} from "../lib/online";
import { formatBytes } from "../lib/format";
import { useGalleryStore } from "../stores/galleryStore";
import { runDownloadAll, runMediaAction, useBrowserSettings, useDownloadStore, useHandoffStore, useMediaCfg } from "../stores/webStores";

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function fmtDur(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const x = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
}

/** "Ctrl+Shift+V" against a keyboard event. */
export function matchCombo(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split("+");
  const key = (parts.pop() ?? "").toLowerCase();
  return (
    e.key.toLowerCase() === key && e.altKey === parts.includes("Alt") && e.ctrlKey === parts.includes("Ctrl") && e.shiftKey === parts.includes("Shift") && !e.metaKey
  );
}

const GROUPS: { id: MediaGroup; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "other", label: "Other" },
];

const MODES: { id: MediaMode; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Gestures and shortcuts work, and step aside when the site already handles them" },
  { id: "gestures", label: "Always", hint: "Double-click the sides to seek, hold to speed up: overrides the site's own gestures" },
  { id: "site", label: "Site only", hint: "Leave the player alone (the media list still works)" },
  { id: "off", label: "Off", hint: "Do not look at this site's players at all" },
];

/* ------------------------------------------------------------------ media list --- */
function MediaRow({ tab, item, selected, onSelect }: { tab: string; item: MediaItem; selected: boolean; onSelect: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [quality, setQuality] = useState(0);
  const act = async (op: string) => setNote(await runMediaAction(tab, op, item, { quality: quality || null }));
  return (
    <div onClick={onSelect} className={`flex flex-col gap-2 rounded-card p-2.5 transition-colors ${selected ? "bg-accent/15 ring-1 ring-accent/60" : "bg-card/70 hover:bg-card/90"}`}>
      <div className="flex gap-2.5">
        <div className="relative h-[63px] w-[112px] shrink-0 overflow-hidden rounded-[8px] bg-black/50">
          {item.thumb ? (
            <img src={`data:image/jpeg;base64,${item.thumb}`} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-white/5 to-white/15 text-[18px] text-white/50">▶</div>
          )}
          {(item.live || item.duration) && (
            <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10.5px] font-semibold tabular-nums text-white">{item.live ? "LIVE" : fmtDur(item.duration)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 break-words text-[12.5px] leading-snug text-text-primary" title={item.url ?? item.title}>
            {item.title || item.url}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <span className="rounded bg-accent/25 px-1.5 py-px text-[10px] font-bold tracking-wide text-accent">{item.format}</span>
            {item.height ? <span className="rounded bg-white/10 px-1.5 py-px text-[10px] text-text-secondary">{item.height}p</span> : null}
            {item.size ? <span className="rounded bg-white/10 px-1.5 py-px text-[10px] tabular-nums text-text-secondary">{formatBytes(item.size)}</span> : null}
            {item.protected && (
              <span className="rounded bg-amber-500/20 px-1.5 py-px text-[10px] font-semibold text-amber-400" title="Protected (DRM): only the site's own player can play it">
                DRM{item.protected !== "DRM" ? ` · ${item.protected}` : ""}
              </span>
            )}
            {item.aes && <span className="rounded bg-white/10 px-1.5 py-px text-[10px] text-text-secondary">AES</span>}
            {item.viaPage && <span className="rounded bg-white/10 px-1.5 py-px text-[10px] text-text-secondary">page player</span>}
            {item.active && <span className="rounded bg-emerald-500/20 px-1.5 py-px text-[10px] text-emerald-400">playing here</span>}
          </div>
        </div>
      </div>
      {item.note && item.group !== "video" && <div className="text-[10.5px] leading-snug text-text-tertiary">{item.note}</div>}
      {item.protected && item.note && <div className="text-[10.5px] leading-snug text-amber-400/90">{item.note}</div>}
      <div className="flex gap-1.5">
        {item.variants.length > 0 && item.canDownload && (
          <select
            value={quality}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setQuality(Number(e.target.value))}
            className="rounded-control bg-card px-1.5 py-1 text-[11.5px] text-text-primary outline-none ring-1 ring-hairline"
            title="Quality"
          >
            <option value={0}>Best</option>
            {item.variants.map((v) => (
              <option key={v.height} value={v.height}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        <button
          disabled={!item.canPlay}
          onClick={(e) => {
            e.stopPropagation();
            void act("play");
          }}
          className="flex-1 rounded-control bg-white/10 px-2 py-1.5 text-[11.5px] text-text-primary transition-colors hover:bg-white/15 disabled:opacity-35"
        >
          ▶ Play
        </button>
        <button
          disabled={!item.canDownload}
          title={item.canDownload ? "Download" : (item.note ?? "Cannot be downloaded")}
          onClick={(e) => {
            e.stopPropagation();
            void act("download");
          }}
          className="flex-1 rounded-control bg-accent px-2 py-1.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35"
        >
          ⬇ Download
        </button>
        {item.url && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void act("copy");
            }}
            className="rounded-control bg-white/10 px-2.5 py-1.5 text-[11.5px] text-text-secondary transition-colors hover:bg-white/15 hover:text-text-primary"
            title="Copy link"
          >
            ⧉
          </button>
        )}
      </div>
      {note && <div className="text-[11px] text-emerald-400">{note}</div>}
    </div>
  );
}

/** Press the keys you want: the old shortcut is replaced. */
export function ShortcutRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRec(false);
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const mods = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt"].filter(Boolean) as string[];
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const fKey = /^F([1-9]|1[0-2])$/.test(key);
      if (!(fKey || (mods.length > 0 && /^[A-Z0-9]$/.test(key)))) return;
      onChange([...mods, key].join("+"));
      setRec(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rec, onChange]);
  return (
    <button
      onClick={() => setRec((r) => !r)}
      className={`min-w-[120px] rounded-control px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${rec ? "animate-pulse bg-accent text-white" : "bg-card text-text-primary ring-1 ring-hairline hover:bg-card-hover"}`}
      title="Click, then press the new shortcut (Esc to cancel)"
    >
      {rec ? "Press keys…" : value}
    </button>
  );
}

function PlayerSettings({ host }: { host: string }) {
  const cfg = useMediaCfg((s) => s.cfg);
  const patch = useMediaCfg((s) => s.patch);
  const setSiteMode = useMediaCfg((s) => s.setSiteMode);
  const siteMode = host ? cfg.origins[host] : undefined;
  const effective = siteMode ?? cfg.mode;
  const sel = "rounded-control bg-card px-2 py-1 text-[11.5px] text-text-primary outline-none ring-1 ring-hairline focus:ring-accent";
  return (
    <details className="rounded-card border border-white/10 bg-white/5 px-3 py-2 text-[11.5px] text-text-secondary">
      <summary className="cursor-pointer select-none text-[12px] font-medium text-text-primary">Player and popup settings</summary>
      <div className="mt-2.5 flex flex-col gap-2.5">
        <div>
          <div className="mb-1 text-text-tertiary">{host ? `Gestures on ${host}` : "Gestures on this site"}</div>
          <div className="flex gap-1">
            {MODES.map((m) => (
              <button
                key={m.id}
                title={m.hint}
                onClick={() => host && setSiteMode(host, m.id === cfg.mode ? null : m.id)}
                className={`flex-1 rounded-control px-1.5 py-1 transition-colors ${effective === m.id ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover"}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="mt-1 leading-snug text-text-tertiary">{MODES.find((m) => m.id === effective)?.hint}</div>
        </div>
        <label className="flex items-center justify-between gap-2">
          Shortcut: open / close the popup
          <ShortcutRecorder value={cfg.popupKey} onChange={(v) => patch({ popupKey: v })} />
        </label>
        <label className="flex items-center justify-between gap-2">
          Default for other sites
          <select className={sel} value={cfg.mode} onChange={(e) => patch({ mode: e.target.value as MediaMode })}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Double-click / J L skip
          <select className={sel} value={cfg.seek} onChange={(e) => patch({ seek: Number(e.target.value) })}>
            {[5, 10, 15, 30].map((n) => (
              <option key={n} value={n}>
                {n} s
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Popup badge corner
          <select className={sel} value={cfg.corner} onChange={(e) => patch({ corner: e.target.value as typeof cfg.corner })}>
            <option value="br">Bottom right</option>
            <option value="bl">Bottom left</option>
            <option value="tr">Top right</option>
            <option value="tl">Top left</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          Show the badge on pages
          <input type="checkbox" checked={cfg.badge} onChange={(e) => patch({ badge: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-2" title="The Quin Player / Download buttons that float under a video">
          Floating buttons under videos
          <input type="checkbox" checked={cfg.fab} onChange={(e) => patch({ fab: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-2">
          Hold to play at 2×
          <input type="checkbox" checked={cfg.longPress} onChange={(e) => patch({ longPress: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between gap-2" title="Lets the browser fetch ahead for the video you are watching (never for streams or off-screen videos)">
          Preload the video being watched
          <input type="checkbox" checked={cfg.preload} onChange={(e) => patch({ preload: e.target.checked })} />
        </label>
        <div className="leading-relaxed text-text-tertiary">
          Hover a video: <b className="text-text-secondary">Quin Player</b> applies our player onto it, <b className="text-text-secondary">Download</b> saves it. Gestures: double-click the sides to skip, J / L ±{cfg.seek} s, K pause, M mute,
          ← → ±5 s, Alt + wheel volume, Shift + wheel seek.
        </div>
      </div>
    </details>
  );
}

export function MediaPanel({ tab, pageUrl, pageTitle, items }: { tab: string; pageUrl: string; pageTitle: string; items: MediaItem[] }) {
  const play = useHandoffStore((s) => s.play);
  const setMainView = useGalleryStore((s) => s.setMainView);
  const startDownload = useDownloadStore((s) => s.start);
  const [group, setGroup] = useState<MediaGroup>("video");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageNote, setPageNote] = useState<string | null>(null);
  const counts = { video: 0, audio: 0, other: 0 };
  items.forEach((i) => counts[i.group]++);
  const shown = items.filter((i) => i.group === group);
  const downloadable = shown.filter((i) => i.canDownload && !i.protected && !i.live);
  const canUsePage = /^https?:/i.test(pageUrl);
  useEffect(() => setPageNote(null), [tab, pageUrl]);

  return (
    <>
      <div className="flex items-center justify-between px-1">
        <div className="text-[13px] font-semibold text-text-primary">Media on this page</div>
        {items.length > 0 && (
          <button onClick={() => void browserClearSniffed(tab)} className="text-[11px] text-text-tertiary hover:text-text-primary">
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 rounded-card border border-white/10 bg-white/5 p-3">
        <div className="text-[12px] font-medium text-text-primary">This page</div>
        <div className="text-[11px] leading-relaxed text-text-tertiary">For sites like YouTube, TikTok, Facebook, X: let the video engine extract the best quality.</div>
        <div className="flex gap-1.5">
          <button
            disabled={!canUsePage}
            onClick={() => {
              play(pageUrl, null, pageTitle);
              setMainView("online");
            }}
            className="flex-1 rounded-control bg-white/10 px-2 py-1.5 text-[11.5px] text-text-primary transition-colors hover:bg-white/15 disabled:opacity-40"
          >
            ▶ Play page
          </button>
          <button
            disabled={!canUsePage}
            onClick={async () => {
              try {
                await startDownload({ url: pageUrl, title: pageTitle });
                setPageNote("Download started");
              } catch (e) {
                setPageNote(String(e));
              }
            }}
            className="flex-1 rounded-control bg-accent px-2 py-1.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            ⬇ Download page
          </button>
        </div>
        {pageNote && <div className="text-[11px] text-emerald-400">{pageNote}</div>}
      </div>

      <PlayerSettings host={hostOf(pageUrl)} />

      <div className="flex items-center gap-1 px-0.5">
        {GROUPS.map((g) => (
          <button
            key={g.id}
            onClick={() => setGroup(g.id)}
            className={`rounded-full px-3 py-1 text-[11.5px] transition-colors ${group === g.id ? "bg-accent/30 text-text-primary" : "text-text-secondary hover:bg-white/8"}`}
          >
            {g.label} <span className="tabular-nums opacity-70">{counts[g.id]}</span>
          </button>
        ))}
        {group !== "other" && (
          <button
            disabled={downloadable.length === 0}
            onClick={() => void runDownloadAll(tab, downloadable)}
            className="ml-auto rounded-control bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-35"
            title="Download everything in this list (protected and live items are skipped), three at a time"
          >
            ⬇ All{downloadable.length ? ` (${downloadable.length})` : ""}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="px-1 text-[12px] leading-relaxed text-text-tertiary">
          {group === "other"
            ? "Nothing here. Tiny clips, streaming renditions and pieces are listed in this tab."
            : `No ${group} found yet. Start a video on the page: everything it loads shows up here, ready to play or download.`}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((m) => (
            <MediaRow key={m.id} tab={tab} item={m} selected={m.id === selectedId} onSelect={() => setSelectedId(m.id)} />
          ))}
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------- bookmarks, history --- */
function Favicon({ url, icon, size = 16 }: { url: string; icon?: string; size?: number }) {
  const [bad, setBad] = useState(false);
  const src = useMemo(() => {
    if (icon && /^https?:/i.test(icon)) return icon;
    try {
      return `${new URL(url).origin}/favicon.ico`;
    } catch {
      return "";
    }
  }, [url, icon]);
  useEffect(() => setBad(false), [src]);
  if (!src || bad) {
    return (
      <span className="flex shrink-0 items-center justify-center rounded bg-white/10 text-[9px] text-text-secondary" style={{ width: size, height: size }}>
        {(hostOf(url)[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt="" width={size} height={size} onError={() => setBad(true)} className="shrink-0 rounded" style={{ width: size, height: size }} />;
}
export { Favicon };

export function BookmarksPanel({ profile, tab, version }: { profile: string; tab: string | null; version: number }) {
  const [list, setList] = useState<Bookmark[]>([]);
  const [q, setQ] = useState("");
  const reload = () => browserBookmarks(profile).then(setList);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, version]);
  const shown = list.filter((b) => !q || (b.title + b.url).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="px-1 text-[13px] font-semibold text-text-primary">Bookmarks</div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search bookmarks"
        className="rounded-control bg-card px-3 py-1.5 text-[12px] text-text-primary outline-none ring-1 ring-hairline placeholder:text-text-tertiary focus:ring-accent"
      />
      {shown.length === 0 && <div className="px-1 text-[12px] text-text-tertiary">{list.length ? "No match." : "Nothing bookmarked yet. Press Ctrl+D (or the star) on a page."}</div>}
      <div className="flex flex-col gap-1">
        {shown.map((b) => (
          <div key={b.id} className="group flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-white/8">
            <Favicon url={b.url} />
            <button onClick={() => tab && void browserNavigate(tab, b.url)} className="min-w-0 flex-1 text-left" title={b.url}>
              <div className="truncate text-[12.5px] text-text-primary">{b.title}</div>
              <div className="truncate text-[10.5px] text-text-tertiary">{hostOf(b.url)}</div>
            </button>
            <button
              onClick={async () => {
                await browserBookmarkRemove(profile, b.id);
                await reload();
              }}
              className="rounded px-1.5 text-text-tertiary opacity-0 hover:bg-white/10 hover:text-text-primary group-hover:opacity-100"
              aria-label="Remove bookmark"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

export function HistoryPanel({ profile, tab }: { profile: string; tab: string | null }) {
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [q, setQ] = useState("");
  const reload = (query = q) => browserHistory(profile, query, 400).then(setList);
  useEffect(() => {
    const t = setTimeout(() => void reload(q), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, q]);
  const day = (ms: number) => {
    const d = new Date(ms);
    const today = new Date();
    const y = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString();
  };
  let last = "";
  return (
    <>
      <div className="flex items-center justify-between px-1">
        <div className="text-[13px] font-semibold text-text-primary">History</div>
        {list.length > 0 && (
          <button
            onClick={async () => {
              await browserHistoryClear(profile);
              await reload();
            }}
            className="text-[11px] text-text-tertiary hover:text-text-primary"
          >
            Clear all
          </button>
        )}
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search history"
        className="rounded-control bg-card px-3 py-1.5 text-[12px] text-text-primary outline-none ring-1 ring-hairline placeholder:text-text-tertiary focus:ring-accent"
      />
      {list.length === 0 && <div className="px-1 text-[12px] text-text-tertiary">{q ? "No match." : "Pages you visit show up here (not in private tabs)."}</div>}
      <div className="flex flex-col gap-0.5">
        {list.map((h) => {
          const d = day(h.time);
          const header = d !== last ? d : null;
          last = d;
          return (
            <div key={h.id}>
              {header && <div className="mt-2 px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-text-tertiary">{header}</div>}
              <div className="group flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-white/8">
                <Favicon url={h.url} />
                <button onClick={() => tab && void browserNavigate(tab, h.url)} className="min-w-0 flex-1 text-left" title={h.url}>
                  <div className="truncate text-[12.5px] text-text-primary">{h.title || h.url}</div>
                  <div className="truncate text-[10.5px] text-text-tertiary">
                    {hostOf(h.url)} · {new Date(h.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {h.visits > 1 ? ` · ${h.visits} visits` : ""}
                  </div>
                </button>
                <button
                  onClick={async () => {
                    await browserHistoryRemove(profile, h.id);
                    await reload();
                  }}
                  className="rounded px-1.5 text-text-tertiary opacity-0 hover:bg-white/10 hover:text-text-primary group-hover:opacity-100"
                  aria-label="Remove from history"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

const ENGINES = [
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "google", label: "Google" },
  { id: "bing", label: "Bing" },
  { id: "brave", label: "Brave Search" },
  { id: "ecosia", label: "Ecosia" },
] as const;

export function BrowserSettingsPanel({ profile }: { profile: string }) {
  const settings = useBrowserSettings((s) => s.settings);
  const patch = useBrowserSettings((s) => s.patch);
  return (
    <>
      <div className="px-1 text-[13px] font-semibold text-text-primary">Browser settings</div>
      <label className="flex items-center justify-between gap-2 rounded-card border border-white/10 bg-white/5 px-3 py-2.5 text-[12px] text-text-secondary">
        Search engine
        <select
          value={settings.search}
          onChange={(e) => void patch({ search: e.target.value as (typeof ENGINES)[number]["id"] })}
          className="rounded-control bg-card px-2 py-1 text-[12px] text-text-primary outline-none ring-1 ring-hairline focus:ring-accent"
        >
          {ENGINES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2 rounded-card border border-white/10 bg-white/5 px-3 py-2.5 text-[12px] text-text-secondary">
        Show the bookmarks bar
        <input type="checkbox" checked={settings.bookmarksBar} onChange={(e) => void patch({ bookmarksBar: e.target.checked })} />
      </label>
      <label className="flex items-center justify-between gap-2 rounded-card border border-white/10 bg-white/5 px-3 py-2.5 text-[12px] text-text-secondary">
        Continue where I left off
        <input type="checkbox" checked={settings.restoreTabs} onChange={(e) => void patch({ restoreTabs: e.target.checked })} />
      </label>
      <div className="rounded-card border border-white/10 bg-white/5 px-3 py-2.5 text-[11.5px] leading-relaxed text-text-tertiary">
        Ads and trackers are blocked by uBlock Origin. Passwords and autofill are handled by the browser engine (Microsoft Edge&apos;s Chromium) and stay inside this profile&apos;s
        folder. Profile: <b className="text-text-secondary">{profile}</b>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- extensions --- */
export function ExtensionsPanel({ profile }: { profile: string }) {
  const [list, setList] = useState<Extension[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const reload = () => browserExtensions().then(setList);
  useEffect(() => {
    void reload();
  }, []);

  async function run(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      setNote({ ok: true, text: okText });
      setDirty(true);
      await reload();
    } catch (e) {
      setNote({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }
  const add = () => run(() => browserExtensionInstall(input).then(() => setInput("")), "Extension added");

  return (
    <>
      <div className="px-1 text-[13px] font-semibold text-text-primary">Extensions</div>
      <div className="flex flex-col gap-2 rounded-card border border-white/10 bg-white/5 p-3">
        <div className="text-[12px] font-medium text-text-primary">Add an extension</div>
        <div className="flex gap-1.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && input.trim() && void add()}
            placeholder="Chrome Web Store link or id"
            className="min-w-0 flex-1 rounded-control bg-card px-3 py-1.5 text-[12px] text-text-primary outline-none ring-1 ring-hairline placeholder:text-text-tertiary focus:ring-accent"
          />
          <button
            disabled={busy || !input.trim()}
            onClick={() => void add()}
            className="rounded-control bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "…" : "Add"}
          </button>
        </div>
        <button
          disabled={busy}
          onClick={() => void run(async () => void (await browserExtensionInstallFolder()), "Extension added")}
          className="rounded-control bg-white/10 px-3 py-1.5 text-[12px] text-text-primary transition-colors hover:bg-white/15 disabled:opacity-40"
        >
          Add an unpacked folder…
        </button>
        <div className="text-[10.5px] leading-relaxed text-text-tertiary">
          Paste the address of an extension page on the Chrome Web Store (or just its id). Extensions run inside pages and in the background (ad blockers, dark mode, page tweaks, video tools). The engine has no toolbar,
          so the popup button of an extension is not shown.
        </div>
        {note && <div className={`text-[11.5px] ${note.ok ? "text-emerald-400" : "text-red-300"}`}>{note.text}</div>}
      </div>

      {dirty && (
        <div className="flex items-center gap-2 rounded-card border border-accent/40 bg-accent/10 px-3 py-2 text-[11.5px] text-text-primary">
          <span className="flex-1">Changes apply to pages opened from now on.</span>
          <button
            onClick={() => {
              void browserReloadEngines(profile);
              setDirty(false);
              setNote({ ok: true, text: "Restarting this profile's pages…" });
            }}
            className="rounded-control bg-accent px-2.5 py-1 font-medium text-white hover:opacity-90"
          >
            Apply now
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {list.map((x) => (
          <div key={x.id} data-ext={x.id} className={`flex flex-col gap-2 rounded-card p-3 ${x.enabled ? "bg-card/70" : "bg-card/40 opacity-75"}`}>
            <div className="flex items-start gap-2.5">
              {x.icon ? (
                <img src={x.icon} alt="" className="h-9 w-9 shrink-0 rounded-[8px]" />
              ) : (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-white/10 text-[15px] font-semibold text-text-secondary">{(x.name[0] ?? "?").toUpperCase()}</span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-text-primary" title={x.name}>
                    {x.name}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-text-tertiary">v{x.version}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {x.builtin && <span className="rounded bg-accent/25 px-1.5 py-px text-[10px] font-bold text-accent">BUILT-IN</span>}
                  <span className="rounded bg-white/10 px-1.5 py-px text-[10px] text-text-secondary">{x.source === "store" ? "Chrome Web Store" : x.source === "folder" ? "Unpacked" : "Ad blocker"}</span>
                  <span className="rounded bg-white/10 px-1.5 py-px text-[10px] text-text-secondary">MV{x.manifest}</span>
                </div>
                {x.description && <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-text-tertiary">{x.description}</div>}
              </div>
              <label className="relative mt-0.5 inline-flex shrink-0 cursor-pointer items-center" title={x.enabled ? "Switch off" : "Switch on"}>
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={x.enabled}
                  onChange={(e) => void run(() => browserExtensionToggle(x.id, e.target.checked), e.target.checked ? "Switched on" : "Switched off")}
                />
                <span className="h-5 w-9 rounded-full bg-white/20 transition-colors peer-checked:bg-accent" />
                <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
              </label>
            </div>
            {!x.builtin && (
              <div className="flex justify-end">
                <button onClick={() => void run(() => browserExtensionRemove(x.id), "Extension removed")} className="rounded-control px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/15">
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
