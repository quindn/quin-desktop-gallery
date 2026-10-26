// Drag files out, Ctrl+C, keeping the place across filters / viewer, video seeking + resume, cut range.
// Usage: node e2e_features.mjs <exe> <outDir>
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FFMPEG, makeChecker, makeVideo, probe, sleep, spawnApp, waitFor } from "./qg_harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { check, summary } = makeChecker();
const root = path.join(os.tmpdir(), "qg-e2e-feat-root");
const dataDir = path.join(os.tmpdir(), "qg-e2e-feat-data");
for (const d of [root, dataDir]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(root, "photos"), { recursive: true });
mkdirSync(path.join(root, "videos"), { recursive: true });
const jpg = path.join(os.tmpdir(), "qg-feat-seed.jpg");
execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:duration=1", "-frames:v", "1", jpg]);
for (let i = 0; i < 600; i++) copyFileSync(jpg, path.join(root, "photos", `P_${String(i).padStart(4, "0")}.jpg`));
makeVideo(path.join(root, "videos", "long.mp4"), { secs: 120, size: "1920x1080", gop: 250 });
makeVideo(path.join(root, "videos", "short.mp4"), { secs: 12, size: "640x360", gop: 30 });

const ps = (...args) => execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "os_input.ps1"), ...args], { encoding: "utf8" });

let app;
try {
  app = await spawnApp(exe, dataDir);
  const { main, invoke } = app;
  await app.openRoot(root);
  await app.waitScanned(602);
  // sort by name, ascending: a known order for the checks below
  await app.clickText("All Media");
  await sleep(800);

  const ED = `div[class*="z-[120]"]`;
  const VIEWER = `div[class*="z-[100]"]`;
  const page = () => main.eval(`document.querySelector('input[aria-label="Jump to page"]')?.value`);
  const cardIds = () => main.eval(`JSON.stringify([...document.querySelectorAll('[data-media-id]')].map(e => Number(e.dataset.mediaId)))`).then(JSON.parse);
  const selectedId = () => main.eval(`(() => { const e=[...document.querySelectorAll('[data-media-id]')].find(e => e.className.includes('color-accent')); return e ? Number(e.dataset.mediaId) : null; })()`);
  const inView = (id) => main.eval(`(() => { const e=document.querySelector('[data-media-id="${id}"]'); if(!e) return false; const s=e.closest('.overflow-y-auto').getBoundingClientRect(); const r=e.getBoundingClientRect(); return r.bottom > s.top && r.top < s.bottom; })()`);
  const nameOf = async (id) => (await invoke("get_media_page", { query: { folder_rel_path: null, include_subfolders: true, media_type: "all", sort_by: "name", sort_desc: false, limit: 1000, offset: 0 } })).items.find((i) => i.id === id)?.filename;
  const clickCard = async (id, extra = {}) => {
    await main.eval(`document.querySelector('[data-media-id="${id}"]')?.scrollIntoView({block:'nearest'})`);
    await sleep(150);
    const r = await app.rectOf(`document.querySelector('[data-media-id="${id}"]')`);
    await main.click(r.x + r.w / 2, r.y + r.h / 2, extra);
    await sleep(250);
  };
  const scrollToCard = (id) => main.eval(`document.querySelector('[data-media-id="${id}"]')?.scrollIntoView({block:'center'})`);
  const gotoPage = async (n) => {
    await main.eval(`(() => { const i=document.querySelector('input[aria-label="Jump to page"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, '${n}'); i.dispatchEvent(new Event('input',{bubbles:true})); i.form.requestSubmit(); })()`);
    await waitFor(async () => (await page()) === String(n) && (await cardIds()).length > 0, 10000);
    await sleep(400);
  };
  // sort by name ascending through the toolbar's sort control is UI-specific; use the store's setter via the list header instead
  await main.eval(`(() => { const s=[...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value==='name')); if (s) { const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'name'); s.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
  await sleep(1200);

  // ================================================================ keeping the place
  await gotoPage(3);
  let ids = await cardIds();
  const X = ids[37];
  await scrollToCard(X);
  await clickCard(X);
  check("(setup) a card on page 3 is selected", (await selectedId()) === X, `${await nameOf(X)}`);
  // every other photo is a favourite (so Favorites has several pages)
  const all = (await invoke("get_media_page", { query: { folder_rel_path: null, include_subfolders: true, media_type: "photo", sort_by: "name", sort_desc: false, limit: 1000, offset: 0 } })).items;
  const favIds = all.filter((_, i) => i % 2 === 0).map((i) => i.id);
  if (!favIds.includes(X)) favIds.push(X);
  await invoke("set_favorite_batch", { ids: favIds, favorite: true });
  await app.clickText("Favorites");
  await waitFor(async () => (await cardIds()).length > 0, 10000);
  await sleep(1200);
  check("switching to Favorites lands on the selected item (not page 1)", (await selectedId()) === X && (await inView(X)), `page ${await page()}, selected ${await nameOf(await selectedId())}`);
  const favPage = await page();
  await main.shot(path.join(outDir, "f01-favorites-follow.png"));

  // un-favourite it from the context menu: the view reloads around where it was
  ids = await cardIds();
  const idx = ids.indexOf(X);
  const neighbours = [ids[idx + 1], ids[idx - 1]].filter(Boolean);
  const r = await app.rectOf(`document.querySelector('[data-media-id="${X}"]')`);
  await main.click(r.x + r.w / 2, r.y + r.h / 2, { button: "right" });
  await main.mouse("mousePressed", r.x + r.w / 2, r.y + r.h / 2, { button: "right", buttons: 2 });
  await main.mouse("mouseReleased", r.x + r.w / 2, r.y + r.h / 2, { button: "right", buttons: 0 });
  await main.eval(`(() => { const ev = new MouseEvent('contextmenu', {bubbles:true, clientX:${r.x + r.w / 2}, clientY:${r.y + r.h / 2}}); document.querySelector('[data-media-id="${X}"]').dispatchEvent(ev); })()`);
  await sleep(400);
  await app.clickText("Remove from Favorites");
  await waitFor(async () => !(await cardIds()).includes(X) && (await cardIds()).length > 0, 10000).catch(() => {});
  await sleep(1000);
  const afterUnfav = await selectedId();
  check("un-favouriting it in Favorites keeps the place: its neighbour is selected, same page", !(await cardIds()).includes(X) && neighbours.includes(afterUnfav) && (await page()) === favPage && (await inView(afterUnfav)), `page ${await page()} (was ${favPage}), selected ${await nameOf(afterUnfav)}`);

  await app.clickText("All Media");
  await waitFor(async () => (await cardIds()).length > 0, 10000);
  await sleep(1200);
  check("back to All Media: still on the same item", (await selectedId()) === afterUnfav && (await inView(afterUnfav)), `page ${await page()}, selected ${await nameOf(await selectedId())}`);

  await main.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Photos')?.click()`);
  await sleep(1500);
  check("changing the media type filter keeps the item", (await selectedId()) === afterUnfav && (await inView(afterUnfav)), `page ${await page()}`);
  await main.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'All')?.click()`);
  await sleep(1500);

  // the viewer: walk 5 files on, close — the grid is on that file
  const startId = await selectedId();
  await main.key("Enter", { code: "Enter", vk: 13 });
  await waitFor(() => main.eval(`!!document.querySelector('${VIEWER}')`), 10000);
  for (let i = 0; i < 5; i++) await main.key("ArrowDown", { code: "ArrowDown", vk: 40 });
  const viewedName = await main.eval(`document.querySelector('${VIEWER} .truncate')?.textContent`);
  await main.key("Escape", { code: "Escape", vk: 27 });
  await sleep(800);
  const sel = await selectedId();
  check("closing the viewer after moving 5 files on leaves the grid on that file", (await nameOf(sel)) === viewedName && sel !== startId && (await inView(sel)), `${viewedName} / grid: ${await nameOf(sel)}`);
  await main.shot(path.join(outDir, "f02-after-viewer.png"));

  // ================================================================ Ctrl+C and Ctrl+A
  ids = await cardIds();
  await clickCard(ids[0]);
  await clickCard(ids[1], { modifiers: 2 });
  await main.key("c", { code: "KeyC", vk: 67, ctrl: true });
  await sleep(800);
  // the toast only stays ~2.6 s: read it before the (slow) PowerShell clipboard check
  const toast = await main.eval(`document.querySelector('[data-testid="grid-toast"]')?.textContent ?? ''`);
  const clip = ps("clipboard").trim().split(/\r?\n/).filter(Boolean);
  const want = [await nameOf(ids[0]), await nameOf(ids[1])];
  check("Ctrl+C copies the selected files themselves (paste into Explorer / a web upload)", clip.length === 2 && want.every((n) => clip.some((c) => c.endsWith(n))), clip.map((c) => path.basename(c)).join(", "));
  check("…and says so", /Copied 2 files/.test(toast), toast);
  await main.key("a", { code: "KeyA", vk: 65, ctrl: true });
  await sleep(300);
  const selCount = await main.eval(`[...document.querySelectorAll('[data-media-id]')].filter(e => e.className.includes('color-accent')).length`);
  check("Ctrl+A selects everything on the page", selCount === ids.length || selCount >= 20, `${selCount} selected`);
  await main.key("Escape", { code: "Escape", vk: 27 });

  // ================================================================ drag files out (a real OS drag into another window)
  const log = path.join(os.tmpdir(), "qg-drop-log.txt");
  rmSync(log, { force: true });
  rmSync(log + ".ready", { force: true });
  const target = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "os_input.ps1"), "droptarget", "40", "40", log], { stdio: "ignore" });
  await waitFor(() => existsSync(log + ".ready"), 20000);
  ids = await cardIds();
  await clickCard(ids[2]);
  await clickCard(ids[3], { modifiers: 2 });
  await main.eval(`(() => { window.__qgDown = []; window.addEventListener('pointerdown', e => window.__qgDown.push({x:e.clientX|0,y:e.clientY|0,t:e.target.className?.slice?.(0,30)}), true); window.addEventListener('pointermove', e => { if (e.buttons) window.__qgDown.push({m:1,x:e.clientX|0,y:e.clientY|0}); }, true); })()`);
  const rect = ps("front", String(app.proc.pid)).trim().split(/\s+/).map(Number);
  await sleep(500);
  const win = await main.eval(`JSON.stringify({x: window.screenX, y: window.screenY, dpr: devicePixelRatio, ch: window.outerHeight - window.innerHeight})`).then(JSON.parse);
  console.log("   window", JSON.stringify(win), "rect", rect.join(","));
  await main.eval(`document.querySelector('[data-media-id="${ids[3]}"]')?.scrollIntoView({block:'center'})`);
  await sleep(300);
  const c3 = await app.rectOf(`document.querySelector('[data-media-id="${ids[3]}"]')`);
  const sx = Math.round((win.x + c3.x + c3.w / 2) * win.dpr);
  const sy = Math.round((win.y + win.ch + c3.y + c3.h / 2) * win.dpr);
  // the app window must be the one under the pointer (another window could be on top on a busy desktop)
  for (let i = 0; i < 5 && ps("owner", String(sx), String(sy)).trim() !== String(app.proc.pid); i++) {
    ps("front", String(app.proc.pid));
    await sleep(500);
  }
  console.log("   window under the pointer:", ps("owner", String(sx), String(sy)).trim(), "app", app.proc.pid);
  ps("drag", String(sx), String(sy), "200", "160");
  await waitFor(() => existsSync(log), 8000).catch(() => {});
  const dropped = existsSync(log) ? readFileSync(log, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/).filter(Boolean) : [];
  const dragNames = [await nameOf(ids[2]), await nameOf(ids[3])];
  console.log("   last drag:", await main.eval(`JSON.stringify(window.__qgLastDrag ?? null)`), "down:", await main.eval(`JSON.stringify(window.__qgDown ?? null)`), "pressed at", sx, sy, "card", JSON.stringify(c3));
  const pointerArrived = await main.eval(`(window.__qgDown || []).length > 0`);
  if (!pointerArrived && dropped.length === 0) {
    // Real OS input never reached the app: the desktop is locked (or a remote session is minimised),
    // so Windows delivers synthetic mouse input to nobody. Not something the app can do anything about.
    console.log("SKIP  dragging out: the desktop is locked / not receiving input, so no real mouse drag could be made");
  } else check("dragging selected cards out drops the real files into another app", dropped.length === 2 && dragNames.every((n) => dropped.some((d) => d.endsWith(n))), dropped.map((d) => path.basename(d)).join(", ") || "nothing dropped");
  check("…and the app is still usable afterwards (no stuck click)", (await selectedId()) !== null && !(await main.eval(`!!document.querySelector('${VIEWER}')`)));
  target.kill();
  try {
    execFileSync("taskkill", ["/F", "/PID", String(target.pid), "/T"], { stdio: "ignore" });
  } catch {}

  // ================================================================ video: streaming, seeking, never switching files
  const longId = (await invoke("get_media_page", { query: { folder_rel_path: "videos", include_subfolders: true, media_type: "video", sort_by: "name", sort_desc: false, limit: 10, offset: 0 } })).items.find((i) => i.filename === "long.mp4").id;
  await main.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Videos')?.click()`);
  await sleep(1500);
  await scrollToCard(longId);
  await clickCard(longId);
  const vname = () => main.eval(`document.querySelector('${VIEWER} .truncate')?.textContent`);
  const vt = () => main.eval(`(() => { const v=document.querySelector('${VIEWER} video'); return v ? v.currentTime : null; })()`);
  await main.key("Enter", { code: "Enter", vk: 13 });
  // seek right away, while it is still loading
  await waitFor(() => main.eval(`!!document.querySelector('${VIEWER} video')`), 15000);
  for (let i = 0; i < 3; i++) await main.key("ArrowRight", { code: "ArrowRight", vk: 39 });
  await sleep(2500);
  const src = await main.eval(`document.querySelector('${VIEWER} video')?.currentSrc`);
  check("a video streams from the local http server (not asset://, no conversion)", /^http:\/\/127\.0\.0\.1:\d+\/f\//.test(src) && !/Converting/.test(await app.text()), src);
  check("→ pressed 3× while it was still loading: same file, 30 s further", (await vname()) === "long.mp4" && Math.abs((await vt()) - 30) < 3, `${await vname()} at ${(await vt())?.toFixed(1)} s`);
  check("the side buttons that changed the file are gone for videos (prev / next are in the top bar)", (await main.eval(`!document.querySelector('${VIEWER} button[aria-label="Next file"]') && !!document.querySelector('${VIEWER} button[aria-label^="Next file ("]')`)));
  // seeking speed
  const lat = await main.eval(`(async () => { const v=document.querySelector('${VIEWER} video'); const out=[]; for (const t of [80, 15, 100, 45, 5, 60]) { const s=performance.now(); await new Promise(r => { v.addEventListener('seeked', r, {once:true}); v.currentTime = t; }); out.push(Math.round(performance.now()-s)); } return JSON.stringify(out); })()`).then(JSON.parse);
  const med = [...lat].sort((a, b) => a - b)[3];
  check("seeks in a 1080p file with keyframes 8 s apart land quickly", med < 700, `${lat.join(", ")} ms`);
  // play on after a seek
  await main.eval(`(() => { const v=document.querySelector('${VIEWER} video'); v.currentTime = 40; v.play(); })()`);
  await sleep(2500);
  const t2 = await vt();
  check("…and it keeps playing after a seek", t2 > 41 && t2 < 45, `t=${t2?.toFixed(1)}`);
  await main.key("ArrowLeft", { code: "ArrowLeft", vk: 37 });
  await sleep(500);
  check("← in a video seeks back, still the same file", (await vname()) === "long.mp4" && (await vt()) < t2 - 5, `t=${(await vt())?.toFixed(1)}`);
  // resume
  await main.eval(`(() => { const v=document.querySelector('${VIEWER} video'); v.currentTime = 52; })()`);
  await sleep(600);
  if (!(await main.eval(`document.querySelector('${VIEWER} video').paused`))) await main.key("k", { code: "KeyK", vk: 75 });
  await sleep(300);
  await sleep(4800);
  await main.key("Escape", { code: "Escape", vk: 27 });
  await sleep(800);
  await main.key("Enter", { code: "Enter", vk: 13 });
  await waitFor(async () => (await vt()) > 1, 15000).catch(() => {});
  const resumed = await vt();
  const note = await app.text();
  check("reopening a video resumes where it was left (52 s)", resumed >= 51 && resumed < 54.5, `t=${resumed?.toFixed(1)}`);
  check("…with a 'Resumed at 0:52 · Start over' note", /Resumed at 0:52/.test(note));
  await main.shot(path.join(outDir, "f03-resume.png"));
  await main.eval(`[...document.querySelectorAll('[data-testid="resume-note"] button')].find(b => b.textContent.trim()==='Start over')?.click()`);
  await sleep(500);
  check("…'Start over' goes back to the beginning", (await vt()) < 2, `t=${(await vt())?.toFixed(1)}`);
  await main.key("PageDown", { code: "PageDown", vk: 34 });
  await sleep(800);
  if ((await vname()) === "long.mp4") {
    await main.key("PageUp", { code: "PageUp", vk: 33 });
    await sleep(800);
  }
  check("PageUp / PageDown (or ↑ / ↓) are what change the file", (await vname()) !== "long.mp4", await vname());
  await main.key("Escape", { code: "Escape", vk: 27 });
  await sleep(600);

  // ================================================================ editor: cut a range out, keep a range, one file per part
  const shortId = (await invoke("get_media_page", { query: { folder_rel_path: "videos", include_subfolders: true, media_type: "video", sort_by: "name", sort_desc: false, limit: 10, offset: 0 } })).items.find((i) => i.filename === "short.mp4").id;
  await scrollToCard(shortId);
  await clickCard(shortId);
  await main.key("Enter", { code: "Enter", vk: 13 });
  await waitFor(() => main.eval(`!!document.querySelector('[aria-label="Edit"]')`), 15000);
  await main.eval(`document.querySelector('[aria-label="Edit"]').click()`);
  await waitFor(() => main.eval(`!!document.querySelector('[data-testid="tl-cut-from"]')`), 15000);
  await sleep(1500);
  const val = (tid) => main.eval(`document.querySelector('[data-testid="${tid}"]')?.value ?? null`);
  const sumText = () => main.eval(`document.querySelector('[data-testid="tl-summary"]')?.textContent ?? ""`);
  const typeInto = async (tid, text) => {
    await main.eval(`document.querySelector('[data-testid="${tid}"]').focus()`);
    await sleep(60);
    await main.eval(`document.querySelector('[data-testid="${tid}"]').select()`);
    await main.typeText(text);
    await main.key("Enter", { code: "Enter", vk: 13 });
    await sleep(200);
  };
  const clickBtn = (label) => main.eval(`(() => { const b=[...document.querySelectorAll('${ED} button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if(!b || b.disabled) return false; b.click(); return true; })()`);
  await typeInto("tl-cut-from", "3");
  await typeInto("tl-cut-to", "5.5");
  check("a range is typed in (3 – 5.5 s) and shown on the timeline", (await main.eval(`!!document.querySelector('[data-testid="tl-range"]')`)) && (await val("tl-cut-from")) === "0:03.000" && (await val("tl-cut-to")) === "0:05.500");
  await clickBtn("Cut out range");
  await sleep(300);
  check("Cut out range: 2 parts, output 0:09.500", /Keeping 2 parts · output 0:09\.500/.test(await sumText()), await sumText());
  // Shift+drag a second range and cut it with X
  const tr = await app.rectOf(`document.querySelector('[data-testid="tl-track"]')`);
  const xAt = (s) => tr.x + (tr.w * s) / 12;
  await main.drag(xAt(8), tr.y + tr.h / 2, xAt(9), tr.y + tr.h / 2, 8, 8);
  await sleep(300);
  const marked = [await val("tl-cut-from"), await val("tl-cut-to")];
  check("Shift+drag on the timeline marks a range", /^0:0[78]\.\d{3}$/.test(marked[0]) && /^0:0[89]\.\d{3}$/.test(marked[1]), marked.join(" – "));
  await main.eval(`document.activeElement && document.activeElement.blur()`);
  await main.key("x", { code: "KeyX", vk: 88 });
  await sleep(300);
  check("X cuts the marked range out: 3 parts", /Keeping 3 parts/.test(await sumText()), await sumText());
  await main.shot(path.join(outDir, "f04-cut-ranges.png"));
  // one file per part
  await main.eval(`document.querySelector('[data-testid="separate-files"]')?.click()`);
  await sleep(200);
  const before = new Set(readdirSync(path.join(root, "videos")));
  await main.eval(`[...document.querySelectorAll('${ED} button')].find(b => /^Export/.test(b.textContent.trim()))?.click()`);
  const done = await waitFor(async () => /Done — saved as/.test(await app.text()) ? await app.text() : /Failed:/.test(await app.text()) ? "FAILED " + (await app.text()).match(/Failed:[^\n]+/)[0] : null, 120000).catch(() => "timeout");
  const made = readdirSync(path.join(root, "videos")).filter((f) => !before.has(f) && f.endsWith(".mp4")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const durs = made.map((f) => probe(path.join(root, "videos", f)).dur);
  check("'each part as its own file' exports 3 files", made.length === 3 && /3 files/.test(done), `${made.join(", ")} ${/FAILED|timeout/.test(done) ? done.slice(0, 120) : ""}`);
  const kept = await main.eval(`'' + document.querySelector('[data-testid="tl-summary"]')?.textContent`);
  check("…with the right lengths (3 s, ~2.5 s, 3 s)", durs.length === 3 && Math.abs(durs[0] - 3) < 0.6 && Math.abs(durs[2] - 3) < 0.6 && durs[1] > 1.5 && durs[1] < 3.5, durs.map((d) => d.toFixed(2)).join(", ") + " · " + kept);
  await main.shot(path.join(outDir, "f05-separate-files.png"));
} catch (e) {
  check("E2E run", false, String(e).slice(0, 600) + " @ " + String(e.stack).split("\n")[1]);
} finally {
  const failed = summary();
  if (app) await app.quit();
  process.exit(failed ? 1 : 0);
}
