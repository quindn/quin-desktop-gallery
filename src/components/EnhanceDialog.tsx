import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { cancelEditJob } from "../lib/api";
import { aiEnhance, aiInstall, aiSourceInfo, aiStatus, useEnhance, type AiOptions, type AiSourceInfo, type AiStatus } from "../lib/ai";
import { formatDuration } from "../lib/format";
import { Portal } from "./Portal";

// "AI Enhance": smoother motion (real in-between frames from RIFE) or a sharper picture (Real-ESRGAN).
// The result is a new file next to the original; the original is never changed.

const SIZE_MB = { rife: 22, esrgan: 9 };

function Choice({ active, onClick, children, testId, disabled }: { active: boolean; onClick: () => void; children: ReactNode; testId?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`flex-1 rounded-control px-3 py-2 text-left text-[12px] transition-colors disabled:opacity-35 ${
        active ? "bg-accent text-white" : "bg-white/[0.06] text-text-secondary hover:bg-white/10 hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function fmtMin(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

/** Rough time on a GTX 1050 Ti–class card (measured), only as a hint before starting. */
function estimateSec(info: AiSourceInfo, o: AiOptions): number {
  const secs = info.durationMs / 1000;
  const px = info.width * info.height;
  if (o.mode === "smooth") {
    const outFrames = info.frames * o.factor;
    const rate = (o.quality === "best" ? 16e6 : 22e6) / px; // output frames per second
    return outFrames / rate + secs * 0.2;
  }
  const target = o.upscale ? px * 4 : px;
  const toolIn = target / 4;
  const inRate = o.content === "anime" ? 1.0e6 : 0.55e6; // tool input pixels per second
  return (info.frames * toolIn) / inRate + secs * 0.3;
}

export function EnhanceDialog() {
  const item = useEnhance((s) => s.item);
  const close = useEnhance((s) => s.close);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [info, setInfo] = useState<AiSourceInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [opts, setOpts] = useState<AiOptions>({ mode: "smooth", factor: 2, quality: "best", content: "real", upscale: false });
  const [installing, setInstalling] = useState<{ tool: string; done: number; total: number } | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [job, setJob] = useState<{ id: string; pct: number; status: "running" | "done" | "error"; out: string; error?: string; started: number } | null>(null);
  const jobRef = useRef(job);
  jobRef.current = job;
  const [, tick] = useState(0);

  useEffect(() => {
    if (!item) return;
    setInfo(null);
    setInfoError(null);
    setJob(null);
    setInstallError(null);
    void aiStatus().then(setStatus);
    aiSourceInfo(item.id)
      .then((i) => {
        setInfo(i);
        // aim for about 60 fps
        setOpts((o) => ({ ...o, factor: Math.min(4, Math.max(2, Math.round(60 / i.fps))) }));
      })
      .catch((e) => setInfoError(String(e)));
  }, [item]);

  useEffect(() => {
    const a = listen<{ tool: string; done: number; total: number }>("ai://install", (e) => setInstalling(e.payload));
    const b = listen<{ job_id: string; percent: number }>("edit://progress", (e) => setJob((j) => (j && j.id === e.payload.job_id ? { ...j, pct: e.payload.percent } : j)));
    const c = listen<{ job_id: string; success: boolean; output_path?: string; error?: string }>("edit://done", (e) =>
      setJob((j) => (j && j.id === e.payload.job_id ? { ...j, pct: 100, status: e.payload.success ? "done" : "error", out: e.payload.output_path ?? j.out, error: e.payload.error } : j)),
    );
    return () => {
      for (const p of [a, b, c]) void p.then((f) => f());
    };
  }, []);

  // the elapsed / remaining time keeps counting between progress events
  useEffect(() => {
    if (job?.status !== "running") return;
    const t = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [job?.status]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && jobRef.current?.status !== "running") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, close]);

  if (!item) return null;
  const tool = opts.mode === "smooth" ? "rife" : "esrgan";
  const haveTool = status ? status[tool] : false;
  const noGpu = status !== null && status.rife && !status.gpu;
  const sharpenBlocked = opts.mode === "sharpen" && noGpu;
  const running = job?.status === "running";
  const outSize = info
    ? opts.mode === "smooth" || !opts.upscale
      ? `${info.width}×${info.height}`
      : (() => {
          const cap = Math.min(1, 3840 / (2 * Math.max(info.width, info.height)));
          return `${Math.round(info.width * 2 * cap)}×${Math.round(info.height * 2 * cap)}`;
        })()
    : "";
  const elapsed = job ? (Date.now() - job.started) / 1000 : 0;
  const eta = job && job.pct > 2 ? (elapsed / job.pct) * (100 - job.pct) : NaN;

  const install = async () => {
    setInstallError(null);
    setInstalling({ tool, done: 0, total: 1 });
    try {
      setStatus(await aiInstall(tool));
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(null);
    }
  };
  const start = async () => {
    try {
      const r = await aiEnhance(item.id, opts);
      setJob({ id: r.jobId, pct: 0, status: "running", out: r.outputPath, started: Date.now() });
    } catch (e) {
      setJob({ id: "", pct: 0, status: "error", out: "", error: String(e), started: Date.now() });
    }
  };

  return (
    <Portal>
      <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/60" onClick={() => !running && close()}>
        <div data-testid="enhance-dialog" onClick={(e) => e.stopPropagation()} className="w-[520px] max-w-[94vw] rounded-card border border-white/10 bg-[#15151c] p-5 text-text-primary shadow-2xl">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">AI Enhance</h2>
            <button onClick={() => !running && close()} className="text-text-tertiary hover:text-text-primary" aria-label="Close">
              ✕
            </button>
          </div>
          <p className="mb-4 truncate text-[11.5px] text-text-tertiary" title={item.filename}>
            {item.filename}
            {info && ` · ${info.width}×${info.height} · ${Number(info.fps.toFixed(2))} fps · ${formatDuration(info.durationMs)}`}
          </p>
          {infoError && <p className="mb-3 text-[12px] text-red-300">{infoError}</p>}

          <div className="mb-3 flex gap-2">
            <Choice testId="ai-mode-smooth" active={opts.mode === "smooth"} disabled={running} onClick={() => setOpts({ ...opts, mode: "smooth" })}>
              <b className="block text-[12.5px]">Smoother motion</b>
              <span className="opacity-75">Real in-between frames (RIFE)</span>
            </Choice>
            <Choice testId="ai-mode-sharpen" active={opts.mode === "sharpen"} disabled={running} onClick={() => setOpts({ ...opts, mode: "sharpen" })}>
              <b className="block text-[12.5px]">Sharper picture</b>
              <span className="opacity-75">Restores detail (Real-ESRGAN)</span>
            </Choice>
          </div>

          {opts.mode === "smooth" ? (
            <div className="flex flex-col gap-2">
              <span className="text-[11px] text-text-tertiary">Frames</span>
              <div className="flex gap-2">
                {[2, 3, 4].map((m) => (
                  <Choice key={m} testId={`ai-factor-${m}`} active={opts.factor === m} disabled={running} onClick={() => setOpts({ ...opts, factor: m })}>
                    <b>{m}×</b> {info && <span className="opacity-75">→ {Math.round(info.fps * m)} fps</span>}
                  </Choice>
                ))}
              </div>
              <span className="mt-1 text-[11px] text-text-tertiary">Model</span>
              <div className="flex gap-2">
                <Choice testId="ai-quality-best" active={opts.quality === "best"} disabled={running} onClick={() => setOpts({ ...opts, quality: "best" })}>
                  <b>Best</b> <span className="opacity-75">RIFE 4.26</span>
                </Choice>
                <Choice testId="ai-quality-fast" active={opts.quality === "fast"} disabled={running} onClick={() => setOpts({ ...opts, quality: "fast" })}>
                  <b>Faster</b> <span className="opacity-75">RIFE 4.6, ~35% quicker</span>
                </Choice>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="text-[11px] text-text-tertiary">The video is</span>
              <div className="flex gap-2">
                <Choice testId="ai-content-real" active={opts.content === "real"} disabled={running} onClick={() => setOpts({ ...opts, content: "real" })}>
                  <b>Real footage</b> <span className="opacity-75">camera, phone</span>
                </Choice>
                <Choice testId="ai-content-anime" active={opts.content === "anime"} disabled={running} onClick={() => setOpts({ ...opts, content: "anime" })}>
                  <b>Anime / cartoon</b> <span className="opacity-75">faster</span>
                </Choice>
              </div>
              <span className="mt-1 text-[11px] text-text-tertiary">Size</span>
              <div className="flex gap-2">
                <Choice testId="ai-size-same" active={!opts.upscale} disabled={running} onClick={() => setOpts({ ...opts, upscale: false })}>
                  <b>Same size, sharper</b>
                </Choice>
                <Choice testId="ai-size-2x" active={opts.upscale} disabled={running} onClick={() => setOpts({ ...opts, upscale: true })}>
                  <b>2× bigger</b> <span className="opacity-75">(up to 4K)</span>
                </Choice>
              </div>
            </div>
          )}

          <div className="mt-4 rounded-control bg-white/[0.04] p-3 text-[11.5px] leading-relaxed text-text-secondary">
            {info && (
              <div>
                Result: <b className="text-text-primary">{outSize}</b>
                {opts.mode === "smooth" && (
                  <>
                    , <b className="text-text-primary">{Math.round(info.fps * opts.factor)} fps</b>
                  </>
                )}
                , with the original sound — saved as a new file next to the original.
              </div>
            )}
            {status?.gpu && <div>Runs on: {status.gpu}</div>}
            {noGpu && opts.mode === "smooth" && <div className="text-amber-300">No Vulkan graphics card was found: this runs on the processor and is very slow.</div>}
            {sharpenBlocked && <div className="text-red-300">Sharpening needs a graphics card with Vulkan, and none was found.</div>}
            {info && haveTool && !sharpenBlocked && <div>Rough time: about {fmtMin(estimateSec(info, opts))} (on a GTX 1050 Ti–class card)</div>}
          </div>

          {status && !haveTool && (
            <div className="mt-3 flex items-center gap-3 rounded-control border border-white/10 p-3 text-[11.5px]">
              <div className="flex-1 text-text-secondary">
                {tool === "rife" ? "RIFE" : "Real-ESRGAN"} isn't downloaded yet (about {SIZE_MB[tool]} MB, once; kept in the data folder).
                {installing && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-accent transition-all" style={{ width: `${(installing.done / Math.max(1, installing.total)) * 100}%` }} />
                  </div>
                )}
                {installError && <div className="mt-1 text-red-300">{installError}</div>}
              </div>
              <button data-testid="ai-install" disabled={!!installing} onClick={() => void install()} className="rounded-control bg-accent px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
                {installing ? "Downloading…" : "Download"}
              </button>
            </div>
          )}

          {job && (
            <div className="mt-3 text-[11.5px]" data-testid="ai-job">
              {job.status === "running" && (
                <>
                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-accent transition-all" style={{ width: `${job.pct}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-text-tertiary">
                    <span>
                      {Math.floor(job.pct)}% · {fmtMin(elapsed)} so far
                    </span>
                    <span>{Number.isFinite(eta) ? `about ${fmtMin(eta)} left` : "measuring…"}</span>
                  </div>
                </>
              )}
              {job.status === "done" && (
                <div data-testid="ai-done" className="text-emerald-300">
                  Done: {job.out.split(/[\\/]/).pop()} (it shows up in the library by itself)
                </div>
              )}
              {job.status === "error" && <div className="text-red-300">{job.error === "cancelled" ? "Cancelled." : `Failed: ${job.error}`}</div>}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            {running ? (
              <button onClick={() => void cancelEditJob(job!.id)} className="rounded-control bg-white/10 px-4 py-1.5 text-[12px] hover:bg-white/15">
                Cancel
              </button>
            ) : (
              <>
                <button onClick={close} className="rounded-control bg-white/10 px-4 py-1.5 text-[12px] hover:bg-white/15">
                  Close
                </button>
                <button
                  data-testid="ai-start"
                  disabled={!info || !haveTool || sharpenBlocked}
                  onClick={() => void start()}
                  className="rounded-control bg-accent px-4 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
                >
                  {job?.status === "done" ? "Make another" : "Start"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
