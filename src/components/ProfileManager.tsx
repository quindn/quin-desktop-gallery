import { useCallback, useEffect, useState } from "react";
import {
  browserOpen,
  browserProfileClear,
  browserProfileCreate,
  browserProfileDelete,
  browserProfileRename,
  browserProfiles,
  browserHideAll,
  browserRestoreSession,
  browserActivate,
  type BrowserProfile,
} from "../lib/online";
import { formatBytes } from "../lib/format";
import { useBrowserSettings, useBrowserStore } from "../stores/webStores";

const COLORS = ["#6673e0", "#a78bfa", "#34d399", "#f59e0b", "#f472b6", "#38bdf8", "#f87171", "#84cc16"];

function ago(ms: number): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function Avatar({ profile, size = 56 }: { profile: { name: string; color: string }; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white shadow-md"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${profile.color}, ${profile.color}aa)`, fontSize: size * 0.42 }}
    >
      {(profile.name.trim()[0] ?? "?").toUpperCase()}
    </div>
  );
}

/** Opens a profile in the browser: its running tabs, its saved session, or a fresh new-tab page. */
export async function openProfile(id: string, opts: { private?: boolean } = {}) {
  const store = useBrowserStore.getState();
  store.setProfile(id);
  if (opts.private) {
    const tab = await browserOpen(id, "", true);
    store.setActive(tab);
    return;
  }
  const mine = useBrowserStore.getState().tabs.filter((t) => t.profile === id && !t.private);
  if (mine.length) {
    const keep = mine.find((t) => t.id === useBrowserStore.getState().activeId) ?? mine[mine.length - 1];
    store.setActive(keep.id);
    void browserActivate(keep.id);
    return;
  }
  if (useBrowserSettings.getState().settings.restoreTabs) {
    const restored = await browserRestoreSession(id);
    if (restored.ids.length) {
      const pick = restored.ids[Math.min(restored.active, restored.ids.length - 1)];
      store.setActive(pick);
      await browserActivate(pick);
      return;
    }
  }
  store.setActive(await browserOpen(id, ""));
}

export function ProfileManager() {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[1]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirm, setConfirm] = useState<{ id: string; kind: "delete" | "clear" } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => setProfiles(await browserProfiles()), []);
  useEffect(() => {
    // the native browser view would sit on top of this screen
    void browserHideAll();
    void reload();
  }, [reload]);

  async function create() {
    const n = name.trim();
    if (!n) return;
    const p = await browserProfileCreate(n, color);
    setName("");
    setColor(COLORS[(COLORS.indexOf(color) + 1) % COLORS.length]);
    await reload();
    setNote(`Profile "${p.name}" created: its cookies, logins and history are kept apart from the others.`);
  }

  async function open(id: string, priv = false) {
    setBusy(id);
    try {
      await openProfile(id, { private: priv });
    } finally {
      setBusy(null);
    }
  }

  async function doConfirm() {
    if (!confirm) return;
    try {
      if (confirm.kind === "delete") await browserProfileDelete(confirm.id);
      else await browserProfileClear(confirm.id);
      setNote(confirm.kind === "delete" ? "Profile deleted with all its data." : "Browsing data cleared.");
    } catch (e) {
      setNote(String(e));
    }
    setConfirm(null);
    await reload();
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto flex max-w-[980px] flex-col gap-6">
        <div>
          <h1 className="text-[22px] font-semibold text-text-primary">Who is browsing?</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
            Every profile is a separate browser: its own cookies, logins, history, bookmarks and tabs. Use one per account or per project. All of it is stored in the
            <span className="mx-1 rounded bg-white/10 px-1.5 py-0.5 text-[12px]">data/browser</span>
            folder next to Quin Gallery, so it moves with the app.
          </p>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {profiles.map((p) => (
            <div key={p.id} className="glass flex flex-col gap-3 rounded-card border border-hairline p-4">
              <div className="flex items-center gap-3">
                <Avatar profile={p} />
                <div className="min-w-0 flex-1">
                  {renaming === p.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter") {
                          await browserProfileRename(p.id, renameValue || p.name);
                          setRenaming(null);
                          await reload();
                        } else if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => setRenaming(null)}
                      className="w-full rounded-control bg-card px-2 py-1 text-[14px] text-text-primary outline-none ring-1 ring-accent"
                    />
                  ) : (
                    <div className="truncate text-[15px] font-semibold text-text-primary" title={p.name}>
                      {p.name}
                    </div>
                  )}
                  <div className="mt-0.5 text-[11.5px] text-text-tertiary">
                    {p.tabs > 0 ? `${p.tabs} tab${p.tabs > 1 ? "s" : ""} open · ` : ""}
                    {p.bookmarks} bookmark{p.bookmarks === 1 ? "" : "s"} · {formatBytes(p.size)}
                  </div>
                  <div className="text-[11px] text-text-tertiary">Used {ago(p.lastUsed)}</div>
                </div>
              </div>

              {confirm?.id === p.id ? (
                <div className="flex flex-col gap-2 rounded-control bg-red-500/10 p-3 text-[12px] text-red-200">
                  {confirm.kind === "delete"
                    ? "Delete this profile? Its tabs close and its cookies, logins, history and bookmarks are erased for good."
                    : "Clear cookies, cache and history of this profile? Bookmarks stay."}
                  <div className="flex gap-2">
                    <button onClick={() => setConfirm(null)} className="flex-1 rounded-control bg-white/10 px-2 py-1.5 text-text-primary hover:bg-white/15">
                      Cancel
                    </button>
                    <button onClick={() => void doConfirm()} className="flex-1 rounded-control bg-red-500/80 px-2 py-1.5 font-medium text-white hover:bg-red-500">
                      {confirm.kind === "delete" ? "Delete" : "Clear"}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <button
                      disabled={busy === p.id}
                      onClick={() => void open(p.id)}
                      className="flex-1 rounded-control bg-accent px-3 py-2 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {busy === p.id ? "Opening…" : p.tabs > 0 ? "Continue" : "Open"}
                    </button>
                    <button
                      onClick={() => void open(p.id, true)}
                      title="A private tab: nothing is kept when it closes"
                      className="rounded-control bg-white/10 px-3 py-2 text-[12.5px] text-text-primary hover:bg-white/15"
                    >
                      Private
                    </button>
                  </div>
                  <div className="flex flex-col gap-2 text-[11.5px]">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setRenaming(p.id);
                          setRenameValue(p.name);
                        }}
                        className="whitespace-nowrap rounded-control px-2 py-1 text-text-secondary hover:bg-white/10 hover:text-text-primary"
                      >
                        Rename
                      </button>
                      <button onClick={() => setConfirm({ id: p.id, kind: "clear" })} className="whitespace-nowrap rounded-control px-2 py-1 text-text-secondary hover:bg-white/10 hover:text-text-primary">
                        Clear data
                      </button>
                      <span className="flex-1" />
                      <button
                        disabled={profiles.length <= 1}
                        title={profiles.length <= 1 ? "Keep at least one profile: add another one first" : "Delete this profile"}
                        onClick={() => setConfirm({ id: p.id, kind: "delete" })}
                        className="whitespace-nowrap rounded-control px-2 py-1 text-red-300 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:text-text-tertiary disabled:hover:bg-transparent"
                      >
                        Delete
                      </button>
                    </div>
                    <div className="flex items-center gap-2 px-1">
                      <span className="text-text-tertiary">Colour</span>
                      <div className="flex items-center gap-1.5">
                        {COLORS.map((c) => (
                          <button
                            key={c}
                            aria-label={`Colour ${c}`}
                            onClick={async () => {
                              await browserProfileRename(p.id, p.name, c);
                              await reload();
                            }}
                            className={`h-3.5 w-3.5 rounded-full transition-transform hover:scale-125 ${p.color === c ? "ring-2 ring-white/80 ring-offset-1 ring-offset-black/30" : ""}`}
                            style={{ background: c }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}

          <div className="flex flex-col gap-3 rounded-card border border-dashed border-white/20 bg-white/[0.03] p-4">
            <div className="text-[14px] font-semibold text-text-primary">Add a profile</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              placeholder="Name (Work, Shop, Social…)"
              className="rounded-control bg-card px-3 py-2 text-[13px] text-text-primary outline-none ring-1 ring-hairline placeholder:text-text-tertiary focus:ring-accent"
            />
            <div className="flex items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  aria-label={`Colour ${c}`}
                  onClick={() => setColor(c)}
                  className={`h-6 w-6 rounded-full transition-transform hover:scale-110 ${color === c ? "ring-2 ring-white/90" : ""}`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <button
              disabled={!name.trim()}
              onClick={() => void create()}
              className="rounded-control bg-white/10 px-3 py-2 text-[12.5px] font-semibold text-text-primary transition-colors hover:bg-white/15 disabled:opacity-40"
            >
              + Create profile
            </button>
          </div>
        </div>
        {note && <div className="rounded-control bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-300">{note}</div>}
      </div>
    </div>
  );
}
