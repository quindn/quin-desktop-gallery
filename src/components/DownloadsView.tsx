import { useEffect, useState } from "react";
import {
  defaultDownloadDir,
  downloadCancel,
  downloadClearFinished,
  downloadRemove,
  downloadReveal,
  engineInfo,
  engineUpdate,
  pickDownloadFolder,
  type DownloadTask,
} from "../lib/online";
import { formatBytes } from "../lib/format";
import { useDownloadStore, useHandoffStore } from "../stores/webStores";
import { useGalleryStore } from "../stores/galleryStore";

function eta(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return "";
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s left` : `${s}s left`;
}

const STATUS: Record<DownloadTask["status"], { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "bg-white/10 text-text-secondary" },
  running: { label: "Downloading", cls: "bg-accent/25 text-accent" },
  done: { label: "Done", cls: "bg-emerald-500/20 text-emerald-300" },
  error: { label: "Failed", cls: "bg-red-500/20 text-red-300" },
  cancelled: { label: "Cancelled", cls: "bg-white/10 text-text-tertiary" },
};

function TaskCard({ task }: { task: DownloadTask }) {
  const play = useHandoffStore((s) => s.play);
  const setMainView = useGalleryStore((s) => s.setMainView);
  const start = useDownloadStore((s) => s.start);
  const st = STATUS[task.status];
  const active = task.status === "running" || task.status === "queued";

  return (
    <div className="glass flex flex-col gap-2.5 rounded-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-text-primary" title={task.title}>
            {task.title}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-text-tertiary" title={task.url}>
            {task.url}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${st.cls}`}>{st.label}</span>
      </div>

      {(active || task.status === "done") && (
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${task.status === "done" ? "bg-emerald-400" : "bg-gradient-to-r from-[#6673e0] to-[#a78bfa]"}`}
            style={{ width: `${Math.max(2, task.percent)}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-text-tertiary">
        {active && (
          <>
            <span className="tabular-nums">{task.percent.toFixed(1)}%</span>
            {task.speed ? <span className="tabular-nums">{formatBytes(task.speed)}/s</span> : null}
            {task.total ? (
              <span className="tabular-nums">
                {formatBytes(task.downloaded ?? 0)} / {formatBytes(task.total)}
              </span>
            ) : null}
            <span>{eta(task.eta)}</span>
          </>
        )}
        {task.status === "done" && task.verified === true && (
          <span className="shrink-0 text-emerald-400" title="Opens, plays to the end and matches the length of the source">
            ✓ Verified
          </span>
        )}
        {task.status === "done" && task.verified === false && (
          <span className="shrink-0 text-amber-400" title={task.warning ?? "The file failed the integrity check"}>
            ⚠ {task.warning ?? "Failed the integrity check"}
          </span>
        )}
        {task.status === "done" && task.file && <span className="truncate" title={task.file}>{task.file}</span>}
        {task.status === "error" && <span className="text-red-300">{task.error}</span>}
        <div className="flex-1" />
        {task.status === "done" && task.file && (
          <>
            <button onClick={() => void downloadReveal(task.file!)} className="rounded-control bg-card px-3 py-1 text-text-secondary hover:bg-card-hover hover:text-text-primary">
              Show in folder
            </button>
            <button
              onClick={() => {
                play(task.url, null, task.title);
                setMainView("online");
              }}
              className="rounded-control bg-card px-3 py-1 text-text-secondary hover:bg-card-hover hover:text-text-primary"
            >
              Play link
            </button>
          </>
        )}
        {active && (
          <button onClick={() => void downloadCancel(task.id)} className="rounded-control bg-card px-3 py-1 text-red-300 hover:bg-red-500/15">
            Cancel
          </button>
        )}
        {(task.status === "error" || task.status === "cancelled") && (
          <button
            onClick={() => {
              void downloadRemove(task.id);
              void start({ url: task.url, title: task.title });
            }}
            className="rounded-control bg-card px-3 py-1 text-text-secondary hover:bg-card-hover hover:text-text-primary"
          >
            Retry
          </button>
        )}
        {!active && (
          <button onClick={() => void downloadRemove(task.id)} className="rounded-control px-2 py-1 text-text-tertiary hover:text-text-primary">
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export function DownloadsView() {
  const tasks = useDownloadStore((s) => s.tasks);
  const dir = useDownloadStore((s) => s.dir);
  const setDir = useDownloadStore((s) => s.setDir);
  const [effectiveDir, setEffectiveDir] = useState("");
  const [engine, setEngine] = useState<{ ytdlp: string; ffmpeg: string } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [engineMsg, setEngineMsg] = useState<string | null>(null);

  useEffect(() => {
    if (dir) setEffectiveDir(dir);
    else defaultDownloadDir().then(setEffectiveDir).catch(() => {});
  }, [dir]);
  useEffect(() => {
    engineInfo().then(setEngine).catch(() => {});
  }, []);

  const sorted = [...tasks].sort((a, b) => b.started - a.started);
  const finished = tasks.filter((t) => !["running", "queued"].includes(t.status)).length;

  async function chooseFolder() {
    const picked = await pickDownloadFolder();
    if (picked) setDir(picked);
  }

  async function update() {
    setUpdating(true);
    setEngineMsg(null);
    try {
      setEngineMsg(await engineUpdate());
      setEngine(await engineInfo());
    } catch (e) {
      setEngineMsg(String(e));
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-8 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight text-text-primary">Downloads</h1>
            <p className="mt-1 text-[13px] text-text-tertiary">Everything you download from links and from the browser.</p>
          </div>
          {finished > 0 && (
            <button onClick={() => void downloadClearFinished()} className="rounded-control bg-card px-3 py-1.5 text-[12px] text-text-secondary hover:bg-card-hover hover:text-text-primary">
              Clear finished
            </button>
          )}
        </div>

        <div className="glass flex flex-wrap items-center gap-3 rounded-card p-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Save to</div>
            <div className="mt-0.5 truncate text-[13px] text-text-primary" title={effectiveDir}>
              {effectiveDir}
              {!dir && <span className="ml-2 text-text-tertiary">(inside your library, so it appears in the gallery)</span>}
            </div>
          </div>
          <button onClick={() => void chooseFolder()} className="rounded-control bg-card px-3 py-1.5 text-[12px] text-text-secondary hover:bg-card-hover hover:text-text-primary">
            Change…
          </button>
          {dir && (
            <button onClick={() => setDir(null)} className="rounded-control px-3 py-1.5 text-[12px] text-text-tertiary hover:text-text-primary">
              Reset
            </button>
          )}
        </div>

        {sorted.length === 0 ? (
          <div className="glass flex flex-col items-center gap-2 rounded-card px-6 py-14 text-center">
            <div className="text-[15px] font-medium text-text-primary">No downloads yet</div>
            <div className="max-w-sm text-[13px] text-text-tertiary">
              Paste a link in <b>Open a link</b>, or browse in the <b>Browser</b> — videos found on a page can be downloaded in one click.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {sorted.map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
          </div>
        )}

        <div className="glass flex flex-wrap items-center gap-3 rounded-card p-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Video engine</div>
            <div className="mt-0.5 text-[13px] text-text-secondary">
              yt-dlp {engine?.ytdlp || "…"} · FFmpeg {engine?.ffmpeg || "…"}
            </div>
            {engineMsg && <div className="mt-1 text-[12px] text-text-tertiary">{engineMsg}</div>}
          </div>
          <button
            onClick={() => void update()}
            disabled={updating}
            className="rounded-control bg-card px-3 py-1.5 text-[12px] text-text-secondary hover:bg-card-hover hover:text-text-primary disabled:opacity-50"
          >
            {updating ? "Updating…" : "Update yt-dlp"}
          </button>
        </div>
      </div>
    </div>
  );
}
