import { useEffect, useState } from "react";
import {
  getLanQrCode,
  getLanStatus,
  listLanInterfaces,
  startLanServer,
  stopLanServer,
  type LanStatus,
} from "../lib/api";
import { Portal } from "./Portal";

export function LanPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [selectedIp, setSelectedIp] = useState("");
  const [permission, setPermission] = useState<"view" | "download">("view");
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listLanInterfaces().then((ifaces) => {
      setInterfaces(ifaces);
      if (ifaces.length) setSelectedIp(ifaces[0]);
    });
    getLanStatus().then(setStatus);
  }, []);

  useEffect(() => {
    if (status?.running && status.url) {
      getLanQrCode(status.url).then(setQr).catch(() => setQr(null));
    } else {
      setQr(null);
    }
  }, [status?.running, status?.url]);

  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(() => {
      getLanStatus().then(setStatus).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [status?.running]);

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const s = await startLanServer(selectedIp, permission, null);
      setStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      await stopLanServer();
      setStatus(await getLanStatus());
    } finally {
      setBusy(false);
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
        className="sheet-surface animate-sheet-in w-[440px] rounded-sheet p-5"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[15px] font-semibold text-text-primary">LAN Sharing</span>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            ✕
          </button>
        </div>
        <p className="mb-4 text-[12px] text-text-secondary">
          Browse and stream this gallery from another device on your network. Off by default; nothing leaves your
          LAN.
        </p>

        {!status?.running ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                Network Interface
              </div>
              <select
                value={selectedIp}
                onChange={(e) => setSelectedIp(e.target.value)}
                className="w-full rounded-control bg-card px-2 py-1.5 text-[12px] text-text-primary outline-none"
              >
                {interfaces.map((ip) => (
                  <option key={ip} value={ip}>
                    {ip}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                Permission
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => setPermission("view")}
                  className={`flex-1 rounded-control px-2 py-1.5 text-[12px] ${permission === "view" ? "bg-accent text-white" : "bg-card text-text-secondary"}`}
                >
                  View Only
                </button>
                <button
                  onClick={() => setPermission("download")}
                  className={`flex-1 rounded-control px-2 py-1.5 text-[12px] ${permission === "download" ? "bg-accent text-white" : "bg-card text-text-secondary"}`}
                >
                  View + Download
                </button>
              </div>
            </div>
            {error && <p className="text-[12px] text-red-400">{error}</p>}
            <button
              onClick={handleStart}
              disabled={busy || !selectedIp}
              className="rounded-control bg-accent px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
            >
              {busy ? "Starting…" : "Start LAN Server"}
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            {qr && <img src={qr} alt="LAN QR code" className="h-40 w-40 rounded-card bg-white p-2" />}
            <div className="w-full rounded-control bg-card px-2 py-1.5 text-center text-[12px] text-text-primary">
              {status.url}
            </div>
            <p className="text-[11px] text-text-tertiary">
              Permission: {status.permission === "download" ? "View + Download" : "View Only"}
            </p>

            {status.connectedClients.length > 0 && (
              <div className="w-full">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  Connected Clients
                </div>
                <div className="flex flex-col gap-1">
                  {status.connectedClients.map((c) => (
                    <div key={c.ip} className="rounded-control bg-card px-2 py-1 text-[11px] text-text-secondary">
                      {c.ip}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={handleStop}
              disabled={busy}
              className="w-full rounded-control bg-red-500/15 px-3 py-2 text-[12px] font-medium text-red-400 disabled:opacity-50"
            >
              Stop LAN Server
            </button>
          </div>
        )}
      </div>
    </div>
    </Portal>
  );
}
