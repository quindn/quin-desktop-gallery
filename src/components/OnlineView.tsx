import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { onlineForget, onlinePrepare, type HeaderList, type PlayInfo } from "../lib/online";
import { formatDuration } from "../lib/format";
import { useGalleryStore } from "../stores/galleryStore";
import { useDownloadStore, useHandoffStore } from "../stores/webStores";
import { VideoPlayer } from "./VideoPlayer";

const RECENT_KEY = "qpg.recentLinks";

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

const EXAMPLES = ["YouTube, TikTok, Facebook, X, Bilibili…", "https://…/video.mp4  ·  .m3u8 (HLS)  ·  .mpd (DASH)", "rtsp:// · rtmp:// · udp:// live streams"];

export function OnlineView() {
  const [input, setInput] = useState("");
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [notice, setNotice] = useState<string | null>(null);
  const sourceRef = useRef<{ url: string; headers: HeaderList | null }>({ url: "", headers: null });
  const retriedPipe = useRef(false);
  const requestId = useRef(0);

  const startDownload = useDownloadStore((s) => s.start);
  const setMainView = useGalleryStore((s) => s.setMainView);
  const handoff = useHandoffStore((s) => s.request);
  const clearHandoff = useHandoffStore((s) => s.clear);

  const remember = (url: string) => {
    const next = [url, ...loadRecent().filter((u) => u !== url)].slice(0, 12);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // storage disabled
    }
  };

  const open = useCallback(
    async (url: string, opts: { headers?: HeaderList | null; quality?: number | null; forcePipe?: boolean } = {}) => {
      const my = ++requestId.current;
      setLoading(true);
      setError(null);
      setNotice(null);
      if (!opts.forcePipe) retriedPipe.current = false;
      sourceRef.current = { url, headers: opts.headers ?? sourceRef.current.headers };
      try {
        const next = await onlinePrepare({ url, headers: opts.headers ?? sourceRef.current.headers, quality: opts.quality ?? null, forcePipe: opts.forcePipe });
        if (requestId.current !== my) {
          onlineForget(next.id);
          return;
        }
        setInfo((prev) => {
          if (prev) onlineForget(prev.id);
          return next;
        });
        remember(url);
      } catch (e) {
        if (requestId.current === my) {
          setError(String(e));
          setInfo(null);
        }
      } finally {
        if (requestId.current === my) setLoading(false);
      }
    },
    [],
  );

  // "Play" coming from the browser's video list, etc.
  useEffect(() => {
    if (!handoff) return;
    setInput(handoff.url);
    sourceRef.current = { url: handoff.url, headers: handoff.headers ?? null };
    void open(handoff.url, { headers: handoff.headers ?? null });
    clearHandoff();
  }, [handoff, open, clearHandoff]);

  useEffect(
    () => () => {
      requestId.current++;
      setInfo((prev) => {
        if (prev) onlineForget(prev.id);
        return prev;
      });
    },
    [],
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    const url = input.trim();
    if (!url) return;
    sourceRef.current = { url, headers: null };
    void open(url, { headers: null });
  }

  const stream = useMemo(
    () =>
      info && info.mode === "pipe"
        ? { duration: info.duration, live: info.isLive, urlAt: (t: number) => (t > 0.5 ? `${info.src}?t=${t.toFixed(2)}` : info.src) }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info?.id, info?.mode],
  );

  async function download(audioOnly: boolean) {
    if (!info) return;
    try {
      await startDownload({
        url: sourceRef.current.url,
        headers: sourceRef.current.headers,
        title: info.title,
        quality: info.quality,
        audioOnly,
      });
      setNotice(audioOnly ? "Audio download started" : "Download started");
    } catch (e) {
      setNotice(`Could not start the download: ${e}`);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-8 py-8">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-text-primary">Open a link</h1>
          <p className="mt-1 text-[13px] text-text-tertiary">Play any video link right here — and download it.</p>
        </div>

        <form onSubmit={submit} className="glass flex items-center gap-2 rounded-[22px] p-2 pl-4">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-text-tertiary">
            <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
            <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
          </svg>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste a video link…"
            aria-label="Video link"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-2 text-[14px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <button
            type="button"
            onClick={async () => {
              try {
                setInput(await navigator.clipboard.readText());
              } catch {
                // clipboard read not permitted
              }
            }}
            className="rounded-control px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
          >
            Paste
          </button>
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-control bg-accent px-5 py-2 text-[13px] font-medium text-white transition-opacity disabled:opacity-40"
          >
            {loading ? "Opening…" : "Play"}
          </button>
        </form>

        {error && (
          <div className="rounded-card border border-red-400/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-300">
            {error}
            <div className="mt-1 text-[12px] text-text-tertiary">
              Tip: open the page in the <button onClick={() => setMainView("browser")} className="underline">Browser</button> — the video it loads is caught automatically.
            </div>
          </div>
        )}

        {info ? (
          <div className="flex flex-col gap-4">
            <VideoPlayer
              key={info.id}
              src={info.src}
              stream={stream}
              poster={info.thumbnail}
              title={info.title}
              handleArrows
              qualities={info.qualities.map((q) => ({ label: q.label, height: q.height }))}
              quality={info.quality}
              onQuality={(h) => void open(sourceRef.current.url, { quality: h })}
              onError={() => {
                if (info.mode === "direct" && !retriedPipe.current) {
                  retriedPipe.current = true;
                  void open(sourceRef.current.url, { quality: info.quality, forcePipe: true });
                }
              }}
              className="aspect-video max-h-[68vh] w-full shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
            />
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium text-text-primary">{info.title}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-text-tertiary">
                  {info.extractor && <span>{info.extractor}</span>}
                  {info.duration ? <span>{formatDuration(info.duration * 1000)}</span> : info.isLive ? <span>Live</span> : null}
                  {info.quality ? <span>{info.quality}p</span> : null}
                  <span>{info.mode === "pipe" ? "Streaming via FFmpeg" : "Direct"}</span>
                </div>
              </div>
              <button
                onClick={() => void download(false)}
                className="flex items-center gap-2 rounded-control bg-accent px-4 py-2 text-[13px] font-medium text-white shadow-[0_6px_24px_rgba(102,115,224,0.35)] transition-transform hover:-translate-y-0.5 active:scale-95"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 4v11" />
                  <path d="m7 11 5 5 5-5" />
                  <path d="M5 20h14" />
                </svg>
                Download
              </button>
              {info.hasAudio && (
                <button
                  onClick={() => void download(true)}
                  className="rounded-control bg-card px-4 py-2 text-[13px] text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary"
                >
                  Audio only (MP3)
                </button>
              )}
              <button
                onClick={() => setMainView("downloads")}
                className="rounded-control px-3 py-2 text-[12px] text-text-tertiary transition-colors hover:text-text-primary"
              >
                View downloads →
              </button>
            </div>
            {notice && <div className="text-[12px] text-emerald-400">{notice}</div>}
          </div>
        ) : (
          !loading && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="glass rounded-card p-4">
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">Works with</div>
                <ul className="flex flex-col gap-1.5 text-[13px] text-text-secondary">
                  {EXAMPLES.map((x) => (
                    <li key={x}>• {x}</li>
                  ))}
                </ul>
              </div>
              <div className="glass rounded-card p-4">
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">Recent</div>
                {recent.length === 0 ? (
                  <div className="text-[13px] text-text-tertiary">Links you open show up here.</div>
                ) : (
                  <div className="flex flex-col">
                    {recent.map((u) => (
                      <button
                        key={u}
                        onClick={() => {
                          setInput(u);
                          sourceRef.current = { url: u, headers: null };
                          void open(u, { headers: null });
                        }}
                        className="truncate rounded-[8px] px-2 py-1.5 text-left text-[12.5px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}

        {loading && !info && (
          <div className="flex items-center gap-3 text-[13px] text-text-tertiary">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
            Looking for the video…
          </div>
        )}
      </div>
    </div>
  );
}
