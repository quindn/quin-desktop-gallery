import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Segment } from "../lib/api";
import { formatTime, parseTime } from "../lib/timecode";

/** Shortest part that can be kept, in ms. */
export const MIN_PART = 100;

// ------------------------------------------------------------------ part arithmetic (pure)

/** Parts sorted, clipped to the video, at least MIN_PART long and not overlapping. */
export function normalizeParts(parts: Segment[], duration: number): Segment[] {
  const sorted = [...parts]
    .map((p) => ({ startMs: Math.max(0, Math.min(p.startMs, duration)), endMs: Math.max(0, Math.min(p.endMs, duration)) }))
    .filter((p) => p.endMs - p.startMs >= MIN_PART)
    .sort((a, b) => a.startMs - b.startMs);
  const out: Segment[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev && p.startMs < prev.endMs) prev.endMs = Math.max(prev.endMs, p.endMs);
    else out.push({ ...p });
  }
  return out.length ? out : [{ startMs: 0, endMs: duration }];
}

/** Neighbouring parts that touch are one piece of the output: merge them for the export. */
export function mergeTouching(parts: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev && p.startMs <= prev.endMs + 1) prev.endMs = Math.max(prev.endMs, p.endMs);
    else out.push({ ...p });
  }
  return out;
}

export const keptLength = (parts: Segment[]) => parts.reduce((n, p) => n + (p.endMs - p.startMs), 0);

/** Removes [from, to) from every part (a part spanning it is split in two around it). */
export function cutRange(parts: Segment[], from: number, to: number): Segment[] {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const out: Segment[] = [];
  for (const p of parts) {
    if (p.endMs <= a || p.startMs >= b) out.push({ ...p });
    else {
      if (a - p.startMs >= MIN_PART) out.push({ startMs: p.startMs, endMs: Math.round(a) });
      if (p.endMs - b >= MIN_PART) out.push({ startMs: Math.round(b), endMs: p.endMs });
    }
  }
  return out;
}

/** Keeps only what lies inside [from, to). */
export function keepRange(parts: Segment[], from: number, to: number): Segment[] {
  const [a, b] = from <= to ? [from, to] : [to, from];
  return parts
    .map((p) => ({ startMs: Math.round(Math.max(p.startMs, a)), endMs: Math.round(Math.min(p.endMs, b)) }))
    .filter((p) => p.endMs - p.startMs >= MIN_PART);
}

/** Splits the part under `t` in two there; the selection moves to the right half. */
export function splitAt(parts: Segment[], t: number): { parts: Segment[]; index: number } | null {
  const i = parts.findIndex((p) => t > p.startMs + MIN_PART && t < p.endMs - MIN_PART);
  if (i < 0) return null;
  const p = parts[i];
  const next = [...parts.slice(0, i), { startMs: p.startMs, endMs: t }, { startMs: t, endMs: p.endMs }, ...parts.slice(i + 1)];
  return { parts: next, index: i + 1 };
}

/**
 * Moves one edge of part `i`, kept between its neighbours and at least MIN_PART long. With `push`
 * (typed times, I / O) an edge set past the other one carries it along — typing a start after the
 * current end moves the end too — instead of stopping at it (which is what dragging does).
 */
export function setEdge(parts: Segment[], i: number, edge: "start" | "end", t: number, duration: number, push = false): Segment[] {
  const p = parts[i];
  const floor = i > 0 ? parts[i - 1].endMs : 0;
  const ceil = i < parts.length - 1 ? parts[i + 1].startMs : duration;
  let { startMs, endMs } = p;
  if (edge === "start") {
    startMs = Math.round(Math.min(Math.max(t, floor), (push ? ceil : endMs) - MIN_PART));
    if (endMs - startMs < MIN_PART) endMs = Math.min(ceil, Math.max(endMs, startMs + (p.endMs - p.startMs)));
  } else {
    endMs = Math.round(Math.max(Math.min(t, ceil), (push ? floor : startMs) + MIN_PART));
    if (endMs - startMs < MIN_PART) startMs = Math.max(floor, Math.min(startMs, endMs - (p.endMs - p.startMs)));
  }
  return parts.map((q, j) => (j !== i ? q : { startMs, endMs }));
}

// ------------------------------------------------------------------ small controls

function Btn({ label, title, onClick, disabled, active, children }: { label?: string; title: string; onClick: () => void; disabled?: boolean; active?: boolean; children?: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-[11.5px] transition-colors disabled:opacity-30 ${
        active ? "bg-accent text-white" : "bg-white/10 text-white/85 hover:bg-white/20"
      }`}
    >
      {children}
      {label}
    </button>
  );
}

/**
 * A time you can type. Shows m:ss.mmm; accepts anything `parseTime` reads ("1:23", "83.5", "1m23s").
 * Enter / leaving the field applies it, Escape cancels; ↑ / ↓ nudge by one frame (Shift: a second).
 */
export function TimeField({ label, value, onCommit, step, min = 0, max, testId }: { label: string; value: number; onCommit: (ms: number) => void; step: number; min?: number; max?: number; testId?: string }) {
  const [text, setText] = useState(formatTime(value));
  const [editing, setEditing] = useState(false);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (!editing) setText(formatTime(value));
  }, [value, editing]);

  const clamp = (v: number) => Math.min(Math.max(v, min), max ?? Number.POSITIVE_INFINITY);
  /** Applies what was typed; false (and the field marked) when it isn't a time. */
  function commit(): boolean {
    const v = parseTime(text);
    if (v === null) {
      setBad(true);
      return false;
    }
    setBad(false);
    setEditing(false);
    onCommit(clamp(v));
    return true;
  }
  function onKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Enter") {
      // a bad entry keeps the focus so it can be corrected (or Escape'd)
      if (commit()) (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setEditing(false);
      setBad(false);
      setText(formatTime(value));
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const d = (e.shiftKey ? 1000 : step) * (e.key === "ArrowUp" ? 1 : -1);
      setEditing(false);
      onCommit(clamp(value + d));
    }
  }
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-white/45">{label}</span>
      <input
        data-testid={testId}
        value={text}
        spellCheck={false}
        onFocus={(e) => {
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          setBad(false);
        }}
        onBlur={() => {
          // leaving the field with something unreadable just puts the old time back
          if (editing && !commit()) {
            setEditing(false);
            setBad(false);
            setText(formatTime(value));
          }
        }}
        onKeyDown={onKey}
        className={`w-[104px] rounded-control bg-white/10 px-2 py-1 font-mono text-[12.5px] tabular-nums text-white outline-none ring-1 ${
          bad ? "ring-red-400" : "ring-transparent focus:ring-accent"
        }`}
      />
    </label>
  );
}

// ------------------------------------------------------------------ the timeline

const ico = (d: string, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d={d} />
  </svg>
);

export interface TimelineProps {
  duration: number;
  fps: number;
  current: number;
  playing: boolean;
  parts: Segment[];
  selected: number;
  filmstrip: string | null;
  previewing: boolean;
  onSeek: (ms: number) => void;
  onTogglePlay: () => void;
  onPreview: () => void;
  onParts: (parts: Segment[], selected?: number) => void;
  onSelect: (i: number) => void;
  /** A marked range (for "cut out" / "keep only"), or null. */
  range: { from: number; to: number } | null;
  onRange: (r: { from: number; to: number } | null) => void;
}

/** A readable tick spacing for the ruler. */
function tickStep(duration: number, widthPx: number): number {
  const target = (duration / Math.max(widthPx, 1)) * 90; // about one label per 90 px
  const steps = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
  return steps.find((s) => s >= target) ?? 3_600_000;
}

export function EditorTimeline(props: TimelineProps) {
  const { duration, fps, current, playing, parts, selected, filmstrip, previewing, onSeek, onTogglePlay, onPreview, onParts, onSelect, range, onRange } = props;
  const frame = 1000 / (fps > 0 ? fps : 30);
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ kind: "seek" } | { kind: "edge"; i: number; edge: "start" | "end" } | { kind: "range"; from: number } | null>(null);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pct = (ms: number) => `${(Math.min(Math.max(ms, 0), duration) / Math.max(duration, 1)) * 100}%`;
  const timeAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return (Math.min(Math.max(clientX - r.left, 0), r.width) / Math.max(r.width, 1)) * duration;
  };

  function onPointerDown(e: ReactPointerEvent, kind: "seek" | "start" | "end", i = -1) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (kind === "seek" && e.shiftKey) {
      // Shift+drag on the track marks a range to cut out (or keep)
      const t = timeAt(e.clientX);
      drag.current = { kind: "range", from: t };
      onRange({ from: t, to: t });
      return;
    }
    if (kind === "seek") {
      drag.current = { kind: "seek" };
      const t = timeAt(e.clientX);
      const inside = parts.findIndex((p) => t >= p.startMs && t <= p.endMs);
      if (inside >= 0 && inside !== selected) onSelect(inside);
      onSeek(t);
    } else {
      drag.current = { kind: "edge", i, edge: kind };
      onSelect(i);
    }
  }
  function onPointerMove(e: ReactPointerEvent) {
    const t = timeAt(e.clientX);
    setHover(t);
    const d = drag.current;
    if (!d) return;
    if (d.kind === "seek") onSeek(t);
    else if (d.kind === "range") onRange({ from: Math.min(d.from, t), to: Math.max(d.from, t) });
    else {
      const next = setEdge(parts, d.i, d.edge, t, duration);
      onParts(next, d.i);
      onSeek(d.edge === "start" ? next[d.i].startMs : next[d.i].endMs);
    }
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    // a Shift+click without a drag marks nothing
    if (d?.kind === "range" && range && range.to - range.from < MIN_PART) onRange(null);
  }

  const doCut = () => {
    if (!range) return;
    const next = cutRange(parts, range.from, range.to);
    if (next.length === 0) return;
    onParts(next, Math.min(selected, next.length - 1));
    onRange(null);
    onSeek(Math.min(range.from, duration));
  };
  const doKeep = () => {
    if (!range) return;
    const next = keepRange(parts, range.from, range.to);
    if (next.length === 0) return;
    onParts(next, 0);
    onRange(null);
    onSeek(next[0].startMs);
  };

  const sel = parts[Math.min(selected, parts.length - 1)];
  const step = tickStep(duration, width);
  const ticks: number[] = [];
  for (let t = 0; t <= duration && ticks.length < 400; t += step) ticks.push(t);
  const total = keptLength(parts);
  const canSplit = parts.some((p) => current > p.startMs + MIN_PART && current < p.endMs - MIN_PART);

  const setSel = (edge: "start" | "end", t: number) => onParts(setEdge(parts, selected, edge, t, duration, true), selected);
  const splitHere = () => {
    const r = splitAt(parts, current);
    if (r) onParts(r.parts, r.index);
  };
  const removeSel = () => {
    if (parts.length <= 1) return;
    const next = parts.filter((_, j) => j !== selected);
    onParts(next, Math.min(selected, next.length - 1));
  };
  const addPart = () => {
    // fill the gap after the selected part (or before the first one) with a new part
    const gaps: Segment[] = [];
    let at = 0;
    for (const p of parts) {
      if (p.startMs - at >= MIN_PART) gaps.push({ startMs: at, endMs: p.startMs });
      at = p.endMs;
    }
    if (duration - at >= MIN_PART) gaps.push({ startMs: at, endMs: duration });
    // the gap under the playhead (the new part starts right there), else the next gap after the selection
    const here = gaps.find((g) => current >= g.startMs && current <= g.endMs - MIN_PART);
    const gap = here ?? gaps.find((g) => g.startMs >= (sel?.endMs ?? 0)) ?? gaps[0];
    if (!gap) return;
    const from = here ? Math.round(current) : gap.startMs;
    const np = { startMs: from, endMs: Math.min(gap.endMs, from + 5000) };
    const next = [...parts, np].sort((a, b) => a.startMs - b.startMs);
    onParts(next, next.indexOf(np));
    onSeek(np.startMs);
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-white/10 bg-[#0c0c10] px-4 pb-3 pt-2" data-testid="editor-timeline">
      {/* transport */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn title="Start of this part (Home)" onClick={() => onSeek(sel?.startMs ?? 0)}>{ico("M6 5h2v14H6zM20 5v14L9 12z")}</Btn>
        <Btn title="Back 1 second (Shift+←)" onClick={() => onSeek(current - 1000)} label="1s">{ico("M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z", 12)}</Btn>
        <Btn title="Back 1 frame (←)" onClick={() => onSeek(current - frame)}>{ico("M6 6h2v12H6zm3.5 6 8.5 6V6z")}</Btn>
        <Btn title={playing ? "Pause (Space)" : "Play (Space)"} onClick={onTogglePlay} active>
          {playing ? ico("M6 5h4v14H6zm8 0h4v14h-4z", 16) : ico("M8 5v14l11-7z", 16)}
        </Btn>
        <Btn title="Forward 1 frame (→)" onClick={() => onSeek(current + frame)}>{ico("M16 6h2v12h-2zM6 18l8.5-6L6 6z")}</Btn>
        <Btn title="Forward 1 second (Shift+→)" onClick={() => onSeek(current + 1000)} label="1s">{ico("M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z", 12)}</Btn>
        <Btn title="End of this part (End)" onClick={() => onSeek(sel?.endMs ?? duration)}>{ico("M16 5h2v14h-2zM4 5l11 7-11 7z")}</Btn>
        <div className="mx-1 flex items-end gap-1.5">
          <TimeField label="Playhead" value={current} step={frame} max={duration} onCommit={onSeek} testId="tl-playhead" />
          <span className="pb-1.5 font-mono text-[11.5px] text-white/40">/ {formatTime(duration)}</span>
        </div>
        <Btn title="Play only the parts that are kept, skipping what is cut out" onClick={onPreview} active={previewing} label={previewing ? "Stop preview" : "Preview result"} />
        <div className="flex-1" />
        <span className="text-[11.5px] text-white/55" data-testid="tl-summary">
          {parts.length === 1 ? "Keeping 1 part" : `Keeping ${parts.length} parts`} · output {formatTime(total)}
        </span>
      </div>

      {/* ruler + track */}
      <div className="relative select-none" onPointerLeave={() => setHover(null)}>
        <div className="relative h-4 text-[9.5px] text-white/35">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2 font-mono" style={{ left: pct(t) }}>
              {formatTime(t, step < 1000)}
            </span>
          ))}
        </div>
        <div
          ref={trackRef}
          data-testid="tl-track"
          className="relative h-[62px] cursor-pointer overflow-hidden rounded-md bg-white/5"
          style={filmstrip ? { backgroundImage: `url("${filmstrip}")`, backgroundSize: "100% 100%" } : undefined}
          onPointerDown={(e) => onPointerDown(e, "seek")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {/* everything is dimmed; kept parts are cut out of the dimming */}
          <div className="pointer-events-none absolute inset-0 bg-black/65" />
          {parts.map((p, i) => (
            <div
              key={i}
              data-testid={`tl-part-${i}`}
              className={`absolute inset-y-0 border-y-2 ${i === selected ? "border-accent" : "border-white/60"}`}
              style={{ left: pct(p.startMs), width: `calc(${pct(p.endMs)} - ${pct(p.startMs)})`, backgroundImage: filmstrip ? `url("${filmstrip}")` : undefined, backgroundSize: `${width}px 100%`, backgroundPosition: `-${(p.startMs / Math.max(duration, 1)) * width}px 0`, backgroundColor: filmstrip ? undefined : "rgba(102,115,224,0.25)" }}
            >
              <span className="pointer-events-none absolute left-1.5 top-0.5 rounded bg-black/60 px-1 text-[10px] font-medium text-white">{i + 1}</span>
              {(["start", "end"] as const).map((edge) => (
                <div
                  key={edge}
                  data-testid={`tl-handle-${i}-${edge}`}
                  title={edge === "start" ? "Drag to move where this part starts" : "Drag to move where this part ends"}
                  onPointerDown={(e) => onPointerDown(e, edge, i)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  className={`absolute inset-y-0 w-3 cursor-ew-resize ${i === selected ? "bg-accent" : "bg-white/70"} ${edge === "start" ? "left-0 rounded-l-sm" : "right-0 rounded-r-sm"}`}
                >
                  <span className="absolute left-1/2 top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-black/50" />
                </div>
              ))}
            </div>
          ))}
          {range && range.to > range.from && (
            <div
              data-testid="tl-range"
              className="pointer-events-none absolute inset-y-0 border-x-2 border-red-400 bg-red-500/35"
              style={{ left: pct(range.from), width: `calc(${pct(range.to)} - ${pct(range.from)})` }}
            />
          )}
          {/* playhead */}
          <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_4px_rgba(0,0,0,0.8)]" style={{ left: pct(current) }}>
            <span className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-white" />
          </div>
          {hover !== null && !drag.current && (
            <div className="pointer-events-none absolute bottom-0 -translate-x-1/2 rounded bg-black/80 px-1 font-mono text-[10px] text-white" style={{ left: pct(hover) }}>
              {formatTime(hover)}
            </div>
          )}
        </div>
      </div>

      {/* the selected part, by the numbers */}
      {sel && (
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-white/45">Part</span>
            <div className="flex gap-1">
              {parts.map((_, i) => (
                <button
                  key={i}
                  onClick={() => {
                    onSelect(i);
                    onSeek(parts[i].startMs);
                  }}
                  className={`h-7 min-w-7 rounded-control px-1.5 text-[11.5px] ${i === selected ? "bg-accent text-white" : "bg-white/10 text-white/80 hover:bg-white/20"}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-end gap-1">
            <TimeField label="Start" value={sel.startMs} step={frame} max={duration} onCommit={(v) => setSel("start", v)} testId="tl-start" />
            <Btn title="Start this part at the playhead (I)" onClick={() => setSel("start", current)} label="I" />
          </div>
          <div className="flex items-end gap-1">
            <TimeField label="End" value={sel.endMs} step={frame} max={duration} onCommit={(v) => setSel("end", v)} testId="tl-end" />
            <Btn title="End this part at the playhead (O)" onClick={() => setSel("end", current)} label="O" />
          </div>
          <TimeField label="Length" value={sel.endMs - sel.startMs} step={frame} min={MIN_PART} onCommit={(v) => setSel("end", sel.startMs + v)} testId="tl-length" />
          <div className="flex-1" />
          <Btn title="Split the part under the playhead in two (S)" onClick={splitHere} disabled={!canSplit} label="Split at playhead" />
          <Btn title="Remove this part from the output (Delete)" onClick={removeSel} disabled={parts.length <= 1} label="Delete part" />
          <Btn title="Add a new part in the next gap" onClick={addPart} disabled={keptLength(parts) >= duration - MIN_PART} label="Add part" />
          <Btn title="Keep the whole video again" onClick={() => onParts([{ startMs: 0, endMs: duration }], 0)} label="Reset" />
        </div>
      )}
      {/* cut out / keep a range: mark it (typed, [ / ] at the playhead, or Shift+drag on the track) */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-md border border-red-400/20 bg-red-500/[0.06] px-2.5 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-red-200/70">Range to cut</span>
          <span className="text-[11px] text-white/45">{range && range.to > range.from ? `${formatTime(range.to - range.from)} marked` : "Shift+drag on the timeline, or type"}</span>
        </div>
        <div className="flex items-end gap-1">
          <TimeField label="From" value={range?.from ?? current} step={frame} max={duration} onCommit={(v) => onRange({ from: v, to: Math.max(v, range?.to ?? v) })} testId="tl-cut-from" />
          <Btn title="Range starts at the playhead ([)" onClick={() => onRange({ from: current, to: Math.max(current, range?.to ?? current) })} label="[" />
        </div>
        <div className="flex items-end gap-1">
          <TimeField label="To" value={range?.to ?? current} step={frame} max={duration} onCommit={(v) => onRange({ from: Math.min(v, range?.from ?? v), to: v })} testId="tl-cut-to" />
          <Btn title="Range ends at the playhead (])" onClick={() => onRange({ from: Math.min(current, range?.from ?? current), to: current })} label="]" />
        </div>
        <div className="flex-1" />
        <Btn title="Remove the marked range from the video (X)" onClick={doCut} disabled={!range || range.to - range.from < MIN_PART} label="Cut out range" />
        <Btn title="Keep only the marked range" onClick={doKeep} disabled={!range || range.to - range.from < MIN_PART} label="Keep only range" />
        <Btn title="Forget the marked range" onClick={() => onRange(null)} disabled={!range} label="Clear" />
      </div>
      <p className="text-[10.5px] text-white/35">
        Type times like 1:23.5, 83.5 or 1m23s · I / O set a part's start / end · S splits · Delete removes a part · [ / ] mark a range, X cuts it out · ← → step a frame (Shift: 1 s) · Space plays
      </p>
    </div>
  );
}
