// Seeking a <video> is not free: the decoder has to restart from the nearest
// keyframe, and clips with a long keyframe interval take a noticeable moment
// to land. Firing a new seek for every key repeat or slider tick aborts the
// previous one before it finishes, so nothing ever settles and playback
// stutters. This keeps at most one seek in flight, remembers only the latest
// wanted position, and applies it as soon as the current seek completes.

interface SeekState {
  pending: number | null;
}

const states = new WeakMap<HTMLVideoElement, SeekState>();

function stateFor(video: HTMLVideoElement): SeekState {
  let s = states.get(video);
  if (!s) {
    s = { pending: null };
    const state = s;
    video.addEventListener("seeked", () => flush(video, state));
    states.set(video, s);
  }
  return s;
}

function flush(video: HTMLVideoElement, s: SeekState) {
  if (s.pending === null || video.seeking) return;
  const t = s.pending;
  s.pending = null;
  video.currentTime = t;
}

function clampTime(video: HTMLVideoElement, t: number): number {
  const max = Number.isFinite(video.duration) ? video.duration : Infinity;
  return Math.min(Math.max(0, t), max);
}

/** Seeks to `time` seconds, coalescing rapid calls. */
export function seekTo(video: HTMLVideoElement, time: number) {
  const s = stateFor(video);
  s.pending = clampTime(video, time);
  flush(video, s);
}

/** Seeks `delta` seconds from where the user is heading (not from where the decoder currently is). */
export function seekBy(video: HTMLVideoElement, delta: number) {
  const s = stateFor(video);
  seekTo(video, (s.pending ?? video.currentTime) + delta);
}
