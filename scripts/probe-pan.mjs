// Probe: pan frame times on a realistic board, with and
// without backdrop-filter. Usage (after `npm run build`):
//   TMPDIR=~/workspace/perf-measure/e2e-tmp xvfb-run -a node scripts/probe-pan.mjs [board.json]
// Launches the app, waits for the board, then pans by
// dispatching wheel events and records rAF frame deltas.
// Reports median / p95 frame time, first with the app's
// own CSS, then with backdrop-filter disabled (injected).
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

async function measurePan(label) {
  // Record rAF deltas while dispatching wheel events.
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (window.__recording) requestAnimationFrame(tick);
    };
    window.__recording = true;
    requestAnimationFrame(tick);
  });
  // A steady pan: 60 wheel ticks, 16ms apart.
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(300);
  const frames = await page.evaluate(() => {
    window.__recording = false;
    const f = window.__frames.slice();
    window.__frames = [];
    return f.filter((d) => d > 0 && d < 500);
  });
  frames.sort((a, b) => a - b);
  const median = frames[Math.floor(frames.length / 2)] ?? 0;
  const p95 = frames[Math.floor(frames.length * 0.95)] ?? 0;
  const over = frames.filter((d) => d > 34).length;
  console.log(`${label}: n=${frames.length} median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms frames>34ms=${over}`);
}

await measurePan("warm-up (discard)");
await measurePan("backdrop-filter ON ");
// Turn off every backdrop-filter (toolbar, palettes, colour
// bar, card pills) and re-measure the same pan.
await page.addStyleTag({ content: "* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }" });
await page.waitForTimeout(300);
await measurePan("backdrop-filter OFF");
// Remove the injected style and measure the real CSS again,
// so warm-up is not mistaken for the fix.
await page.evaluate(() => {
  for (const el of document.querySelectorAll("style")) {
    if (el.textContent?.includes("backdrop-filter: none")) el.remove();
  }
});
await page.waitForTimeout(300);
await measurePan("backdrop-filter ON again");

await app.close();
