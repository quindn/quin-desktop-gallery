// Live watching in the real app, restoring the library after the app db breaks, and the after-crash
// check of the library db. Usage: node e2e_watch.mjs <exe> <outDir>
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { FFMPEG, killApp, makeChecker, sleep, spawnApp, waitFor } from "./qg_harness.mjs";

const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { check, summary } = makeChecker();
const root = path.join(os.tmpdir(), "qg-e2e-watch-root");
const outside = path.join(os.tmpdir(), "qg-e2e-watch-outside");
const dataDir = path.join(os.tmpdir(), "qg-e2e-watch-data");
for (const d of [root, outside, dataDir]) rmSync(d, { recursive: true, force: true });
const jpg = path.join(os.tmpdir(), "qg-seed.jpg");
if (!existsSync(jpg)) execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=96x64:duration=1", "-frames:v", "1", jpg]);
for (let f = 0; f < 10; f++) {
  mkdirSync(path.join(root, `album ${f}`), { recursive: true });
  for (let i = 0; i < 30; i++) copyFileSync(jpg, path.join(root, `album ${f}`, `p${i}.jpg`));
}
const rels = async (app) => {
  const q = { folder_rel_path: null, include_subfolders: true, media_type: "all", sort_by: "name", sort_desc: false, limit: 5000, offset: 0 };
  const p = await app.invoke("get_media_page", { query: q });
  return new Set((p.items ?? []).map((i) => i.rel_path));
};
async function until(app, cond, ms = 10000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (cond(await rels(app))) return Date.now() - t;
    await sleep(50);
  }
  return null;
}
const fast = (ms) => ms !== null && ms < 1500;

let app;
try {
  app = await spawnApp(exe, dataDir);
  await app.openRoot(root);
  await app.waitScanned(300);
  await sleep(4000);

  copyFileSync(jpg, path.join(root, "album 0", "new.jpg"));
  let ms = await until(app, (s) => s.has("album 0/new.jpg"));
  check("a new file in an existing folder shows up at once", fast(ms), `${ms} ms`);
  mkdirSync(path.join(root, "fresh"));
  for (let i = 0; i < 25; i++) copyFileSync(jpg, path.join(root, "fresh", `f${i}.jpg`));
  ms = await until(app, (s) => [...s].filter((r) => r.startsWith("fresh/")).length === 25);
  check("a new folder with 25 files shows up at once", fast(ms), `${ms} ms`);
  renameSync(path.join(root, "album 0", "new.jpg"), path.join(root, "album 0", "renamed.jpg"));
  ms = await until(app, (s) => s.has("album 0/renamed.jpg") && !s.has("album 0/new.jpg"));
  check("a renamed file: old name gone, new name there", fast(ms), `${ms} ms`);
  renameSync(path.join(root, "fresh"), path.join(root, "fresh renamed"));
  ms = await until(app, (s) => [...s].filter((r) => r.startsWith("fresh renamed/")).length === 25 && ![...s].some((r) => r.startsWith("fresh/")));
  check("a renamed folder moves all its files", fast(ms), `${ms} ms`);
  mkdirSync(path.join(outside, "moved in", "deep"), { recursive: true });
  for (let i = 0; i < 5; i++) copyFileSync(jpg, path.join(outside, "moved in", "deep", `m${i}.jpg`));
  renameSync(path.join(outside, "moved in"), path.join(root, "moved in"));
  ms = await until(app, (s) => [...s].filter((r) => r.startsWith("moved in/deep/")).length === 5);
  check("a folder moved in from elsewhere (with a sub-folder) is indexed", fast(ms), `${ms} ms`);
  rmSync(path.join(root, "album 1"), { recursive: true });
  ms = await until(app, (s) => ![...s].some((r) => r.startsWith("album 1/")));
  check("a deleted folder's files disappear", fast(ms), `${ms} ms`);
  rmSync(path.join(root, "album 2", "p0.jpg"));
  ms = await until(app, (s) => !s.has("album 2/p0.jpg"));
  check("a deleted file disappears", fast(ms), `${ms} ms`);
  const big = path.join(root, "album 3", "growing.jpg");
  const fd = openSync(big, "w");
  const chunk = Buffer.alloc(64 * 1024, 7);
  for (let i = 0; i < 20; i++) {
    writeSync(fd, chunk);
    await sleep(100);
  }
  closeSync(fd);
  const finalSize = statSync(big).size;
  ms = await until(app, (s) => s.has("album 3/growing.jpg"), 8000);
  const row = (await app.invoke("get_media_page", { query: { folder_rel_path: "album 3", include_subfolders: false, media_type: "all", sort_by: "name", sort_desc: false, limit: 100, offset: 0, search: "growing" } })).items[0];
  check("a file still being written is indexed once it is complete (its full size)", ms !== null && row?.file_size === finalSize, `${ms} ms, size ${row?.file_size} of ${finalSize}`);
  const folders = await app.invoke("get_folders");
  check("the folder tree follows (counts, removed folders)", folders.find((f) => f.rel_path === "fresh renamed")?.media_count === 25 && !folders.some((f) => f.rel_path === "album 1" || f.rel_path === "fresh"));

  // ---- the app db is corrupted between runs: the library is found again on its own
  await app.quit();
  writeFileSync(path.join(dataDir, "app.db"), "garbage, not a database");
  rmSync(path.join(dataDir, "app.db-wal"), { force: true });
  rmSync(path.join(dataDir, "app.db-shm"), { force: true });
  app = await spawnApp(exe, dataDir);
  const reopened = await waitFor(async () => /total media/i.test(await app.text()), 30000).then(() => true).catch(() => false);
  const t1 = await app.text();
  check("a corrupted app db: the library still opens on its own (no 'choose a folder')", reopened && !/Choose Gallery Root Folder/i.test(t1));
  check("…and it says it restored automatically", /restored the last library automatically/i.test(t1));
  await app.quit();

  // ---- a crash damages the library db
  const dbDir = path.join(dataDir, "roots", readdirSync(path.join(dataDir, "roots"))[0]);
  const db = path.join(dbDir, "library.db");
  await (async () => {
    await spawnApp(exe, dataDir);
    await sleep(3000);
    killApp(path.basename(exe));
    await sleep(1500);
  })();
  const size = statSync(db).size;
  const fdb = openSync(db, "r+");
  writeSync(fdb, Buffer.alloc(4096, 0xab), 0, 4096, Math.floor(size / 4096 / 2) * 4096);
  closeSync(fdb);
  app = await spawnApp(exe, dataDir);
  const opened = await waitFor(async () => /total media/i.test(await app.text()), 30000).then(() => true).catch(() => false);
  check("after the crash, the library still opens on its own", opened);
  const damaged = await waitFor(async () => {
    const t = await app.text();
    return /damaged by the last crash|index needed to be rebuilt/i.test(t) ? t : null;
  }, 40000).catch(() => null);
  check("the damage is found and reported", !!damaged);
  if (damaged && /damaged by the last crash/.test(damaged)) {
    check("…with a 'Restart now' button", await app.main.eval(`!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restart now')`));
    killApp(path.basename(exe));
    await sleep(1500);
    app = await spawnApp(exe, dataDir);
    check("after the restart the index is rebuilt (and says so)", await waitFor(async () => /index needed to be rebuilt/i.test(await app.text()), 30000).then(() => true).catch(() => false));
    check("…the damaged file is kept aside", readdirSync(dbDir).some((f) => f.includes(".corrupt-")));
  }
  check("the rebuilt index finds all the files again", await waitFor(async () => (await rels(app)).size >= 280, 60000).then(() => true).catch(() => false), `${(await rels(app)).size} files`);
} catch (e) {
  check("E2E run", false, String(e).slice(0, 600) + " @ " + String(e.stack).split("\n")[1]);
} finally {
  const failed = summary();
  if (app) await app.quit();
  process.exit(failed ? 1 : 0);
}
