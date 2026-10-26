// Viewer: the favorite key, resume on / off, Next / Previous across pages, "This folder".
// Studio: adding clips, split, reorder, undo, transition, text, music, export.
// Usage: node e2e_viewer_studio.mjs <exe> <outDir>
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { FFMPEG, makeChecker, makeVideo, probe, sleep, spawnApp, waitFor } from "./qg_harness.mjs";

const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { check, summary } = makeChecker();
const root = path.join(os.tmpdir(), "qg-e2e-vs-root");
const dataDir = path.join(os.tmpdir(), "qg-e2e-vs-data");
const music = path.join(os.tmpdir(), "qg-e2e-vs-music.m4a");
for (const d of [root, dataDir]) rmSync(d, { recursive: true, force: true });
mkdirSync(path.join(root, "photos"), { recursive: true });
mkdirSync(path.join(root, "videos"), { recursive: true });
const jpg = path.join(os.tmpdir(), "qg-vs-seed.jpg");
execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:duration=1", "-frames:v", "1", jpg]);
for (let i = 0; i < 130; i++) copyFileSync(jpg, path.join(root, "photos", `P_${String(i).padStart(4, "0")}.jpg`));
makeVideo(path.join(root, "videos", "v1.mp4"), { secs: 6, size: "640x360", gop: 30 });
makeVideo(path.join(root, "videos", "v2.mp4"), { secs: 5, size: "640x360", gop: 30 });
makeVideo(path.join(root, "videos", "vlong.mp4"), { secs: 50, size: "640x360", gop: 60 });
execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=20", "-c:a", "aac", music]);
const TOTAL = 133;

let app;
try {
  app = await spawnApp(exe, dataDir);
  const { main, invoke } = app;
  await app.openRoot(root);
  await app.waitScanned(TOTAL);
  await app.clickText("All Media");
  await sleep(800);
  await main.eval(`(() => { const s=[...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value==='name')); if (s) { const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'name'); s.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
  await sleep(1200);

  // 120 per page, ascending by name: P_0000 … P_0129, v1, v2, vlong
  await main.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='120')?.click()`);
  await sleep(1000);
  const firstName = async () => {
    const id = await main.eval(`Number(document.querySelector('[data-media-id]')?.dataset.mediaId)`);
    return (await invoke("get_media_page", { query: { folder_rel_path: null, include_subfolders: true, media_type: "all", sort_by: "name", sort_desc: false, limit: 1000, offset: 0 } })).items.find((i) => i.id === id)?.filename;
  };
  await main.eval(`document.querySelector('[data-media-id]')?.closest('.overflow-y-auto')?.scrollTo(0, 0)`);
  await sleep(300);
  if ((await firstName()) !== "P_0000.jpg") {
    await main.eval(`document.querySelector('button[aria-label="Toggle sort direction"]').click()`);
    await sleep(1200);
  }

  const VIEWER = `div[class*="z-[100]"]`;
  const page = () => main.eval(`document.querySelector('input[aria-label="Jump to page"]')?.value`);
  const cardIds = () => main.eval(`JSON.stringify([...document.querySelectorAll('[data-media-id]')].map(e => Number(e.dataset.mediaId)))`).then(JSON.parse);
  const selectedId = () => main.eval(`(() => { const e=[...document.querySelectorAll('[data-media-id]')].find(e => e.className.includes('color-accent')); return e ? Number(e.dataset.mediaId) : null; })()`);
  const everything = (await invoke("get_media_page", { query: { folder_rel_path: null, include_subfolders: true, media_type: "all", sort_by: "name", sort_desc: false, limit: 1000, offset: 0 } })).items;
  const byName = (n) => everything.find((i) => i.filename === n || i.filename.replace(/\.[^.]+$/, "") === n);
  const isFav = async (id) => (await invoke("get_media_page", { query: { folder_rel_path: null, include_subfolders: true, media_type: "all", sort_by: "name", sort_desc: false, limit: 1000, offset: 0, favorites_only: true } })).items.some((i) => i.id === id);
  const clickCard = async (id) => {
    await main.eval(`document.querySelector('[data-media-id="${id}"]')?.scrollIntoView({block:'center'})`);
    await sleep(200);
    const r = await app.rectOf(`document.querySelector('[data-media-id="${id}"]')`);
    await main.click(r.x + r.w / 2, r.y + r.h / 2);
    await sleep(250);
  };
  const gotoPage = async (n) => {
    await main.eval(`(() => { const i=document.querySelector('input[aria-label="Jump to page"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, '${n}'); i.dispatchEvent(new Event('input',{bubbles:true})); i.form.requestSubmit(); })()`);
    await waitFor(async () => (await page()) === String(n) && (await cardIds()).length > 0, 10000);
    await sleep(400);
  };
  const openViewer = async (name) => {
    const it = byName(name);
    // the grid is virtual: scroll through each page until the card is rendered
    const findOnPage = async () => {
      await main.eval(`document.querySelector('[data-media-id]')?.closest('.overflow-y-auto')?.scrollTo(0, 0)`);
      await sleep(250);
      for (let k = 0; k < 40; k++) {
        if ((await cardIds()).includes(it.id)) return true;
        const more = await main.eval(`(() => { const s=document.querySelector('[data-media-id]')?.closest('.overflow-y-auto'); if (!s) return false; const before=s.scrollTop; s.scrollTop += s.clientHeight * 0.7; return s.scrollTop > before; })()`);
        await sleep(200);
        if (!more) return (await cardIds()).includes(it.id);
      }
      return false;
    };
    if (!(await cardIds()).includes(it.id) && !(await findOnPage())) {
      for (const p of [1, 2, 3]) {
        await gotoPage(p);
        if (await findOnPage()) break;
      }
    }
    if (!(await cardIds()).includes(it.id)) {
      await main.shot(path.join(outDir, "debug-notfound.png"));
      throw new Error(`card ${name} (${it.id}) not found; page ${await page()}, cards ${JSON.stringify(await cardIds())}, text: ${(await app.text()).slice(0, 300)}`);
    }
    await clickCard(it.id);
    await main.key("Enter", { code: "Enter", vk: 13 });
    await waitFor(() => main.eval(`!!document.querySelector('${VIEWER}')`), 10000);
    await sleep(500);
  };
  const vname = () => main.eval(`document.querySelector('${VIEWER} .truncate')?.textContent`);
  const vpos = () => main.eval(`document.querySelector('[data-testid="viewer-pos"]')?.textContent.replace(/\\s+/g,' ').trim()`);
  const vt = () => main.eval(`(() => { const v=document.querySelector('${VIEWER} video'); return v ? v.currentTime : null; })()`);
  const closeViewer = async () => {
    await main.key("Escape", { code: "Escape", vk: 27 });
    await waitFor(() => main.eval(`!document.querySelector('${VIEWER}')`), 5000);
    await sleep(300);
  };
  const settings = async (testIds) => {
    await app.clickText("Settings");
    await waitFor(() => main.eval(`!!document.querySelector('[data-testid="resume-on"]')`), 5000);
    for (const t of testIds) {
      await main.eval(`document.querySelector('[data-testid="${t}"]').click()`);
      await sleep(150);
    }
    await main.shot(path.join(outDir, `settings-${testIds.join("-")}.png`));
    await main.eval(`(() => { let e=document.querySelector('[data-testid="resume-on"]'); while (e && !/fixed/.test(e.className)) e=e.parentElement; e?.click(); })()`);
    await sleep(400);
  };

  // ================================================================ the favorite key
  const p5 = byName("P_0005");
  await openViewer("P_0005");
  check("(setup) the viewer is open on P_0005", (await vname()) === "P_0005.jpg", await vname());
  await main.key("Enter", { code: "Enter", vk: 13 });
  await sleep(500);
  check("Enter (default favorite key) favourites the file in the viewer", await isFav(p5.id));
  check("…with a heart shown on screen", await main.eval(`!!document.querySelector('[data-testid="heart-flash"]')`));
  await main.shot(path.join(outDir, "v01-fav-key.png"));
  await main.key("Enter", { code: "Enter", vk: 13 });
  await sleep(500);
  check("Enter again un-favourites it", !(await isFav(p5.id)));
  check("…and the viewer stayed on the same file", (await vname()) === "P_0005.jpg");
  await closeViewer();
  await settings(["favkey-End"]);
  await openViewer("P_0005");
  await main.key("Enter", { code: "Enter", vk: 13 });
  await sleep(400);
  const afterEnter = await isFav(p5.id);
  await main.key("End", { code: "End", vk: 35 });
  await sleep(500);
  check("after choosing End in Settings: Enter does nothing, End favourites", !afterEnter && (await isFav(p5.id)), `enter→${afterEnter}`);
  await main.key("End", { code: "End", vk: 35 });
  await sleep(400);
  await closeViewer();
  await settings(["favkey-Enter"]);

  // ================================================================ next / previous across pages
  await openViewer("P_0119");
  check("(setup) viewer on the last file of page 1", (await vname()) === "P_0119.jpg" && (await vpos()) === `120 / ${TOTAL}`, `${await vname()} ${await vpos()}`);
  await main.key("ArrowDown", { code: "ArrowDown", vk: 40 });
  await waitFor(async () => (await vname()) === "P_0120.jpg", 8000).catch(() => {});
  check("↓ on the last file of a page goes on to the first file of the next page", (await vname()) === "P_0120.jpg" && (await vpos()) === `121 / ${TOTAL}`, `${await vname()} ${await vpos()}`);
  await main.key("ArrowUp", { code: "ArrowUp", vk: 38 });
  await waitFor(async () => (await vname()) === "P_0119.jpg", 8000).catch(() => {});
  check("↑ on the first file of a page goes back to the last file of the previous one", (await vname()) === "P_0119.jpg" && (await vpos()) === `120 / ${TOTAL}`, `${await vname()} ${await vpos()}`);
  // the header ›/‹ buttons on a video: from page 2's last file, Next stays (end of the library)
  await closeViewer();
  check("closing the viewer leaves the grid on that file's page", (await page()) === "1" && (await selectedId()) === byName("P_0119").id, `page ${await page()}`);
  await openViewer("vlong");
  for (let i = 0; i < 3; i++) {
    await main.eval(`document.querySelector('${VIEWER} button[aria-label^="Next file ("]')?.click()`);
    await sleep(500);
  }
  check("Next past the very last file stays on it", (await vpos()) === `${TOTAL} / ${TOTAL}`, `${await vname()} ${await vpos()}`);
  await closeViewer();

  // ================================================================ resume off / on
  const setPlace = async (sec) => {
    await waitFor(() => main.eval(`(() => { const v=document.querySelector('${VIEWER} video'); return !!v && v.readyState >= 2; })()`), 15000);
    await sleep(1500); // the player has applied its own start position by now
    await main.eval(`(() => { const v=document.querySelector('${VIEWER} video'); v.currentTime = ${sec}; })()`);
    await sleep(1500);
    if (!(await main.eval(`document.querySelector('${VIEWER} video').paused`))) await main.key("k", { code: "KeyK", vk: 75 });
    await sleep(500);
  };
  const reopenTime = async () => {
    await openViewer("vlong");
    await waitFor(() => main.eval(`(() => { const v=document.querySelector('${VIEWER} video'); return !!v && v.readyState >= 1; })()`), 15000);
    await sleep(1500);
    return vt();
  };
  await openViewer("vlong");
  await setPlace(30);
  await closeViewer();
  let t = await reopenTime();
  check("resume on (default): reopening continues at ~30 s", t >= 29 && t < 36, `t=${t?.toFixed(1)}`);
  await setPlace(30);
  await closeViewer();
  await settings(["resume-off"]);
  t = await reopenTime();
  check("resume off: reopening starts from the beginning", t !== null && t < 3, `t=${t?.toFixed(1)}`);
  check("…and no 'resumed' note is shown", !(await main.eval(`!!document.querySelector('[data-testid="resume-note"]')`)));
  await closeViewer();
  await settings(["resume-on"]);

  // ================================================================ this folder
  await openViewer("v1");
  await main.eval(`document.querySelector('[data-testid="show-folder"]').click()`);
  await waitFor(async () => (await cardIds()).length === 3, 8000).catch(() => {});
  const shown = await cardIds();
  check("'This folder' shows only the files of that video's folder", shown.length === 3 && ["v1.mp4", "v2.mp4", "vlong.mp4"].every((n) => shown.includes(byName(n.replace(".mp4", "")).id)), `${shown.length} cards`);
  check("…with the viewer closed and that video selected", !(await main.eval(`!!document.querySelector('${VIEWER}')`)) && (await selectedId()) === byName("v1").id);
  await main.shot(path.join(outDir, "v02-this-folder.png"));

  // ================================================================ Studio
  await app.clickText("Studio (video editor)");
  await waitFor(() => main.eval(`!!document.querySelector('[data-testid="studio"]')`), 8000);
  await waitFor(() => main.eval(`document.querySelectorAll('[data-testid="studio-bin"] [data-bin-id]').length >= 4`), 10000);
  const clips = () => main.eval(`JSON.stringify([...document.querySelectorAll('[data-testid="studio-clip"]')].map(e => e.getAttribute('title')))`).then(JSON.parse);
  const addBin = async (name) => {
    const it = byName(name);
    await main.eval(`document.querySelector('[data-bin-id="${it.id}"] button').click()`);
    await waitFor(async () => (await clips()).some((c) => c.startsWith(it.filename)), 10000);
    await sleep(200);
  };
  const studioTime = () => main.eval(`document.querySelector('[data-testid="studio-time"]').textContent`);
  await addBin("v1");
  await addBin("v2");
  await addBin("P_0003");
  let cl = await clips();
  check("Studio: three clips added from the library (2 videos + 1 photo)", cl.length === 3, JSON.stringify(cl));
  check("…total length 6 + 5 + 3 = 14 s", (await studioTime()).endsWith("/ 0:14.000"), await studioTime());
  await main.shot(path.join(outDir, "s01-studio-clips.png"));

  // split at 2 s
  await main.key("Home", { code: "Home", vk: 36 });
  await main.key("ArrowRight", { code: "ArrowRight", vk: 39, shift: true });
  await main.key("ArrowRight", { code: "ArrowRight", vk: 39, shift: true });
  check("Shift+→ ×2 moves the playhead to 2 s", (await studioTime()).startsWith("0:02.000"), await studioTime());
  await main.key("s", { code: "KeyS", vk: 83 });
  await sleep(300);
  cl = await clips();
  check("S splits the clip under the playhead (4 clips, still 14 s)", cl.length === 4 && (await studioTime()).endsWith("/ 0:14.000"), `${cl.length} ${await studioTime()}`);
  check("…into 2 s + 4 s", cl[0].endsWith("0:02.000") && cl[1].endsWith("0:04.000"), JSON.stringify(cl.slice(0, 2)));

  // reorder by dragging the photo to the front, then undo
  const clipRect = (i) => app.rectOf(`document.querySelector('[data-testid="studio-clip"][data-clip-index="${i}"]')`);
  const r3 = await clipRect(3);
  const r0 = await clipRect(0);
  await main.drag(r3.x + r3.w / 2, r3.y + r3.h / 2, r0.x + 4, r0.y + r0.h / 2, 12);
  await sleep(300);
  cl = await clips();
  check("dragging a clip moves it (the photo is now first)", cl[0].startsWith("P_0003"), JSON.stringify(cl.map((c) => c.split(" ")[0])));
  await main.key("z", { code: "KeyZ", vk: 90, ctrl: true });
  await sleep(300);
  cl = await clips();
  check("Ctrl+Z undoes the move", cl[3]?.startsWith("P_0003") && cl.length === 4, JSON.stringify(cl.map((c) => c.split(" ")[0])));

  // delete + undo
  const ra = await clipRect(1);
  await main.click(ra.x + ra.w / 2, ra.y + ra.h / 2);
  await sleep(200);
  await main.key("Delete", { code: "Delete", vk: 46 });
  await sleep(250);
  const afterDel = (await clips()).length;
  await main.key("z", { code: "KeyZ", vk: 90, ctrl: true });
  await sleep(250);
  check("Delete removes the selected clip, Ctrl+Z brings it back", afterDel === 3 && (await clips()).length === 4, `${afterDel} → ${(await clips()).length}`);

  // trim by typing: select the v2 clip (index 2), set "To" = 3 s
  const r2 = await clipRect(2);
  await main.click(r2.x + r2.w / 2, r2.y + r2.h / 2);
  await sleep(250);
  const typeInto = async (testId, text) => {
    await main.eval(`document.querySelector('[data-testid="${testId}"]').focus()`);
    await sleep(100);
    await main.eval(`(() => { const i=document.querySelector('[data-testid="${testId}"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(100);
    await main.eval(`document.querySelector('[data-testid="${testId}"]').blur()`);
    await sleep(250);
  };
  await typeInto("clip-out", "3s");
  check("typing 3s in 'To' trims v2 to 3 s (total 12 s)", (await studioTime()).endsWith("/ 0:12.000"), await studioTime());
  // transition into v2
  await main.eval(`(() => { const s=document.querySelector('[data-testid="clip-transition"]'); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'fade'); s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await sleep(300);
  check("a 0.6 s cross fade overlaps the clips (total 11.4 s)", (await studioTime()).endsWith("/ 0:11.400"), await studioTime());

  // text
  await main.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Text').click()`);
  await sleep(200);
  await main.key("Home", { code: "Home", vk: 36 });
  await main.eval(`document.querySelector('[data-testid="add-text-Subtitle"]').click()`);
  await sleep(300);
  await main.eval(`(() => { const i=document.querySelector('[data-testid="text-content"]'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(i, 'Hello 100% Quin'); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(300);
  check("a subtitle is added on the text track and shown on the preview", (await main.eval(`document.querySelectorAll('[data-testid="studio-text-block"]').length`)) === 1 && (await main.eval(`document.querySelector('[data-testid="studio-text-overlay"]')?.textContent`)) === "Hello 100% Quin");

  // preview plays
  const msOf = (txt) => { const m = txt.match(/^(\d+):(\d+)\.(\d+)/); return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 + Number(m[3]) : 0; };
  const tBefore = msOf(await studioTime());
  await main.eval(`document.querySelector('[data-testid="studio-play"]').click()`);
  await sleep(2500);
  const playing = await main.eval(`(() => { const vs=[...document.querySelectorAll('[data-testid="studio-stage"] video')]; return vs.some(v => !v.paused && v.currentTime > 0.5); })()`);
  const tPlay = await studioTime();
  const playedMs = msOf(tPlay) - tBefore;
  await main.eval(`document.querySelector('[data-testid="studio-play"]').click()`);
  check("Play runs the preview in real time (a video plays, ≥1.5 s of the 2.5 s waited)", playing && playedMs >= 1500, `${tPlay} (+${playedMs} ms)`);
  await main.shot(path.join(outDir, "s02-studio-preview.png"));

  // the project is saved; add music through the saved file, reopen it from the list
  await sleep(1500);
  const list = await invoke("studio_list");
  check("the project was saved automatically", Array.isArray(list) && list.length === 1 && list[0].clips.length === 4, JSON.stringify(list?.map?.((p) => p.clips.length)));
  const proj = list[0];
  proj.audio = [{ id: "m1", path: music, name: "music.m4a", startMs: 1000, srcInMs: 0, srcOutMs: 8000, volume: 0.6, fadeInMs: 500, fadeOutMs: 1000 }];
  proj.name = "E2E Studio";
  proj.resolution = 720;
  await invoke("studio_save", { project: proj });
  await main.eval(`(() => { const s=document.querySelector('[data-testid="studio-projects"]'); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'__new'); s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await sleep(500);
  await main.eval(`(() => { const s=document.querySelector('[data-testid="studio-projects"]'); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,${JSON.stringify(proj.id)}); s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(() => main.eval(`document.querySelectorAll('[data-testid="studio-audio-block"]').length === 1`), 5000).catch(() => {});
  check("reopening the project shows its clips, text and music", (await clips()).length === 4 && (await main.eval(`document.querySelectorAll('[data-testid="studio-audio-block"]').length`)) === 1);

  // export
  await main.eval(`document.querySelector('[data-testid="studio-export"]').click()`);
  await waitFor(() => main.eval(`!!document.querySelector('[data-testid="studio-done"]') || /Failed:/.test(document.body.innerText)`), 180000, 500);
  const out = path.join(root, "Quin Studio", "E2E Studio.mp4");
  check("Export finishes into the library's 'Quin Studio' folder", existsSync(out), await main.eval(`document.body.innerText.match(/Failed:.*/)?.[0] ?? ''`));
  if (existsSync(out)) {
    const pr = probe(out);
    check("…1280×720 with sound", pr.w === 1280 && pr.h === 720 && pr.audio, `${pr.w}x${pr.h} audio=${pr.audio}`);
    check("…11.4 s long", Math.abs(pr.dur - 11.4) < 0.25, `${pr.dur}`);
  }
  await main.shot(path.join(outDir, "s03-studio-export.png"));

  // ================================================================ AI enhance (downloads the tools, needs a Vulkan GPU)
  await app.clickText("All Media");
  await sleep(1000);
  const runAi = async (choices, expectName) => {
    await openViewer("v1");
    await main.eval(`document.querySelector('[data-testid="viewer-ai"]').click()`);
    await waitFor(() => main.eval(`!!document.querySelector('[data-testid="enhance-dialog"]') && /fps ·/.test(document.querySelector('[data-testid="enhance-dialog"]').innerText)`), 15000);
    for (const c of choices) {
      await main.eval(`document.querySelector('[data-testid="${c}"]').click()`);
      await sleep(200);
    }
    if (await main.eval(`!!document.querySelector('[data-testid="ai-install"]')`)) {
      await main.eval(`document.querySelector('[data-testid="ai-install"]').click()`);
      await waitFor(() => main.eval(`!document.querySelector('[data-testid="ai-install"]') || /Failed|error/i.test(document.querySelector('[data-testid="enhance-dialog"]').innerText)`), 300000, 500);
    }
    await main.shot(path.join(outDir, `a-${expectName}-ready.png`));
    await main.eval(`document.querySelector('[data-testid="ai-start"]').click()`);
    await sleep(3000);
    await main.shot(path.join(outDir, `a-${expectName}-running.png`));
    await waitFor(() => main.eval(`!!document.querySelector('[data-testid="ai-done"]') || /Failed:/.test(document.querySelector('[data-testid="enhance-dialog"]')?.innerText ?? '')`), 600000, 1000);
    const txt = await main.eval(`document.querySelector('[data-testid="enhance-dialog"]').innerText`);
    await main.key("Escape", { code: "Escape", vk: 27 });
    await sleep(300);
    const dialogGone = !(await main.eval(`!!document.querySelector('[data-testid="enhance-dialog"]')`));
    const viewerStill = await main.eval(`!!document.querySelector('${VIEWER}')`);
    await closeViewer().catch(() => {});
    return { txt, dialogGone, viewerStill, out: path.join(root, "videos", expectName) };
  };
  const st = await invoke("ai_status");
  let r = await runAi(["ai-mode-smooth", "ai-factor-2", "ai-quality-best"], "v1 (60 fps).mp4");
  check("AI smooth: the dialog downloads RIFE and makes 'v1 (60 fps).mp4'", existsSync(r.out), r.txt.split("\n").slice(-4).join(" | "));
  check("…Escape closes only the dialog, the viewer stays", r.dialogGone && r.viewerStill);
  if (existsSync(r.out)) {
    const p = probe(r.out);
    const fps = execFileSync(path.join(path.dirname(FFMPEG), "ffprobe-x86_64-pc-windows-msvc.exe"), ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=avg_frame_rate,nb_read_frames", "-of", "csv=p=0", r.out], { encoding: "utf8" }).trim();
    check("…60 fps, 360 frames, 6 s, 640×360, with sound", /^60\/1,360$/.test(fps) && Math.abs(p.dur - 6) < 0.15 && p.w === 640 && p.h === 360 && p.audio, `${fps} ${p.dur}s ${p.w}x${p.h} audio=${p.audio}`);
  }
  r = await runAi(["ai-mode-sharpen", "ai-content-real", "ai-size-2x"], "v1 (AI 2x).mp4");
  check("AI sharpen: downloads Real-ESRGAN and makes 'v1 (AI 2x).mp4'", existsSync(r.out), r.txt.split("\n").slice(-4).join(" | "));
  if (existsSync(r.out)) {
    const p = probe(r.out);
    check("…1280×720, 6 s, with sound", p.w === 1280 && p.h === 720 && Math.abs(p.dur - 6) < 0.15 && p.audio, `${p.w}x${p.h} ${p.dur}s`);
  }
  const st2 = await invoke("ai_status");
  check("the tools live in the test's data folder (bin/ai) and a GPU was found", existsSync(path.join(dataDir, "bin", "ai", "rife", "rife-ncnn-vulkan.exe")) && !!st2.gpu, `${JSON.stringify(st)} → ${JSON.stringify(st2)}`);
} catch (e) {
  check("no unexpected error", false, String(e?.stack ?? e));
} finally {
  await app?.quit();
}
summary();
