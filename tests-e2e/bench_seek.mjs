// How quickly a seek lands: asset:// (the webview's custom protocol) vs the local http file server.
// Usage: node bench_seek.mjs <exe>
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeVideo, spawnApp } from "./qg_harness.mjs";

const exe = process.argv[2];
const root = path.join(os.tmpdir(), "qg-bench-seek-root");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
makeVideo(path.join(root, "big.mp4"), { secs: 300, size: "1920x1080", gop: 250 });
const app = await spawnApp(exe, path.join(os.tmpdir(), "qg-bench-seek-data"));
await app.openRoot(root);
await app.waitScanned(1);
const page = await app.invoke("get_media_page", { query: { folder_rel_path: null, include_subfolders: true, media_type: "all", sort_by: "name", sort_desc: false, limit: 5, offset: 0 } });
const id = page.items[0].id;
const filePath = await app.invoke("get_media_file_path", { id });
const httpUrl = await app.invoke("get_media_stream_url", { id });
const assetUrl = await app.main.eval(`window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(filePath)}, 'asset')`);

async function bench(label, url) {
  const r = await app.main.eval(`(async () => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = ${JSON.stringify(url)};
    document.body.appendChild(v);
    const t0 = performance.now();
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('load error ' + (v.error && v.error.code))); });
    const open = performance.now() - t0;
    const times = [];
    let seed = 7;
    for (let i = 0; i < 20; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const t = (seed / 233280) * (v.duration - 5);
      const s = performance.now();
      await new Promise((res) => { v.onseeked = res; v.currentTime = t; });
      await new Promise((res) => requestAnimationFrame(() => res()));
      times.push(performance.now() - s);
    }
    // keep playing after seeks
    await v.play(); await new Promise(r => setTimeout(r, 1500));
    const advanced = v.currentTime;
    v.pause(); v.remove();
    times.sort((a, b) => a - b);
    return JSON.stringify({ open: Math.round(open), median: Math.round(times[10]), p90: Math.round(times[18]), max: Math.round(times[19]), playedTo: advanced.toFixed(2) });
  })()`);
  console.log(label.padEnd(8), r);
  return r;
}
console.log("urls", assetUrl, httpUrl);
for (let i = 0; i < 2; i++) {
  await bench("http", httpUrl);
  await bench("asset", assetUrl).catch((e) => console.log("asset  ", String(e).slice(0, 80)));
}
await app.quit();
process.exit(0);
