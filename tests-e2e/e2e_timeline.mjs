// The editor: timeline, typed times, several kept parts, keyboard, preview, export.
// Usage: node e2e_timeline.mjs <exe> <outDir>
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FFMPEG, frame, mad, makeChecker, probe, sleep, spawnApp, waitFor } from "./qg_harness.mjs";

const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { check, summary } = makeChecker();
const root = path.join(os.tmpdir(), "qg-e2e-tl-root");
const dataDir = path.join(os.tmpdir(), "qg-e2e-tl-data");
rmSync(root, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const CLIP = path.join(root, "clip.mp4");
// 12 s, a keyframe every second, a picture that changes every frame, and sound
execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "libx264", "-crf", "14", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", CLIP]);

let app;
try {
  app = await spawnApp(exe, dataDir);
  const { main } = app;
  await app.openRoot(root);
  await app.waitScanned(1);

  const ED = `div[class*="z-[120]"]`;
  const rectOf = app.rectOf;
  const val = (tid) => main.eval(`document.querySelector('[data-testid="${tid}"]')?.value ?? null`);
  const summaryText = () => main.eval(`document.querySelector('[data-testid="tl-summary"]')?.textContent ?? ""`);
  const videoT = () => main.eval(`(() => { const v=document.querySelector('${ED} video'); return v ? v.currentTime : null; })()`);
  const blur = () => main.eval(`document.activeElement && document.activeElement.blur()`);
  async function typeInto(tid, text) {
    await main.eval(`document.querySelector('[data-testid="${tid}"]').focus()`);
    await sleep(80);
    await main.eval(`document.querySelector('[data-testid="${tid}"]').select()`);
    await main.typeText(text);
    await main.key("Enter", { code: "Enter", vk: 13 });
    await sleep(250);
  }
  const press = async (key, code, vk, shift = false) => {
    await blur();
    await main.key(key, { code, vk, shift });
    await sleep(200);
  };
  const clickBtn = (label) => main.eval(`(() => { const b=[...document.querySelectorAll('${ED} button')].find(x => x.textContent.trim() === ${JSON.stringify(label)} || x.getAttribute('aria-label') === ${JSON.stringify(label)}); if(!b || b.disabled) return false; b.click(); return true; })()`);

  async function openEditor() {
    await app.clickText("All Media");
    const card = await waitFor(() => rectOf(`document.querySelector('div.group.relative')`), 30000);
    await main.mouse("mouseMoved", card.x + 30, card.y + 30, { buttons: 0 });
    await main.mouse("mousePressed", card.x + card.w / 2, card.y + card.h / 2, { clickCount: 2 });
    await main.mouse("mouseReleased", card.x + card.w / 2, card.y + card.h / 2, { clickCount: 2 });
    await waitFor(() => main.eval(`!!document.querySelector('[aria-label="Edit"]')`), 20000);
    await main.eval(`document.querySelector('[aria-label="Edit"]').click()`);
    await waitFor(() => main.eval(`!!document.querySelector('[data-testid="editor-timeline"]')`), 20000);
    await waitFor(async () => (await videoT()) !== null, 20000);
    await sleep(1200);
  }
  async function exportAndWait() {
    const before = new Set(readdirSync(root));
    await main.eval(`[...document.querySelectorAll('${ED} button')].find(b => /^Export/.test(b.textContent.trim()))?.click()`);
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const t = await app.text();
      const done = t.match(/Done — saved as ([^\n]+)/);
      if (done) return { ok: true, file: path.join(root, done[1].trim()), added: readdirSync(root).filter((f) => !before.has(f)) };
      const fail = t.match(/Failed:[^\n]+/);
      if (fail) return { ok: false, msg: fail[0] };
      await sleep(400);
    }
    return { ok: false, msg: "timeout" };
  }
  async function closeEditor() {
    await main.eval(`[...document.querySelectorAll('${ED} button')].find(b => /Close/.test(b.textContent))?.click()`);
    await sleep(400);
    await main.key("Escape", { code: "Escape", vk: 27 });
    await sleep(500);
  }

  await openEditor();
  await main.shot(path.join(outDir, "t01-editor.png"));
  check("the editor has a timeline under the video, with transport and typed-time fields", await main.eval(`!!document.querySelector('[data-testid="tl-track"]') && !!document.querySelector('[data-testid="tl-start"]') && !!document.querySelector('[data-testid="tl-playhead"]')`));
  check("…the whole video is one part at first (0:00.000 – 0:12.000)", (await val("tl-start")) === "0:00.000" && (await val("tl-end")) === "0:12.000", `${await val("tl-start")} – ${await val("tl-end")}`);
  const strip = await waitFor(() => main.eval(`(() => { const t=document.querySelector('[data-testid="tl-track"]'); const m=(t && t.style.backgroundImage || '').match(/url\\("?(.*?)"?\\)/); return m ? m[1] : null; })()`), 30000).catch(() => null);
  const stripOk = strip && (await main.eval(`new Promise(r => { const i=new Image(); i.onload=()=>r(i.naturalWidth+'x'+i.naturalHeight); i.onerror=()=>r(null); i.src=${JSON.stringify(strip)}; })`));
  check("the timeline shows a strip of frames from the video", !!stripOk, String(stripOk));

  await typeInto("tl-playhead", "0:05.5");
  let t = await videoT();
  check("typing 0:05.5 in the playhead field jumps there", Math.abs(t - 5.5) < 0.08, `t=${t}`);
  await typeInto("tl-start", "2");
  await typeInto("tl-end", "8.5");
  check("typing start '2' and end '8.5' sets the part to 0:02.000 – 0:08.500", (await val("tl-start")) === "0:02.000" && (await val("tl-end")) === "0:08.500");
  check("…and its length shows 0:06.500", (await val("tl-length")) === "0:06.500", await val("tl-length"));
  await typeInto("tl-length", "3");
  check("typing a length moves the end (2 s + 3 s = 0:05.000)", (await val("tl-end")) === "0:05.000", await val("tl-end"));
  await typeInto("tl-end", "1m30s");
  check("an end past the video is clamped to its length", (await val("tl-end")) === "0:12.000", await val("tl-end"));
  await typeInto("tl-start", "1m2");
  check("nonsense ('1m2') is refused and marked", await main.eval(`document.querySelector('[data-testid="tl-start"]').className.includes('ring-red')`));
  await main.key("Escape", { code: "Escape", vk: 27 });
  await sleep(200);
  check("…Escape puts the old value back", (await val("tl-start")) === "0:02.000", await val("tl-start"));

  await typeInto("tl-playhead", "3");
  await press("ArrowRight", "ArrowRight", 39);
  t = await videoT();
  check("→ steps one frame forward (1/30 s)", Math.abs(t - (3 + 1 / 30)) < 0.02, `t=${t.toFixed(4)}`);
  await press("ArrowLeft", "ArrowLeft", 37, true);
  t = await videoT();
  check("Shift+← goes back one second", Math.abs(t - (2 + 1 / 30)) < 0.03, `t=${t.toFixed(4)}`);

  await clickBtn("Reset");
  await sleep(200);
  await typeInto("tl-playhead", "3");
  await press("s", "KeyS", 83);
  await typeInto("tl-playhead", "6");
  await press("s", "KeyS", 83);
  check("S splits at the playhead (twice → 3 parts)", /Keeping 3 parts/.test(await summaryText()), await summaryText());
  await main.eval(`[...document.querySelectorAll('${ED} button')].find(b => b.textContent.trim() === '2' && b.className.includes('min-w-7'))?.click()`);
  await sleep(200);
  check("the middle part can be selected (3.000 – 6.000)", (await val("tl-start")) === "0:03.000" && (await val("tl-end")) === "0:06.000");
  await press("Delete", "Delete", 46);
  check("Delete removes it: 2 parts, output 0:09.000", /Keeping 2 parts · output 0:09\.000/.test(await summaryText()), await summaryText());
  await typeInto("tl-playhead", "9");
  await press("o", "KeyO", 79);
  check("O ends the selected part at the playhead: output 0:06.000", /output 0:06\.000/.test(await summaryText()) && (await val("tl-end")) === "0:09.000", await summaryText());
  await main.shot(path.join(outDir, "t03-two-parts.png"));

  const h = await rectOf(`document.querySelector('[data-testid="tl-handle-1-start"]')`);
  const track = await rectOf(`document.querySelector('[data-testid="tl-track"]')`);
  await main.drag(h.x + h.w / 2, h.y + h.h / 2, h.x + h.w / 2 + track.w * (0.5 / 12), h.y + h.h / 2);
  const dragged = await val("tl-start");
  check("dragging a part's start handle moves it (about +0.5 s)", /^0:06\.[3-7]\d\d$/.test(dragged), dragged);
  await typeInto("tl-start", "6");

  await typeInto("tl-playhead", "2.3");
  const pb = await rectOf(`[...document.querySelectorAll('${ED} button')].find(b => b.textContent.trim() === 'Preview result')`);
  await main.click(pb.x + pb.w / 2, pb.y + pb.h / 2);
  const seen = [];
  for (let i = 0; i < 25; i++) {
    seen.push(await videoT());
    await sleep(100);
  }
  await clickBtn("Stop preview");
  const inGap = seen.filter((x) => x > 3.15 && x < 5.9);
  check("Preview result plays the kept parts and jumps over the cut", inGap.length === 0 && seen.some((x) => x >= 6), `positions ${seen.map((x) => x.toFixed(1)).join(",")}`);

  let r = await exportAndWait();
  check("exporting 2 parts works", r.ok, r.msg ?? path.basename(r.file ?? ""));
  if (r.ok) {
    const o = probe(r.file);
    check("…the file is the 2 parts joined (6 s, with sound)", Math.abs(o.dur - 6) < 0.35 && o.audio, `${o.dur.toFixed(2)} s`);
    const d = mad(frame(r.file, 4.0), frame(CLIP, 7.0));
    const wrong = mad(frame(r.file, 4.0), frame(CLIP, 4.0));
    check("…after the join the picture is the source at 7 s, not 4 s", d < wrong / 2, `diff ${d.toFixed(1)} vs ${wrong.toFixed(1)}`);
  }
  await closeEditor();

  await openEditor();
  await typeInto("tl-start", "0.5");
  await typeInto("tl-end", "2.25");
  await typeInto("tl-playhead", "5");
  await clickBtn("Add part");
  await sleep(200);
  await typeInto("tl-start", "7.4");
  await typeInto("tl-end", "8.6");
  check("Add part + typed times: 2 parts, output 0:02.950", /Keeping 2 parts · output 0:02\.950/.test(await summaryText()), await summaryText());
  await main.eval(`[...document.querySelectorAll('${ED} button')].find(b => b.textContent.trim() === '90°')?.click()`);
  await main.eval(`[...document.querySelectorAll('${ED} button')].find(b => b.textContent.trim() === 'Fast Cut (keyframe-snapped)')?.click()`);
  await sleep(200);
  r = await exportAndWait();
  check("accurate cut + rotate exports", r.ok, r.msg ?? "");
  if (r.ok) {
    const o = probe(r.file);
    check("…exactly 2.95 s, rotated (360×640), with sound", Math.abs(o.dur - 2.95) < 0.12 && o.w === 360 && o.h === 640 && o.audio, `${o.dur.toFixed(3)} s ${o.w}×${o.h}`);
    const d = mad(frame(r.file, 2.2), frame(CLIP, 7.4 + 0.45, "transpose=1"));
    const wrong = mad(frame(r.file, 2.2), frame(CLIP, 2.2 + 0.5, "transpose=1"));
    check("…the second part really starts at 7.4 s of the source", d < wrong / 2, `diff ${d.toFixed(1)} vs ${wrong.toFixed(1)}`);
  }
  await closeEditor();
} catch (e) {
  check("E2E run", false, String(e).slice(0, 600) + " @ " + String(e.stack).split("\n")[1]);
} finally {
  const failed = summary();
  if (app) await app.quit();
  process.exit(failed ? 1 : 0);
}
