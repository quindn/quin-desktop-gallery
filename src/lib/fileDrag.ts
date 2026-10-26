import { invoke } from "@tauri-apps/api/core";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useGalleryStore } from "../stores/galleryStore";

// Dragging library items out of the app as real files: press on a card and move the mouse a
// little — the selected items (or just this one) become an OS drag that can be dropped on a web
// page, a chat, Explorer or any app that accepts files.

const THRESHOLD = 6;
let dragging = false;
/** Clicks right after a drag ends must not select / open anything. */
let suppressUntil = 0;

export const clickSuppressed = () => Date.now() < suppressUntil;

/** The ids a drag from item `id` carries: the whole selection when `id` is part of it. */
function idsFor(id: number): number[] {
  const sel = useGalleryStore.getState().selectedIds;
  return sel.has(id) ? [...sel] : [id];
}

/** Starts the OS drag for these media ids now (the mouse button must still be down). */
export async function dragFilesOut(ids: number[]): Promise<string> {
  if (dragging || ids.length === 0) return "busy";
  dragging = true;
  try {
    (window as unknown as { __qgLastDrag?: unknown }).__qgLastDrag = { ids, at: Date.now() };
    return await invoke<string>("start_file_drag", { ids });
  } catch {
    return "failed";
  } finally {
    dragging = false;
    suppressUntil = Date.now() + 300;
  }
}

/** Wire to a card's / row's onPointerDown. */
export function beginPossibleFileDrag(id: number, e: ReactPointerEvent) {
  if (e.button !== 0 || e.pointerType === "touch") return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => {
    if ((ev.buttons & 1) === 0) return done();
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
    done();
    void dragFilesOut(idsFor(id));
  };
  const done = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", done);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", done);
}

/** Puts the files on the clipboard (Explorer-style Copy). Resolves to how many were copied. */
export function copyFilesToClipboard(ids: number[]): Promise<number> {
  return invoke<number>("copy_files_to_clipboard", { ids });
}
