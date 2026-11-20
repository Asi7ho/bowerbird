// Probe: pinch-zoom frame times. Usage (after `npm run build`):
//   TMPDIR=~/workspace/perf-measure/e2e-tmp xvfb-run -a node scripts/probe-pinch.mjs [board.json]
// Launches the app, then pinches (Ctrl+wheel) in and out and
// records rAF frame deltas. A smooth pinch holds ~16.7ms;
// a periodic full render during the gesture shows as a
// repeating spike.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boardSrc = process.argv[2] ?? path.join(os.homedir(), "workspace", "perf-measure", "mixed", "board.json");
const boardPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-probe-")), "board.json");
const dataHome = path.join(path.dirname(boardPath), "data");
const configHome = path.join(path.dirname(boardPath), "config");
const pluginsDir = path.join(path.dirname(boardPath), "plugins");
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });
fs.copyFileSync(boardSrc, boardPath);
const count = JSON.parse(fs.readFileSync(boardPath, "utf8")).items.length;
console.log(`board: ${count} items from ${boardSrc}`);

const app = await electron.launch({
  executablePath: electronPath,
  args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  cwd: repoRoot,
  env: { ...process.env, BOWERBIRD_BOARD_PATH: boardPath, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome, BOWERBIRD_PLUGINS_DIR: pluginsDir },
});
const page = await app.firstWindow();
await page.waitForSelector("#board", { timeout: 60000 });
await page.waitForTimeout(2000);
// Count renders: patch the board's render by watching the
// card container's child changes is noisy; instead count
// how often the camera transform is applied vs how long
// frames take. We record rAF deltas with timestamps.
await page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => {
    window.__frames.push({ t, d: t - last });
    last = t;
    if (window.__recording) requestAnimationFrame(tick);
  };
  window.__recording = true;
  requestAnimationFrame(tick);
});
// Count card-DOM rebuilds (each render() sets #cards innerHTML):
// a rebuild during the gesture is the hitch. Before the fix
// there are several; after it, none until the gesture settles.
await page.evaluate(() => {
  window.__rebuilds = 0;
  const cards = document.querySelector("#cards");
  if (cards) {
    new MutationObserver(() => { window.__rebuilds++; }).observe(cards, { childList: true });
  }
});
// A pinch: hold Ctrl and wheel up (zoom in) then down (zoom out).
await page.keyboard.down("Control");
for (let i = 0; i < 40; i++) {
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(16);
}
for (let i = 0; i < 40; i++) {
  await page.mouse.wheel(0, 60);
  await page.waitForTimeout(16);
}
await page.keyboard.up("Control");
await page.waitForTimeout(500);
const rebuilds = await page.evaluate(() => window.__rebuilds);
console.log(`card-DOM rebuilds during the pinch: ${rebuilds}`);
const frames = await page.evaluate(() => {
  window.__recording = false;
  return window.__frames.filter((f) => f.d > 0 && f.d < 500);
});
const deltas = frames.map((f) => f.d).sort((a, b) => a - b);
const median = deltas[Math.floor(deltas.length / 2)] ?? 0;
const p95 = deltas[Math.floor(deltas.length * 0.95)] ?? 0;
const over = deltas.filter((d) => d > 34).length;
console.log(`pinch: n=${deltas.length} median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms frames>34ms=${over}`);
// Show the worst frames with their time into the gesture, so
// a periodic hitch (every ~250ms) is visible.
const start = frames[0]?.t ?? 0;
const worst = [...frames].sort((a, b) => b.d - a.d).slice(0, 8).sort((a, b) => a.t - b.t);
for (const f of worst) console.log(`  worst: +${(f.t - start).toFixed(0)}ms into gesture, ${f.d.toFixed(1)}ms`);
console.log(`final zoom: ${await page.evaluate(() => document.querySelector("#board") ? "board ok" : "no board")}`);
await app.close();
