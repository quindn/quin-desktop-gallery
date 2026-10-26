// The search box: words in any order, no accents needed, Explorer filters, completions, folders,
// searching inside a folder, opening a file from the suggestions, recent searches.
// Usage: node e2e_search.mjs <exe> <outDir>
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { FFMPEG, makeChecker, makeVideo, sleep, spawnApp, waitFor } from "./qg_harness.mjs";

const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { check, summary } = makeChecker();
const root = path.join(os.tmpdir(), "qg-e2e-search-root");
const dataDir = path.join(os.tmpdir(), "qg-e2e-search-data");
for (const d of [root, dataDir]) rmSync(d, { recursive: true, force: true });
const dalat = path.join(root, "Trips", "2024 Đà Lạt");
for (const d of [dalat, path.join(root, "Family"), path.join(root, "Clips"), path.join(root, "Misc")]) mkdirSync(d, { recursive: true });
const jpg = path.join(os.tmpdir(), "qg-search-seed.jpg");
execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:duration=1", "-frames:v", "1", jpg]);
copyFileSync(jpg, path.join(dalat, "IMG_0001.jpg"));
copyFileSync(jpg, path.join(root, "Family", "Nguyễn Văn Đặng.jpg"));
for (let i = 0; i < 40; i++) copyFileSync(jpg, path.join(root, "Misc", `photo_${String(i).padStart(2, "0")}.jpg`));
makeVideo(path.join(dalat, "beach sunset.mp4"), { secs: 4, size: "640x360", gop: 30 });
makeVideo(path.join(root, "Clips", "funny cat.mp4"), { secs: 12, size: "1280x720", gop: 30 });
execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1", path.join(root, "Clips", "cat dance.gif")]);
const TOTAL = 45;

let app;
try {
  app = await spawnApp(exe, dataDir);
  const { main, invoke } = app;
  await app.openRoot(root);
  await app.waitScanned(TOTAL);
  await app.clickText("All Media");
  await sleep(1000);

  const all = (await invoke("get_media_page", { query: { folder_rel_path: null, include_subfolders: true, media_type: "all", sort_by: "name", sort_desc: false, limit: 1000, offset: 0 } })).items;
  const nameOf = (id) => all.find((i) => i.id === id)?.filename;
  const cardNames = () => main.eval(`JSON.stringify([...document.querySelectorAll('[data-media-id]')].map(e => Number(e.dataset.mediaId)))`).then((s) => JSON.parse(s).map(nameOf).sort());
  const total = () => main.eval(`document.body.innerText.match(/([\\d,.]+) items/)?.[1] ?? ''`);
  const IN = `document.querySelector('[data-testid="search-input"]')`;
  const value = () => main.eval(`${IN}.value`);
  const type = async (text, { clear = true } = {}) => {
    await main.eval(`${IN}.focus()`);
    if (clear) {
      await main.key("a", { code: "KeyA", vk: 65, ctrl: true });
      await main.key("Backspace", { code: "Backspace", vk: 8 });
    }
    await main.typeText(text);
    await sleep(700);
  };
  const expectCards = async (names, label) => {
    const want = [...names].sort();
    await waitFor(async () => JSON.stringify(await cardNames()) === JSON.stringify(want), 6000).catch(() => {});
    const got = await cardNames();
    check(label, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  };
  const chips = () => main.eval(`JSON.stringify([...document.querySelectorAll('[data-testid="search-chips"] [data-chip-kind]')].map(c => c.dataset.chipKind + ':' + c.textContent))`).then(JSON.parse);
  const rows = () => main.eval(`JSON.stringify([...document.querySelectorAll('[data-testid="search-row"]')].map(r => r.dataset.rowKey))`).then(JSON.parse);

  // ---------------------------------------------------------------- words
  await type("sunset beach");
  await expectCards(["beach sunset.mp4"], "words in any order: 'sunset beach' finds 'beach sunset.mp4'");
  await waitFor(async () => (await chips()).length === 2, 4000).catch(() => {});
  check("…the drop-down shows how it was read (two words)", JSON.stringify(await chips()) === JSON.stringify(["text:sunset", "text:beach"]), JSON.stringify(await chips()));
  check("…and the match in the suggestions, highlighted", await main.eval(`[...document.querySelectorAll('[data-testid="search-row"] b')].some(b => /beach|sunset/.test(b.textContent))`));
  await main.shot(path.join(outDir, "q01-words.png"));
  await type("dang");
  await expectCards(["Nguyễn Văn Đặng.jpg"], "no accents needed: 'dang' finds 'Nguyễn Văn Đặng.jpg'");
  await type("da lat");
  await expectCards(["IMG_0001.jpg", "beach sunset.mp4"], "folder names count: 'da lat' finds both files in '2024 Đà Lạt'");
  await type("cat -funny");
  await expectCards(["cat dance.gif"], "'-word' excludes: 'cat -funny'");
  await type("sunset OR dance");
  await expectCards(["beach sunset.mp4", "cat dance.gif"], "'OR': 'sunset OR dance'");
  await type("*.gif");
  await expectCards(["cat dance.gif"], "wildcards: '*.gif'");

  // ---------------------------------------------------------------- filters
  await type("kind:video");
  await expectCards(["beach sunset.mp4", "funny cat.mp4"], "kind:video");
  await waitFor(async () => (await chips()).length === 1, 4000).catch(() => {});
  check("…shown as the 'Videos' filter chip", JSON.stringify(await chips()) === JSON.stringify(["filter:Videos"]), JSON.stringify(await chips()));
  await type("duration:>10s");
  await expectCards(["funny cat.mp4"], "duration:>10s");
  await type("res:720p");
  await expectCards(["funny cat.mp4"], "res:720p");
  await type("kind:photo folder:family");
  await expectCards(["Nguyễn Văn Đặng.jpg"], "two filters together: kind:photo folder:family");
  await type("date:today photo_0");
  check("date:today with words: the 10 files photo_00…09", (await total()) === "10" || (await cardNames()).length === 10, `${await total()} / ${(await cardNames()).length}`);
  await type("size:banana cat");
  await waitFor(async () => (await chips()).some((c) => c.startsWith("unknown:")), 4000).catch(() => {});
  check("a filter it can't read is shown crossed out (and ignored)", (await chips()).some((c) => c.startsWith("unknown:size:banana")), JSON.stringify(await chips()));
  await expectCards(["cat dance.gif", "funny cat.mp4"], "…while the rest still searches");

  // ---------------------------------------------------------------- completions
  await type("si");
  await waitFor(async () => (await rows()).includes("f-size:"), 3000).catch(() => {});
  check("typing 'si' suggests the size: filter", (await rows()).includes("f-size:"), JSON.stringify(await rows()));
  await main.key("Tab", { code: "Tab", vk: 9 });
  await sleep(300);
  check("Tab completes it", (await value()) === "size:", await value());
  await main.typeText("hu");
  await sleep(500);
  check("…then suggests its values ('hu' → size:huge)", (await rows()).includes("v-size:huge"), JSON.stringify(await rows()));
  await main.shot(path.join(outDir, "q02-completion.png"));

  // ---------------------------------------------------------------- folders, searching inside one
  await type("da lat");
  await waitFor(async () => (await rows()).some((r) => r.startsWith("dir-")), 4000).catch(() => {});
  const dirRow = (await rows()).find((r) => r.startsWith("dir-"));
  check("matching folders are suggested", dirRow === "dir-Trips/2024 Đà Lạt", JSON.stringify(await rows()));
  await main.eval(`document.querySelector('[data-row-key="${dirRow}"]').click()`);
  await sleep(1200);
  await expectCards(["IMG_0001.jpg", "beach sunset.mp4"], "clicking it opens that folder (and clears the search)");
  check("…the box now searches inside it", (await main.eval(`${IN}.placeholder`)) === "Search this folder…" && (await main.eval(`/in 2024 Đà Lạt/.test(document.querySelector('[data-testid="search-box"]').innerText)`)));
  await type("beach");
  await expectCards(["beach sunset.mp4"], "searching inside the folder");
  await type("cat");
  await waitFor(() => main.eval(`!!document.querySelector('[data-testid="search-empty"]')`), 4000).catch(() => {});
  check("nothing in this folder: it says so and offers the whole library", await main.eval(`/Nothing matches in 2024 Đà Lạt/.test(document.querySelector('[data-testid="search-empty"]')?.innerText ?? '')`));
  await main.shot(path.join(outDir, "q03-scoped-empty.png"));
  await main.eval(`[...document.querySelectorAll('[data-testid="search-empty"] button')][0].click()`);
  await sleep(1000);
  await expectCards(["cat dance.gif", "funny cat.mp4"], "'Search the whole library' widens it");

  // ---------------------------------------------------------------- open a file from the suggestions
  await type("funny");
  await waitFor(async () => (await rows()).some((r) => r.startsWith("file-")), 4000).catch(() => {});
  const fileIdx = (await rows()).findIndex((r) => r.startsWith("file-"));
  for (let i = 0; i <= fileIdx; i++) await main.key("ArrowDown", { code: "ArrowDown", vk: 40 });
  await main.key("Enter", { code: "Enter", vk: 13 });
  await waitFor(() => main.eval(`!!document.querySelector('div[class*="z-[100]"]')`), 8000).catch(() => {});
  check("↓ + Enter on a suggested file opens it in the viewer", (await main.eval(`document.querySelector('div[class*="z-[100]"] .truncate')?.textContent`)) === "funny cat.mp4");
  await main.shot(path.join(outDir, "q04-opened.png"));
  await main.key("Escape", { code: "Escape", vk: 27 });
  await sleep(500);

  // ---------------------------------------------------------------- recents, Esc, Ctrl+F
  await type("");
  await sleep(300);
  check("with an empty box: recent searches are listed", (await rows()).includes("r-funny"), JSON.stringify(await rows()));
  await main.eval(`${IN}.blur()`);
  await main.eval(`document.querySelector('[data-media-id]')?.click()`);
  await sleep(200);
  await main.key("f", { code: "KeyF", vk: 70, ctrl: true });
  await sleep(300);
  check("Ctrl+F jumps to the search box", await main.eval(`document.activeElement === ${IN}`));
  await main.typeText("kind:video");
  await sleep(800);
  await main.key("Escape", { code: "Escape", vk: 27 });
  await main.key("Escape", { code: "Escape", vk: 27 });
  await sleep(800);
  check("Esc closes the drop-down, then clears the search", (await value()) === "" && (await total()) === String(TOTAL), `"${await value()}" ${await total()}`);
} catch (e) {
  check("no unexpected error", false, String(e?.stack ?? e));
} finally {
  await app?.quit();
}
summary();
