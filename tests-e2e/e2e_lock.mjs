// The lock screen: choosing a password on a fresh install, only a hash stored, wrong passwords
// refused, changing it in Settings.  Usage: node e2e_lock.mjs <exe> <outDir>
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FFMPEG, TEST_PASSWORD, makeChecker, sleep, spawnApp, waitFor } from "./qg_harness.mjs";

const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { check, summary } = makeChecker();
const dataDir = path.join(os.tmpdir(), "qg-e2e-lock-data");
rmSync(dataDir, { recursive: true, force: true });
const lockFile = path.join(dataDir, "lock.json");
// Settings lives in the sidebar, which needs a library open
const root = path.join(os.tmpdir(), "qg-e2e-lock-root");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:duration=1", "-frames:v", "1", path.join(root, "one.jpg")]);

let app;
try {
  app = await spawnApp(exe, dataDir); // fresh data: the harness fills the "choose a password" form
  const { main } = app;
  const locked = () => main.eval(`!!document.querySelector('input[type=password][aria-label="Password"]')`);
  check("a fresh install asks to choose a password, and that unlocks the app", !(await locked()) && existsSync(lockFile));
  const stored = existsSync(lockFile) ? readFileSync(lockFile, "utf8") : "";
  check("only a salted hash is stored in data/lock.json", stored.includes('"hash"') && stored.includes('"salt"') && !stored.includes(TEST_PASSWORD));

  const relock = async () => {
    await main.send("Page.reload");
    await waitFor(() => locked(), 20000);
    await sleep(500);
  };
  await relock();
  check("next launch: one password field (no 'choose' form)", (await main.eval(`document.querySelectorAll('input[type=password]').length`)) === 1);
  await app.unlock("wrong-password");
  check("a wrong password is refused", await locked());
  await main.shot(path.join(outDir, "l01-wrong.png"));
  await app.unlock(TEST_PASSWORD);
  check("the right one unlocks", !(await locked()));

  // change it in Settings
  await app.openRoot(root);
  await app.clickText("Settings");
  await waitFor(() => main.eval(`!!document.querySelector('[data-testid="lock-save"]')`), 5000);
  const fill = (id, v) =>
    main.eval(`(() => { const i=document.querySelector('[data-testid="${id}"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const msg = () => main.eval(`document.querySelector('[data-testid="lock-msg"]').textContent`);
  await fill("lock-current", "not-it");
  await fill("lock-new", "new-pass-1");
  await fill("lock-confirm", "new-pass-1");
  await main.eval(`document.querySelector('[data-testid="lock-save"]').click()`);
  await sleep(200);
  await waitFor(async () => (await msg()).trim().length > 0, 10000).catch(() => {});
  check("Settings refuses the change with a wrong current password", /current password is wrong/i.test(await msg()), await msg());
  await fill("lock-current", TEST_PASSWORD);
  await fill("lock-new", "new-pass-1");
  await fill("lock-confirm", "new-pass-1");
  await main.eval(`document.querySelector('[data-testid="lock-save"]').click()`);
  await sleep(200);
  await waitFor(async () => (await msg()).trim().length > 0, 10000).catch(() => {});
  check("…and accepts it with the right one", /changed/i.test(await msg()), await msg());
  await main.shot(path.join(outDir, "l02-changed.png"));

  await relock();
  await app.unlock(TEST_PASSWORD);
  check("after the change the old password no longer works", await locked());
  await app.unlock("new-pass-1");
  check("the new one does", !(await locked()));

  // the stored format is plain PBKDF2-HMAC-SHA256: a lock.json made elsewhere (Node's crypto) works too
  await app.quit();
  const { pbkdf2Sync, randomBytes } = await import("node:crypto");
  const salt = randomBytes(16);
  writeFileSync(lockFile, JSON.stringify({ salt: salt.toString("hex"), hash: pbkdf2Sync("compat-pass", salt, 100000, 32, "sha256").toString("hex"), iterations: 100000 }));
  app = await spawnApp(exe, dataDir); // its own TEST_PASSWORD attempt fails here
  check("a lock.json written by Node's PBKDF2 is read the same way (wrong one refused)", await app.main.eval(`!!document.querySelector('input[type=password][aria-label="Password"]')`));
  await app.unlock("compat-pass");
  check("…and its password unlocks", !(await app.main.eval(`!!document.querySelector('input[type=password][aria-label="Password"]')`)));
} catch (e) {
  check("no unexpected error", false, String(e?.stack ?? e));
} finally {
  await app?.quit();
}
summary();
