import { useEffect, useState, type FormEvent } from "react";
import { browserBookmarks, browserHistory, type Bookmark, type HistoryEntry } from "../lib/online";
import { Favicon, hostOf } from "./BrowserPanels";

interface Tile {
  url: string;
  title: string;
}

/** The new-tab page: a search box and the places you use most. Nothing is loaded from the web. */
export function NewTabPage({ profile, profileName, onGo }: { profile: string; profileName: string; onGo: (input: string) => void }) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    void browserBookmarks(profile).then(setBookmarks);
    void browserHistory(profile, "", 200).then((h) => setHistory([...h].sort((a, b) => b.visits - a.visits)));
  }, [profile]);

  const tiles: Tile[] = [];
  const seen = new Set<string>();
  const add = (t: Tile) => {
    const k = hostOf(t.url);
    if (!seen.has(k) && tiles.length < 12) {
      seen.add(k);
      tiles.push(t);
    }
  };
  bookmarks.forEach((b) => add({ url: b.url, title: b.title }));
  history.forEach((h) => add({ url: h.url, title: h.title || hostOf(h.url) }));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (q.trim()) onGo(q.trim());
  }

  return (
    <div className="absolute inset-0 overflow-y-auto bg-gradient-to-b from-black/20 to-black/40 px-8 py-14">
      <div className="mx-auto flex max-w-[760px] flex-col items-center gap-8">
        <div className="text-center">
          <div className="text-[13px] uppercase tracking-[0.2em] text-text-tertiary">Quin Gallery</div>
          <div className="mt-1 text-[26px] font-semibold text-text-primary">{profileName}</div>
        </div>
        <form onSubmit={submit} className="flex w-full items-center rounded-full bg-card/85 px-6 shadow-lg ring-1 ring-hairline focus-within:ring-2 focus-within:ring-accent">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mr-3 text-text-tertiary">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the web or type a link"
            aria-label="Search or type a link"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </form>
        {tiles.length > 0 ? (
          <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {tiles.map((t) => (
              <button
                key={t.url}
                onClick={() => onGo(t.url)}
                className="group flex flex-col items-center gap-2 rounded-card bg-card/60 px-3 py-4 text-center transition-colors hover:bg-card-hover"
                title={t.url}
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 transition-transform group-hover:scale-105">
                  <Favicon url={t.url} size={24} />
                </span>
                <span className="line-clamp-2 w-full break-words text-[12px] leading-tight text-text-primary">{t.title}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="max-w-[420px] text-center text-[12.5px] leading-relaxed text-text-tertiary">
            The sites you visit and the pages you bookmark (Ctrl+D) show up here. Videos found on any page can be played with Quin Player or downloaded.
          </div>
        )}
      </div>
    </div>
  );
}
