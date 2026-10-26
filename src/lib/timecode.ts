// Times the editor shows and accepts. Typing is forgiving: "1:23", "1:02:03.5", "83.5", "83,5",
// "1m23s", "1h2m", "90s", "500ms" all work. Shown as m:ss.mmm (h:mm:ss.mmm past an hour).

/** Milliseconds for what was typed, or null when it can't be read as a time. */
export function parseTime(input: string): number | null {
  const s = input.trim().toLowerCase().replace(",", ".");
  if (!s) return null;

  // 1h2m3.5s / 2m / 90s / 500ms
  if (/[hms]/.test(s)) {
    const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g;
    let total = 0;
    let matched = "";
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const v = Number(m[1]);
      total += m[2] === "h" ? v * 3_600_000 : m[2] === "m" ? v * 60_000 : m[2] === "s" ? v * 1000 : v;
      matched += m[0];
    }
    return matched.replace(/\s/g, "") === s.replace(/\s/g, "") ? Math.round(total) : null;
  }

  // [[h:]m:]s[.fff]
  const parts = s.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d*(\.\d+)?$/.test(p) || p === "")) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  // only the last part may carry a fraction, and m / s under an h / m must be < 60
  if (parts.slice(0, -1).some((p) => p.includes("."))) return null;
  if (nums.length >= 2 && nums[nums.length - 1] >= 60) return null;
  if (nums.length === 3 && nums[1] >= 60) return null;
  let ms = 0;
  for (const n of nums) ms = ms * 60 + n;
  return Math.round(ms * 1000);
}

/** m:ss.mmm (h:mm:ss.mmm from an hour on). */
export function formatTime(ms: number, withMs = true): string {
  const neg = ms < 0;
  let t = Math.round(Math.abs(ms));
  const msPart = t % 1000;
  t = Math.floor(t / 1000);
  const s = t % 60;
  t = Math.floor(t / 60);
  const m = t % 60;
  const h = Math.floor(t / 60);
  const ss = String(s).padStart(2, "0");
  const frac = withMs ? `.${String(msPart).padStart(3, "0")}` : "";
  const body = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}${frac}` : `${m}:${ss}${frac}`;
  return (neg ? "-" : "") + body;
}
