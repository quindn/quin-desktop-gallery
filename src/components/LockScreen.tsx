import { useEffect, useRef, useState, type FormEvent } from "react";
import { lockStatus, setLockPassword, verifyPassword } from "../lib/api";
import { useLockStore } from "../stores/lockStore";

const MAX_TRIES = 5;
const COOLDOWN_MS = 30_000;

export function LockScreen() {
  const unlock = useLockStore((s) => s.unlock);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [tries, setTries] = useState(0);
  const [coolUntil, setCoolUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  // A fresh install has no password yet: the screen asks to choose one (kept hashed in data/lock.json).
  // null until the backend says which (the form waits, so typing never lands in the wrong mode)
  const [creating, setCreating] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState("");
  useEffect(() => {
    lockStatus()
      .then((s) => setCreating(!s.hasPassword))
      .catch(() => setCreating(false));
  }, []);

  // Ready to type as soon as the window appears (launch, or back from the tray).
  useEffect(() => {
    inputRef.current?.focus();
    const refocus = () => inputRef.current?.focus();
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, []);

  useEffect(() => {
    if (coolUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [coolUntil]);

  const cooling = coolUntil > now;
  const secondsLeft = Math.max(0, Math.ceil((coolUntil - now) / 1000));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (creating === null) return;
    if (creating) {
      if (value.length < 4) return setError("Use at least 4 characters");
      if (value !== confirm) return setError("The two passwords don't match");
      try {
        await setLockPassword(null, value);
        unlock();
      } catch (err) {
        setError(String(err));
      }
      return;
    }
    if (cooling || !value) return;
    let ok = false;
    try {
      ok = await verifyPassword(value);
    } catch {
      ok = false;
    }
    if (ok) {
      unlock();
      return;
    }
    setValue("");
    setShake((n) => n + 1);
    const attempts = tries + 1;
    if (attempts >= MAX_TRIES) {
      setTries(0);
      setCoolUntil(Date.now() + COOLDOWN_MS);
      setNow(Date.now());
      setError("Too many attempts");
    } else {
      setTries(attempts);
      setError("Wrong password");
    }
    inputRef.current?.focus();
  }

  if (creating === null) return <div className="flex-1" data-lock-mode="loading" />;

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <form
        key={shake}
        onSubmit={submit}
        data-lock-mode={creating ? "create" : "unlock"}
        className={`sheet-surface flex w-[320px] flex-col items-center gap-4 rounded-sheet px-7 py-8 ${shake ? "animate-shake" : "animate-fade-in"}`}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
            <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
          </svg>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="text-[15px] font-semibold text-text-primary">Quin Gallery</span>
          <span className="text-[12px] text-text-tertiary">
            {creating ? "Choose a password for the lock screen (you can change it in Settings)" : "Enter the password to continue"}
          </span>
        </div>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          autoFocus
          disabled={cooling}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          aria-label="Password"
          placeholder="Password"
          className="w-full rounded-control bg-card px-4 py-2.5 text-center text-[15px] tracking-[0.4em] text-text-primary outline-none ring-1 ring-hairline-strong placeholder:tracking-normal placeholder:text-text-tertiary focus:ring-accent disabled:opacity-50"
        />
        {creating && (
          <input
            type="password"
            autoComplete="off"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setError(null);
            }}
            aria-label="Repeat the password"
            placeholder="Repeat it"
            className="w-full rounded-control bg-card px-4 py-2.5 text-center text-[15px] tracking-[0.4em] text-text-primary outline-none ring-1 ring-hairline-strong placeholder:tracking-normal placeholder:text-text-tertiary focus:ring-accent"
          />
        )}
        <div className="h-4 text-[12px] text-red-400">
          {cooling ? `Try again in ${secondsLeft}s` : error}
        </div>
        <button
          type="submit"
          disabled={cooling || !value}
          className="w-full rounded-control bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity disabled:opacity-40"
        >
          {creating ? "Set password" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
