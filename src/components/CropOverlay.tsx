import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { CropRect } from "../lib/api";

type Handle = "move" | "draw" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

/** Smallest crop edge, as a fraction of the frame. */
const MIN = 0.03;

interface DragState {
  handle: Handle;
  startX: number;
  startY: number;
  start: CropRect;
  boxW: number;
  boxH: number;
  /** Where the frame starts on screen and where a new box was anchored (fractions), for "draw". */
  left: number;
  top: number;
  ax: number;
  ay: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Draggable crop rectangle laid over the video preview. Works in fractions
 * of the frame (0..1), so it is independent of how large the preview is
 * rendered. Free-form: drag the interior to move it, any of the 8 handles
 * (4 corners, 4 edges) to resize each side on its own, or drag on the
 * dimmed area to draw a fresh box.
 * Must be placed inside a `relative` box that exactly matches the video.
 */
export function CropOverlay({ value, onChange }: { value: CropRect; onChange: (r: CropRect) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  function begin(e: ReactPointerEvent<HTMLDivElement>, handle: Handle) {
    const box = rootRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      start: value,
      boxW: box.width,
      boxH: box.height,
      left: box.left,
      top: box.top,
      ax: clamp((e.clientX - box.left) / box.width, 0, 1),
      ay: clamp((e.clientY - box.top) / box.height, 0, 1),
    };
  }

  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.boxW;
    const dy = (e.clientY - d.startY) / d.boxH;
    let { x, y } = d.start;
    let x2 = x + d.start.w;
    let y2 = y + d.start.h;

    if (d.handle === "draw") {
      const cx = clamp((e.clientX - d.left) / d.boxW, 0, 1);
      const cy = clamp((e.clientY - d.top) / d.boxH, 0, 1);
      let nx = Math.min(d.ax, cx);
      let nx2 = Math.max(d.ax, cx);
      let ny = Math.min(d.ay, cy);
      let ny2 = Math.max(d.ay, cy);
      if (nx2 - nx < MIN) [nx, nx2] = nx + MIN > 1 ? [1 - MIN, 1] : [nx, nx + MIN];
      if (ny2 - ny < MIN) [ny, ny2] = ny + MIN > 1 ? [1 - MIN, 1] : [ny, ny + MIN];
      onChange({ x: nx, y: ny, w: nx2 - nx, h: ny2 - ny });
      return;
    }
    if (d.handle === "move") {
      x = clamp(x + dx, 0, 1 - d.start.w);
      y = clamp(y + dy, 0, 1 - d.start.h);
      x2 = x + d.start.w;
      y2 = y + d.start.h;
    } else {
      if (d.handle.includes("w")) x = clamp(x + dx, 0, x2 - MIN);
      if (d.handle.includes("e")) x2 = clamp(x2 + dx, x + MIN, 1);
      if (d.handle.includes("n")) y = clamp(y + dy, 0, y2 - MIN);
      if (d.handle.includes("s")) y2 = clamp(y2 + dy, y + MIN, 1);
    }
    onChange({ x, y, w: x2 - x, h: y2 - y });
  }

  function end() {
    dragRef.current = null;
  }

  const pct = (v: number) => `${v * 100}%`;
  const dragProps = (handle: Handle) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => begin(e, handle),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  });

  const corner = "pointer-events-auto absolute h-4 w-4 rounded-[3px] border border-black/50 bg-white shadow-md";
  const edge = "pointer-events-auto absolute";
  const pill = "pointer-events-auto absolute rounded-full border border-black/40 bg-white shadow-md";

  const dim = "pointer-events-auto absolute cursor-crosshair bg-black/60";

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 select-none touch-none">
      {/* Dimmed area outside the crop */}
      <div {...dragProps("draw")} className={dim} style={{ left: 0, top: 0, width: "100%", height: pct(value.y) }} />
      <div
        {...dragProps("draw")}
        className={dim}
        style={{ left: 0, top: pct(value.y + value.h), width: "100%", height: pct(1 - value.y - value.h) }}
      />
      <div {...dragProps("draw")} className={dim} style={{ left: 0, top: pct(value.y), width: pct(value.x), height: pct(value.h) }} />
      <div
        {...dragProps("draw")}
        className={dim}
        style={{ left: pct(value.x + value.w), top: pct(value.y), width: pct(1 - value.x - value.w), height: pct(value.h) }}
      />

      {/* Crop box: interior drags to move */}
      <div
        {...dragProps("move")}
        className="pointer-events-auto absolute cursor-move border-2 border-white"
        style={{ left: pct(value.x), top: pct(value.y), width: pct(value.w), height: pct(value.h) }}
      >
        {/* rule-of-thirds guides */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-y-0 left-1/3 w-px bg-white/30" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-white/30" />
          <div className="absolute inset-x-0 top-1/3 h-px bg-white/30" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-white/30" />
        </div>
      </div>

      {/* Edge grab strips (full length, straddling the border) */}
      <div
        {...dragProps("n")}
        className={`${edge} h-5 cursor-ns-resize`}
        style={{ left: pct(value.x), width: pct(value.w), top: `calc(${pct(value.y)} - 10px)` }}
      />
      <div
        {...dragProps("s")}
        className={`${edge} h-5 cursor-ns-resize`}
        style={{ left: pct(value.x), width: pct(value.w), top: `calc(${pct(value.y + value.h)} - 10px)` }}
      />
      <div
        {...dragProps("w")}
        className={`${edge} w-5 cursor-ew-resize`}
        style={{ top: pct(value.y), height: pct(value.h), left: `calc(${pct(value.x)} - 10px)` }}
      />
      <div
        {...dragProps("e")}
        className={`${edge} w-5 cursor-ew-resize`}
        style={{ top: pct(value.y), height: pct(value.h), left: `calc(${pct(value.x + value.w)} - 10px)` }}
      />

      {/* Corner handles */}
      <div
        {...dragProps("nw")}
        className={`${corner} cursor-nwse-resize`}
        style={{ left: `calc(${pct(value.x)} - 8px)`, top: `calc(${pct(value.y)} - 8px)` }}
      />
      <div
        {...dragProps("ne")}
        className={`${corner} cursor-nesw-resize`}
        style={{ left: `calc(${pct(value.x + value.w)} - 8px)`, top: `calc(${pct(value.y)} - 8px)` }}
      />
      <div
        {...dragProps("sw")}
        className={`${corner} cursor-nesw-resize`}
        style={{ left: `calc(${pct(value.x)} - 8px)`, top: `calc(${pct(value.y + value.h)} - 8px)` }}
      />
      <div
        {...dragProps("se")}
        className={`${corner} cursor-nwse-resize`}
        style={{ left: `calc(${pct(value.x + value.w)} - 8px)`, top: `calc(${pct(value.y + value.h)} - 8px)` }}
      />

      {/* Edge handles: each side can be pulled on its own */}
      <div
        {...dragProps("n")}
        className={`${pill} h-2 w-9 cursor-ns-resize`}
        style={{ left: `calc(${pct(value.x + value.w / 2)} - 18px)`, top: `calc(${pct(value.y)} - 4px)` }}
      />
      <div
        {...dragProps("s")}
        className={`${pill} h-2 w-9 cursor-ns-resize`}
        style={{ left: `calc(${pct(value.x + value.w / 2)} - 18px)`, top: `calc(${pct(value.y + value.h)} - 4px)` }}
      />
      <div
        {...dragProps("w")}
        className={`${pill} h-9 w-2 cursor-ew-resize`}
        style={{ top: `calc(${pct(value.y + value.h / 2)} - 18px)`, left: `calc(${pct(value.x)} - 4px)` }}
      />
      <div
        {...dragProps("e")}
        className={`${pill} h-9 w-2 cursor-ew-resize`}
        style={{ top: `calc(${pct(value.y + value.h / 2)} - 18px)`, left: `calc(${pct(value.x + value.w)} - 4px)` }}
      />
    </div>
  );
}
