import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { searchSuggest, type MediaListItem, type SearchChip } from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";
import { useGalleryStore } from "../stores/galleryStore";
import { requestThumbnail, useThumbUrl } from "../stores/thumbnailStore";

// The library search box, Windows 11 Explorer style: searches as you type (words in any order,
// no accents needed, in names and folders), Explorer-like filters (kind:, size:, date:, …), a
// drop-down with matching files (open one directly), folders, filter completions, recent
// searches, and chips showing how the text was understood. The language itself lives in
// src-tauri/src/db/search.rs.

const RECENT_KEY = "qpg.recentSearches";

type Field = { key: string; desc: string; values: { v: string; hint?: string }[] };
const DATE_VALUES = [
  { v: "today" },
  { v: "yesterday" },
  { v: "thisweek", hint: "this week" },
  { v: "lastweek", hint: "last week" },
  { v: "thismonth", hint: "this month" },
  { v: "lastmonth", hint: "last month" },
  { v: "thisyear", hint: "this year" },
  { v: "lastyear", hint: "last year" },
  { v: "last7days", hint: "the last 7 days" },
  { v: "2025", hint: "a year" },
  { v: "2025-06", hint: "a month" },
  { v: ">2025-01-01", hint: "after a day" },
  { v: "2024..2025", hint: "a range" },
];
const FIELDS: Field[] = [
  { key: "kind:", desc: "Type", values: [{ v: "video" }, { v: "photo" }, { v: "gif", hint: "animated" }] },
  { key: "ext:", desc: "File extension", values: ["mp4", "mov", "mkv", "webm", "jpg", "png", "heic", "gif", "mp4,mov"].map((v) => ({ v })) },
  {
    key: "size:",
    desc: "File size",
    values: [
      { v: ">100mb", hint: "over 100 MB" },
      { v: "<10mb", hint: "under 10 MB" },
      { v: "1gb..4gb", hint: "a range" },
      { v: "tiny", hint: "< 16 KB" },
      { v: "small", hint: "16 KB – 1 MB" },
      { v: "medium", hint: "1 – 128 MB" },
      { v: "large", hint: "128 MB – 1 GB" },
      { v: "huge", hint: "1 – 4 GB" },
      { v: "gigantic", hint: "> 4 GB" },
    ],
  },
  { key: "date:", desc: "Date modified", values: DATE_VALUES },
  { key: "created:", desc: "Date created", values: DATE_VALUES },
  { key: "taken:", desc: "Date taken", values: DATE_VALUES },
  {
    key: "duration:",
    desc: "Video length",
    values: [
      { v: ">10m", hint: "over 10 min" },
      { v: "<30s", hint: "under 30 s" },
      { v: "1m..5m", hint: "a range" },
      { v: "veryshort", hint: "< 1 min" },
      { v: "short", hint: "1 – 5 min" },
      { v: "medium", hint: "5 – 30 min" },
      { v: "long", hint: "30 – 60 min" },
      { v: "verylong", hint: "> 1 h" },
    ],
  },
  { key: "res:", desc: "Resolution", values: [{ v: "4k" }, { v: "1440p" }, { v: "1080p" }, { v: "720p" }, { v: "sd", hint: "below 720p" }, { v: ">=1080p", hint: "1080p or more" }] },
  {
    key: "is:",
    desc: "Is…",
    values: ["fav", "video", "photo", "gif", "portrait", "landscape", "square", "rated", "unrated", "tagged"].map((v) => ({ v })),
  },
  { key: "rating:", desc: "Stars", values: [{ v: ">=3", hint: "3 stars or more" }, { v: "5" }] },
  { key: "tag:", desc: "Tag", values: [] },
  { key: "name:", desc: "Only in the file name", values: [] },
  { key: "folder:", desc: "Only in folder names", values: [] },
  { key: "width:", desc: "Width in pixels", values: [{ v: ">=1920" }] },
  { key: "height:", desc: "Height in pixels", values: [{ v: ">=1080" }] },
];
const QUICK = ["kind:video", "kind:photo", "is:fav", "date:thisweek", "size:>100mb", "duration:>10m", "res:4k", "is:portrait"];
const HELP: [string, string][] = [
  ["beach 2024", "every word, any order, in names or folders"],
  ["dang", "no accents needed: finds “Đặng”"],
  ['"summer trip"', "these words together"],
  ["cat -dog", "without “dog”"],
  ["cat OR dog", "either one"],
  ["IMG_*.jpg", "wildcards: * any text, ? one character"],
  ["kind:video size:>1gb", "Explorer filters, combine freely"],
  ["date:lastweek", "today, thisweek, thismonth, 2024-05, 17/5/2025, a..b"],
  ["duration:>10m res:1080p", "video length, resolution"],
  ["is:fav rating:>=4", "favorites, stars, is:portrait, is:landscape"],
  ["ext:mp4,mov folder:camera", "extensions, folder names"],
];

/** Lower case without accents, char by char (the same rule as the backend). */
function foldChar(c: string) {
  if (c === "đ" || c === "Đ") return "d";
  return c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
const fold = (s: string) => [...s].map(foldChar).join("");

function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const c of text) {
    if (c === '"') {
      q = !q;
      cur += c;
    } else if (/\s/.test(c) && !q) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** The plain words of the search (what to highlight / match folders against). */
function plainTerms(text: string): string[] {
  return tokenize(text)
    .filter((t) => t !== "OR" && t !== "AND" && !t.startsWith("-") && !/^[a-z_]+:/i.test(t) && !/[*?]/.test(t))
    .map((t) => fold(t.replace(/"/g, "")))
    .filter(Boolean);
}

/** `text` with the parts that match `terms` (accent-insensitive) in bold. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const chars = [...text];
  const map: number[] = [];
  let folded = "";
  chars.forEach((c, i) => {
    const f = foldChar(c);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  });
  const mark = new Array(chars.length).fill(false);
  for (const t of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(t, from);
      if (at < 0) break;
      for (let k = at; k < at + t.length; k++) mark[map[k]] = true;
      from = at + Math.max(1, t.length);
    }
  }
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < chars.length) {
    const m = mark[i];
    let j = i;
    while (j < chars.length && mark[j] === m) j++;
    const s = chars.slice(i, j).join("");
    parts.push(m ? <b key={i} className="font-semibold text-accent">{s}</b> : <span key={i}>{s}</span>);
    i = j;
  }
  return <>{parts}</>;
}

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}
function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    // storage unavailable: recents just aren't kept
  }
}

function FileThumb({ item }: { item: MediaListItem }) {
  const url = useThumbUrl(item.id);
  useEffect(() => requestThumbnail(item.id), [item.id]);
  return (
    <div className="relative h-9 w-14 shrink-0 overflow-hidden rounded bg-white/5">
      {url && <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />}
      {item.mediaType === "video" && item.durationMs != null && (
        <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-0.5 text-[8.5px] text-white">{formatDuration(item.durationMs)}</span>
      )}
    </div>
  );
}

const CHIP_STYLE: Record<SearchChip["kind"], string> = {
  text: "bg-white/10 text-text-primary",
  filter: "bg-accent/25 text-[#b9c3ff]",
  exclude: "bg-red-500/20 text-red-200",
  unknown: "bg-amber-500/20 text-amber-200 line-through decoration-amber-200/60",
};

type Row = { key: string; node: ReactNode; act: () => void };

export function SearchBox() {
  const search = useGalleryStore((s) => s.filters.search);
  const setFilters = useGalleryStore((s) => s.setFilters);
  const selectedFolder = useGalleryStore((s) => s.selectedFolder);
  const folders = useGalleryStore((s) => s.folders);
  const tags = useGalleryStore((s) => s.tags);
  const mainView = useGalleryStore((s) => s.mainView);
  const [value, setValue] = useState(search);
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [hi, setHi] = useState(-1);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [sugg, setSugg] = useState<{ text: string; chips: SearchChip[]; items: MediaListItem[]; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);

  useEffect(() => setValue(search), [search]);

  // live search (the grid follows as you type)
  useEffect(() => {
    const t = setTimeout(() => {
      if (value !== useGalleryStore.getState().filters.search) setFilters({ search: value });
    }, 300);
    return () => clearTimeout(t);
  }, [value, setFilters]);

  // drop-down data
  useEffect(() => {
    const text = value.trim();
    if (!open || !text) {
      setSugg(null);
      return;
    }
    const my = ++reqRef.current;
    const t = setTimeout(() => {
      const q = { ...useGalleryStore.getState().buildQuery(8, 0), search: text };
      searchSuggest(q, 8)
        .then((r) => my === reqRef.current && setSugg({ text, ...r }))
        .catch(() => my === reqRef.current && setSugg({ text, chips: [], items: [], total: 0 }));
    }, 120);
    return () => clearTimeout(t);
  }, [value, open, selectedFolder]);

  // Ctrl+F / Ctrl+E / F3 focus the box, like Explorer
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if (((e.ctrlKey || e.metaKey) && (k === "f" || k === "e")) || e.key === "F3") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // click outside closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHelp(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const remember = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setRecent((r) => {
      const next = [t, ...r.filter((x) => x !== t)].slice(0, 8);
      saveRecent(next);
      return next;
    });
  }, []);

  const applyNow = (text: string) => {
    setValue(text);
    setFilters({ search: text });
  };
  /** Replaces the word being typed (or appends) with `token`. */
  const complete = (token: string, keepOpen = true) => {
    const parts = value.endsWith(" ") || !value ? [...tokenize(value), ""] : tokenize(value);
    parts[parts.length - 1] = token;
    const next = parts.join(" ") + (token.endsWith(":") ? "" : " ");
    setValue(next);
    setHi(-1);
    if (keepOpen) setOpen(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  };

  const terms = useMemo(() => plainTerms(value), [value]);
  const last = value.endsWith(" ") ? "" : (tokenize(value).pop() ?? "");

  // ---------------------------------------------------------------- rows (keyboard order)
  const completionRows: Row[] = [];
  if (last && !last.startsWith('"')) {
    const neg = last.startsWith("-") ? "-" : "";
    const body = last.slice(neg.length).toLowerCase();
    const colon = body.indexOf(":");
    if (colon < 0 && body.length >= 1) {
      for (const f of FIELDS.filter((f) => f.key.startsWith(body) && f.key !== body + ":").slice(0, 4)) {
        completionRows.push({
          key: `f-${f.key}`,
          act: () => complete(neg + f.key),
          node: (
            <span>
              <b className="font-mono text-[#b9c3ff]">{f.key}</b> <span className="text-text-tertiary">{f.desc}</span>
            </span>
          ),
        });
      }
    } else if (colon > 0) {
      const fk = body.slice(0, colon + 1);
      const typed = body.slice(colon + 1);
      const field = FIELDS.find((f) => f.key === fk);
      const values = field ? (fk === "tag:" ? tags.map((t) => ({ v: t.name.includes(" ") ? `"${t.name}"` : t.name, hint: `${t.count}` })) : field.values) : [];
      for (const v of values.filter((v) => fold(v.v).startsWith(fold(typed)) && v.v !== typed).slice(0, 8)) {
        completionRows.push({
          key: `v-${fk}${v.v}`,
          act: () => complete(neg + fk + v.v),
          node: (
            <span>
              <b className="font-mono text-[#b9c3ff]">
                {fk}
                {v.v}
              </b>{" "}
              {v.hint && <span className="text-text-tertiary">{v.hint}</span>}
            </span>
          ),
        });
      }
    }
  }
  const fileRows: Row[] = (sugg?.items ?? []).map((it) => ({
    key: `file-${it.id}`,
    act: () => {
      remember(value);
      setOpen(false);
      useGalleryStore.getState().revealFile(it.id, true, value);
    },
    node: (
      <div className="flex min-w-0 items-center gap-2.5">
        <FileThumb item={it} />
        <div className="min-w-0">
          <div className="truncate text-[12px] text-text-primary">
            <Highlight text={it.filename} terms={terms} />
          </div>
          <div className="truncate text-[10.5px] text-text-tertiary">
            <Highlight text={it.folderRelPath || "(library root)"} terms={terms} /> · {formatBytes(it.fileSize)}
          </div>
        </div>
      </div>
    ),
  }));
  const folderRows: Row[] =
    terms.length === 0
      ? []
      : folders
          .filter((f) => {
            const k = fold(f.relPath);
            return terms.every((t) => k.includes(t));
          })
          .sort((a, b) => b.mediaCount - a.mediaCount)
          .slice(0, 5)
          .map((f) => ({
            key: `dir-${f.relPath}`,
            act: () => {
              remember(value);
              setOpen(false);
              applyNow("");
              useGalleryStore.getState().selectFolder(f.relPath);
            },
            node: (
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-9 w-14 shrink-0 items-center justify-center text-[18px] text-[#e8c25a]">▰</span>
                <div className="min-w-0">
                  <div className="truncate text-[12px] text-text-primary">
                    <Highlight text={f.name} terms={terms} />
                  </div>
                  <div className="truncate text-[10.5px] text-text-tertiary">
                    {f.relPath} · {f.mediaCount} files
                  </div>
                </div>
              </div>
            ),
          }));
  const recentRows: Row[] = value.trim()
    ? []
    : recent.map((r) => ({
        key: `r-${r}`,
        act: () => {
          applyNow(r);
          remember(r);
          setOpen(true);
        },
        node: (
          <div className="group flex items-center gap-2">
            <span className="text-text-tertiary">↺</span>
            <span className="flex-1 truncate">{r}</span>
            <button
              aria-label={`Forget ${r}`}
              onClick={(e) => {
                e.stopPropagation();
                setRecent((list) => {
                  const next = list.filter((x) => x !== r);
                  saveRecent(next);
                  return next;
                });
              }}
              className="hidden px-1 text-text-tertiary hover:text-text-primary group-hover:block"
            >
              ✕
            </button>
          </div>
        ),
      }));
  const rows = [...completionRows, ...recentRows, ...fileRows, ...folderRows];

  useEffect(() => setHi(-1), [value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHi((h) => Math.min(rows.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(-1, h - 1));
    } else if (e.key === "Tab" && completionRows.length > 0 && open) {
      e.preventDefault();
      (completionRows[Math.max(0, Math.min(hi, completionRows.length - 1))] ?? completionRows[0]).act();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hi >= 0 && rows[hi]) rows[hi].act();
      else {
        applyNow(value);
        remember(value);
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (open && (value || help)) {
        setOpen(false);
        setHelp(false);
      } else {
        applyNow("");
        inputRef.current?.blur();
        setOpen(false);
      }
    }
  };

  const folderName = selectedFolder ? (selectedFolder.split("/").pop() ?? selectedFolder) : null;
  const scoped = mainView === "library" && folderName;
  let rowIndex = -1;
  const section = (title: string, list: Row[], extra?: ReactNode) =>
    list.length === 0 ? null : (
      <div className="py-1">
        <div className="flex items-center justify-between px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          <span>{title}</span>
          {extra}
        </div>
        {list.map((r) => {
          rowIndex++;
          const i = rowIndex;
          return (
            <div
              key={r.key}
              data-testid="search-row"
              data-row-key={r.key}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={r.act}
              className={`cursor-pointer px-3 py-1.5 text-[12px] ${hi === i ? "bg-accent/25" : "hover:bg-white/5"}`}
            >
              {r.node}
            </div>
          );
        })}
      </div>
    );

  return (
    <div ref={boxRef} className="no-drag relative w-64 transition-[width] duration-200 focus-within:w-[440px]" data-testid="search-box">
      <div className="flex items-center gap-1 rounded-control bg-card py-1 pl-2.5 pr-1 focus-within:ring-1 focus-within:ring-accent">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-text-tertiary">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        {scoped && (
          <span className="flex max-w-[120px] shrink-0 items-center gap-0.5 rounded bg-white/10 py-0.5 pl-1.5 pr-0.5 text-[10.5px] text-text-secondary" title={`Searching in ${selectedFolder}`}>
            <span className="truncate">in {folderName}</span>
            <button
              aria-label="Search the whole library"
              title="Search the whole library"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => useGalleryStore.getState().selectFolder(null)}
              className="px-0.5 text-text-tertiary hover:text-text-primary"
            >
              ✕
            </button>
          </span>
        )}
        <input
          ref={inputRef}
          data-testid="search-input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder={scoped ? "Search this folder…" : "Search all media…"}
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[12px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
        {value && (
          <button
            aria-label="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              applyNow("");
              inputRef.current?.focus();
            }}
            className="px-1 text-[12px] text-text-tertiary hover:text-text-primary"
          >
            ✕
          </button>
        )}
        <button
          aria-label="Search tips"
          title="Search tips"
          data-testid="search-help"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setHelp((h) => !h);
            setOpen(true);
            inputRef.current?.focus();
          }}
          className={`h-5 w-5 shrink-0 rounded-full text-[11px] ${help ? "bg-accent text-white" : "text-text-tertiary hover:bg-white/10 hover:text-text-primary"}`}
        >
          ?
        </button>
      </div>

      {open && (
        <div
          data-testid="search-dropdown"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-card border border-white/10 bg-[#16161d]/[0.98] shadow-2xl backdrop-blur"
        >
          {help ? (
            <div className="p-2">
              <div className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Search tips — click one to try it</div>
              {HELP.map(([ex, d]) => (
                <div
                  key={ex}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setHelp(false);
                    applyNow(ex);
                  }}
                  className="flex cursor-pointer items-baseline gap-3 rounded px-1.5 py-1 hover:bg-white/5"
                >
                  <code className="w-[170px] shrink-0 truncate font-mono text-[11.5px] text-[#b9c3ff]">{ex}</code>
                  <span className="text-[11px] text-text-tertiary">{d}</span>
                </div>
              ))}
              <div className="px-1.5 pt-2 text-[10.5px] text-text-tertiary">Enter searches · ↑↓ pick · Tab completes a filter · Esc closes · Ctrl+F / Ctrl+E / F3 jump here</div>
            </div>
          ) : (
            <>
              {value.trim() && sugg && sugg.text === value.trim() && (
                <div className="flex flex-wrap items-center gap-1 border-b border-white/5 px-3 py-2" data-testid="search-chips">
                  {sugg.chips.map((c, i) => (
                    <span key={i} data-chip-kind={c.kind} className={`rounded px-1.5 py-0.5 text-[10.5px] ${CHIP_STYLE[c.kind]}`}>
                      {c.label}
                    </span>
                  ))}
                  <span className="ml-auto text-[10.5px] text-text-tertiary" data-testid="search-total">
                    {sugg.total.toLocaleString()} {sugg.total === 1 ? "result" : "results"}
                    {scoped ? ` in ${folderName}` : ""}
                  </span>
                </div>
              )}
              {section("Filters", completionRows)}
              {section(
                "Recent searches",
                recentRows,
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setRecent([]);
                    saveRecent([]);
                  }}
                  className="normal-case tracking-normal hover:text-text-primary"
                >
                  Clear
                </button>,
              )}
              {!value.trim() && (
                <div className="px-3 pb-2 pt-1.5">
                  <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Quick filters</div>
                  <div className="flex flex-wrap gap-1">
                    {QUICK.map((q) => (
                      <button
                        key={q}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => complete(q)}
                        className="rounded bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                  <div className="pt-2 text-[10.5px] text-text-tertiary">Type words in any order, accents optional. Press ? for every filter.</div>
                </div>
              )}
              {section("Files", fileRows, sugg && sugg.total > fileRows.length ? <span className="normal-case tracking-normal">Enter shows all {sugg.total.toLocaleString()}</span> : undefined)}
              {section("Folders", folderRows)}
              {value.trim() && sugg && sugg.text === value.trim() && sugg.total === 0 && (
                <div className="px-3 py-3 text-[12px] text-text-tertiary" data-testid="search-empty">
                  Nothing matches{scoped ? ` in ${folderName}` : ""}.
                  {scoped && (
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => useGalleryStore.getState().selectFolder(null)}
                      className="ml-1 text-accent hover:underline"
                    >
                      Search the whole library
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
