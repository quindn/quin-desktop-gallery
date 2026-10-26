import { useCallback, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getThumbnailPaths } from "../lib/api";

// Thumbnail URLs live in a plain Map with per-id subscriptions instead of one
// big zustand object. The old store copied the whole `urls` object on every
// update — thousands of `thumbnail://ready` events against an ever-growing
// map (quadratic work), and every update woke every card. Now an update
// touches exactly one entry and notifies only the card showing that id.

/** undefined = never requested, null = requested but not ready/failed, string = loadable URL */
const urls = new Map<number, string | null>();
const listeners = new Map<number, Set<() => void>>();
const queued = new Set<number>();
let flushTimer: number | undefined;
/** Bumped on `clearThumbnails` so replies for the previous root are ignored. */
let epoch = 0;

const BATCH = 200;

function notify(id: number) {
  const set = listeners.get(id);
  if (set) for (const l of [...set]) l();
}

function setUrl(id: number, value: string | null) {
  if (urls.get(id) === value) return;
  urls.set(id, value);
  notify(id);
}

function flush() {
  flushTimer = undefined;
  const ids = [...queued];
  queued.clear();
  const myEpoch = epoch;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    getThumbnailPaths(chunk)
      .then((results) => {
        if (myEpoch !== epoch) return;
        for (const [id, path] of results) {
          // else: still generating in the background — the thumbnail://ready
          // event (wired up once in App.tsx) fills it in when done.
          if (path) setUrl(id, convertFileSrc(path));
        }
      })
      .catch(() => {
        if (myEpoch !== epoch) return;
        // Allow a later render to ask again.
        for (const id of chunk) if (urls.get(id) === null) urls.delete(id);
      });
  }
}

/** Asks for a thumbnail. Requests made in the same tick (a whole page mounting) go out as one call. */
export function requestThumbnail(id: number) {
  if (urls.has(id)) return; // already requested or resolved
  urls.set(id, null);
  queued.add(id);
  if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 8);
}

export function setThumbReady(id: number, path: string) {
  // Only ids something asked for: a sweep can finish tens of thousands of
  // thumbnails nobody is looking at.
  if (!urls.has(id)) return;
  setUrl(id, convertFileSrc(path));
}

export function setThumbFailed(id: number) {
  if (!urls.has(id)) return;
  setUrl(id, null);
}

/** Ids are only unique within one root's own database — call this on
 * root switch so a stale thumbnail never briefly shows under a
 * collided id from the previous library. */
export function clearThumbnails() {
  epoch++;
  const ids = [...listeners.keys()];
  urls.clear();
  queued.clear();
  for (const id of ids) notify(id);
}

export function useThumbUrl(id: number): string | null | undefined {
  const subscribe = useCallback(
    (cb: () => void) => {
      const set = listeners.get(id) ?? new Set<() => void>();
      listeners.set(id, set);
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(id);
      };
    },
    [id],
  );
  return useSyncExternalStore(subscribe, () => urls.get(id));
}
