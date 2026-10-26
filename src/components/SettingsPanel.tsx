import { useEffect, useState, type ReactNode } from "react";
import {
  clearPlaybackCache,
  clearThumbnailCache,
  getCacheStats,
  rescanRoot,
  setLockPassword,
  type CacheStats,
} from "../lib/api";
import { formatBytes } from "../lib/format";
import { useGalleryStore } from "../stores/galleryStore";
import { FAVORITE_KEYS, useSettingsStore } from "../stores/settingsStore";
import { useThemeStore } from "../stores/themeStore";
import { Portal } from "./Portal";

const SEEK_STEP_OPTIONS = [5, 10, 15, 30];

/** Changing the lock-screen password (only a salted hash is kept, in data/lock.json). */
function LockPasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (next !== confirm) return setMsg({ ok: false, text: "The new passwords don't match" });
    setMsg(null);
    setBusy(true);
    try {
      await setLockPassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: "Password changed" });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }
  const field = "w-full rounded-control bg-card px-2.5 py-1.5 text-[12px] text-text-primary outline-none ring-1 ring-hairline-strong focus:ring-accent";
  return (
    <form
      className="flex flex-col gap-1.5 rounded-card bg-card/50 px-3 py-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input data-testid="lock-current" type="password" autoComplete="off" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
      <div className="flex gap-1.5">
        <input data-testid="lock-new" type="password" autoComplete="off" placeholder="New password (4+ characters)" value={next} onChange={(e) => setNext(e.target.value)} className={field} />
        <input data-testid="lock-confirm" type="password" autoComplete="off" placeholder="Repeat it" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
      </div>
      <div className="flex items-center justify-between">
        <span data-testid="lock-msg" className={`text-[11px] ${msg?.ok ? "text-emerald-400" : "text-red-400"}`}>
          {msg?.text}
        </span>
        <button
          data-testid="lock-save"
          type="submit"
          disabled={busy || !current || !next || !confirm}
          className="rounded-control bg-accent px-3 py-1 text-[11px] font-medium text-white disabled:opacity-40"
        >
          Change password
        </button>
      </div>
    </form>
  );
}

function Row({ label, action }: { label: string; action: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-[12px] text-text-secondary">{label}</span>
      {action}
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const bumpRefresh = useGalleryStore((s) => s.bumpRefresh);
  const seekStepSec = useSettingsStore((s) => s.seekStepSec);
  const resumePlayback = useSettingsStore((s) => s.resumePlayback);
  const setResumePlayback = useSettingsStore((s) => s.setResumePlayback);
  const favoriteKey = useSettingsStore((s) => s.favoriteKey);
  const setFavoriteKey = useSettingsStore((s) => s.setFavoriteKey);
  const setSeekStepSec = useSettingsStore((s) => s.setSeekStepSec);
  const rainAnimation = useSettingsStore((s) => s.rainAnimation);
  const setRainAnimation = useSettingsStore((s) => s.setRainAnimation);
  const rainFps = useSettingsStore((s) => s.rainFps);
  const setRainFps = useSettingsStore((s) => s.setRainFps);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  function refresh() {
    getCacheStats().then(setStats).catch(() => setStats(null));
  }

  useEffect(refresh, []);

  async function handleClearThumbnails() {
    setBusy("thumbs");
    try {
      await clearThumbnailCache();
      await rescanRoot();
      refresh();
      bumpRefresh();
    } finally {
      setBusy(null);
    }
  }

  async function handleClearPlayback() {
    setBusy("playback");
    try {
      await clearPlaybackCache();
      refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Portal>
    <div
      className="animate-fade-in fixed inset-x-0 top-9 bottom-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="sheet-surface animate-sheet-in max-h-[calc(100vh-80px)] w-[420px] overflow-y-auto rounded-sheet p-5"
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[15px] font-semibold text-text-primary">Settings</span>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            ✕
          </button>
        </div>

        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Appearance</div>
        <div className="mb-4 flex items-center justify-between rounded-card bg-card/50 px-3 py-2.5">
          <span className="text-[12px] text-text-secondary">Theme</span>
          <div className="flex gap-1">
            <button
              onClick={() => setTheme("dark")}
              className={`rounded-control px-3 py-1 text-[11px] transition-colors ${
                theme === "dark" ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
              }`}
            >
              Dark
            </button>
            <button
              onClick={() => setTheme("light")}
              className={`rounded-control px-3 py-1 text-[11px] transition-colors ${
                theme === "light" ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
              }`}
            >
              Light
            </button>
          </div>
        </div>
        <div className="mb-4 flex items-center justify-between rounded-card bg-card/50 px-3 py-2.5">
          <span className="text-[12px] text-text-secondary">Rain on the window</span>
          <div className="flex gap-1">
            {[
              { on: true, label: "On" },
              { on: false, label: "Off" },
            ].map((o) => (
              <button
                key={o.label}
                onClick={() => setRainAnimation(o.on)}
                className={`rounded-control px-3 py-1 text-[11px] transition-colors ${
                  rainAnimation === o.on ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {rainAnimation && (
          <div className="mb-4 flex items-center justify-between rounded-card bg-card/50 px-3 py-2.5">
            <span className="text-[12px] text-text-secondary" title="Lower is lighter on the computer (and on remote / streamed screens)">
              Rain smoothness
            </span>
            <div className="flex gap-1">
              {(
                [
                  [15, "Light · 15 fps"],
                  [30, "Normal · 30 fps"],
                  [60, "Smooth · 60 fps"],
                ] as const
              ).map(([fps, label]) => (
                <button
                  key={fps}
                  onClick={() => setRainFps(fps)}
                  className={`whitespace-nowrap rounded-control px-3 py-1 text-[11px] transition-colors ${
                    rainFps === fps ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Cache</div>
        <div className="flex flex-col divide-y divide-white/5 rounded-card bg-card/50 px-3">
          <Row
            label={`Thumbnail cache${stats ? ` · ${formatBytes(stats.thumbnailBytes)}` : ""}`}
            action={
              <button
                onClick={handleClearThumbnails}
                disabled={busy !== null}
                className="rounded-control bg-card px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary disabled:opacity-40"
              >
                {busy === "thumbs" ? "Clearing…" : "Clear"}
              </button>
            }
          />
          <Row
            label={`Playback conversion cache${stats ? ` · ${formatBytes(stats.playbackBytes)}` : ""}`}
            action={
              <button
                onClick={handleClearPlayback}
                disabled={busy !== null}
                className="rounded-control bg-card px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-card-hover hover:text-text-primary disabled:opacity-40"
              >
                {busy === "playback" ? "Clearing…" : "Clear"}
              </button>
            }
          />
        </div>

        <div className="mb-1 mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Playback</div>
        <div className="flex items-center justify-between rounded-card bg-card/50 px-3 py-2.5">
          <span className="text-[12px] text-text-secondary">Seek step (←/→ in viewer)</span>
          <div className="flex gap-1">
            {SEEK_STEP_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => setSeekStepSec(n)}
                className={`rounded-control px-2.5 py-1 text-[11px] transition-colors ${
                  seekStepSec === n ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
                }`}
              >
                {n}s
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between rounded-card bg-card/50 px-3 py-2.5">
          <span className="text-[12px] text-text-secondary">Reopening a video</span>
          <div className="flex gap-1">
            {[
              { on: true, label: "Continue where I left off" },
              { on: false, label: "Start from the beginning" },
            ].map((o) => (
              <button
                key={o.label}
                data-testid={`resume-${o.on ? "on" : "off"}`}
                onClick={() => setResumePlayback(o.on)}
                className={`rounded-control px-2.5 py-1 text-[11px] transition-colors ${
                  resumePlayback === o.on ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 rounded-card bg-card/50 px-3 py-2.5">
          <span className="text-[12px] text-text-secondary">Favorite key (in the viewer)</span>
          <div className="flex flex-wrap justify-end gap-1">
            {FAVORITE_KEYS.map((k) => (
              <button
                key={k.code}
                data-testid={`favkey-${k.code}`}
                onClick={() => setFavoriteKey(k.code)}
                className={`rounded-control px-2 py-1 text-[11px] transition-colors ${
                  favoriteKey === k.code ? "bg-accent text-white" : "bg-card text-text-secondary hover:bg-card-hover hover:text-text-primary"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-tertiary">
          ← / → seek inside a video. ↑ / ↓ (or PageUp / PageDown) go to the previous / next file — past the end of a page they
          continue on the next page. The favorite key toggles ♥ on the file being viewed.
        </p>

        <div className="mb-1 mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Lock password</div>
        <LockPasswordForm />

        <div className="mb-1 mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Privacy</div>
        <p className="text-[12px] leading-relaxed text-text-secondary">
          No telemetry, no analytics, no cloud account. Everything stays on this machine unless you explicitly enable
          LAN sharing.
        </p>

        <div className="mb-1 mt-4 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">About</div>
        <p className="text-[12px] text-text-secondary">Quin Gallery — local-first media gallery.</p>
      </div>
    </div>
    </Portal>
  );
}
