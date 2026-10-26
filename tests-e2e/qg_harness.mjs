// Shared e2e harness: launch the real app against its own data folder and drive it over CDP.
// Lives in the project (not a temp folder) so the suites survive between sessions.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The lock password the e2e runs choose on their fresh data folder. */
export const TEST_PASSWORD = "qg-e2e-pass";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FFMPEG = path.join(HERE, "..", "src-tauri", "bin", "ffmpeg-x86_64-pc-windows-msvc.exe");
export const FFPROBE = path.join(HERE, "..", "src-tauri", "bin", "ffprobe-x86_64-pc-windows-msvc.exe");
export const RELEASE_EXE = path.join(HERE, "..", "src-tauri", "target", "release", "quin-gallery.exe");
export const DEBUG_EXE = path.join(HERE, "..", "src-tauri", "target", "debug", "quin-gallery.exe");

export async function waitFor(fn, timeoutMs = 30000, stepMs = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(stepMs);
  }
  throw new Error("timeout waiting for condition" + (last ? `: ${last}` : "") + ` (${fn.toString().replace(/\s+/g, " ").slice(0, 140)})`);
}

export function killApp(name) {
  try {
    execFileSync("taskkill", ["/F", "/IM", name, "/T"], { stdio: "ignore" });
  } catch {}
}

export function makeChecker() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const summary = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length) console.log("FAILED:\n  - " + failed.map((f) => f.name).join("\n  - "));
    return failed.length;
  };
  return { check, summary };
}

export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
    return this;
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ id, error: { message: "CDP timeout: " + method } });
      }, 45000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) writeFileSync(file, Buffer.from(r.result.data, "base64"));
  }
  async mouse(type, x, y, extra = {}) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, ...extra });
  }
  async click(x, y, extra = {}) {
    await this.mouse("mouseMoved", x, y, { buttons: 0 });
    await this.mouse("mousePressed", x, y, extra);
    await this.mouse("mouseReleased", x, y, extra);
  }
  async drag(x0, y0, x1, y1, steps = 8, modifiers = 0) {
    await this.mouse("mouseMoved", x0, y0, { buttons: 0, modifiers });
    await this.mouse("mousePressed", x0, y0, { modifiers });
    for (let i = 1; i <= steps; i++) await this.mouse("mouseMoved", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { modifiers });
    await this.mouse("mouseReleased", x1, y1, { modifiers });
    await sleep(200);
  }
  async key(key, { code, vk, shift = false, ctrl = false } = {}) {
    const base = { key, code: code ?? key, windowsVirtualKeyCode: vk ?? key.toUpperCase().charCodeAt(0), modifiers: (shift ? 8 : 0) | (ctrl ? 2 : 0) };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(150);
  }
  async typeText(text) {
    await this.send("Input.insertText", { text });
  }
}

/** Launches `exe` against `dataDir` (unlocked, lock screen passed). */
export async function spawnApp(exe, dataDir, extraEnv = {}) {
  killApp(path.basename(exe));
  await sleep(700);
  mkdirSync(dataDir, { recursive: true });
  const portFile = path.join(dataDir, "webview", "EBWebView", "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const proc = spawn(exe, [], {
    env: { ...process.env, QG_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0 --remote-allow-origins=*", ...extraEnv },
    stdio: "ignore",
  });
  const port = await waitFor(() => (existsSync(portFile) ? Number(readFileSync(portFile, "utf8").trim().split(/[\r\n]/)[0]) : null), 90000, 100);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page" && /tauri|localhost/.test(x.url)), 90000, 100);
  const main = await new Cdp(target.webSocketDebuggerUrl).open();
  await main.send("Runtime.enable");
  await main.send("Page.enable");
  await main.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const invoke = (cmd, args = {}) =>
    main.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(v => JSON.stringify(v ?? null), e => JSON.stringify({__error: String(e)}))`).then(JSON.parse);
  // A fresh data folder asks to choose a lock password (two fields); later launches ask for it (one field).
  const unlock = async (password = TEST_PASSWORD) => {
    // the form only appears once the lock screen knows whether it is choosing or checking a password
    await waitFor(() => main.eval(`!!document.querySelector('form[data-lock-mode] input[type=password]')`), 60000, 100);
    await sleep(150);
    await main.eval(`(() => { const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; const ins=[...document.querySelectorAll('input[type=password]')]; for (const i of ins) { set.call(i, ${JSON.stringify(password)}); i.dispatchEvent(new Event('input',{bubbles:true})); } setTimeout(()=>ins[0].form.requestSubmit(),150); })()`);
    // checking takes a moment (PBKDF2): wait until the lock screen is gone or says why not
    await waitFor(() => main.eval(`!document.querySelector('form[data-lock-mode]') || /Wrong|wrong|match|least|Too many/.test(document.querySelector('form[data-lock-mode]').innerText)`), 15000, 100).catch(() => {});
    await sleep(300);
  };
  await unlock();
  const app = {
    proc,
    main,
    invoke,
    unlock,
    text: () => main.eval(`document.body.innerText`),
    rectOf: (expr) => main.eval(`(() => { const e=${expr}; if(!e) return null; const r=e.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`).then((s) => s && JSON.parse(s)),
    clickText: (t) => main.eval(`(() => { const el=[...document.querySelectorAll('button,div,span,a')].filter(e=>e.children.length<=2 && e.textContent.trim()===${JSON.stringify(t)}).pop(); if(!el) return false; el.click(); return true; })()`),
    async openRoot(dir) {
      const r = await invoke("open_root", { path: dir });
      await main.send("Page.reload");
      await sleep(2000);
      await unlock();
      await waitFor(() => main.eval(`/total media/i.test(document.body.innerText)`), 30000);
      return r;
    },
    async waitScanned(total) {
      await waitFor(async () => {
        const s = await invoke("get_dashboard_stats");
        return s.total >= total && (s.pendingMetadata ?? s.pending_metadata) === 0;
      }, 120000, 400);
    },
    async quit() {
      try {
        await Promise.race([invoke("app_quit"), sleep(1500)]);
      } catch {}
      await sleep(1500);
      killApp(path.basename(exe));
      await sleep(700);
    },
  };
  return app;
}

export function probe(f) {
  const j = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f], { encoding: "utf8" }));
  const v = j.streams.find((s) => s.codec_type === "video");
  return { w: v?.width, h: v?.height, dur: Number(j.format.duration), audio: j.streams.some((s) => s.codec_type === "audio"), vcodec: v?.codec_name, size: statSync(f).size };
}
export function frame(f, t, vf) {
  const args = ["-v", "error", "-ss", String(t), "-i", f];
  if (vf) args.push("-vf", vf);
  args.push("-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
  return execFileSync(FFMPEG, args, { maxBuffer: 1 << 28 });
}
export function mad(a, b) {
  if (a.length !== b.length || !a.length) return 999;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
export function makeVideo(out, { secs = 60, size = "1280x720", gop = 120, audio = true, rate = 30 } = {}) {
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${secs}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", String(gop), "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  execFileSync(FFMPEG, args);
}
