// Verify the FileCard stale-height heal: a card saved at the old
// 360x294 (preview + 70) is shrunk to the ratio of its file
// (360x248) once its preview loads, while a card the user
// resized by hand and one already at the right size are left
// alone. Requires `npm run build` first. Run under xvfb-run -a.
// Not part of the e2e suite: run it by hand when the heal changes.
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-filecard-heal-"));
const boardPath = path.join(tmp, "board.json");
const dataHome = path.join(tmp, "data");
const configHome = path.join(tmp, "config");
const pluginsDir = path.join(tmp, "plugins");
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });

const asset = (name) => path.join(repoRoot, "assets", name);
// All three previews are the same 3:2 image (300x200), so the
// correct card height at 360 wide is 248 and the stale one is 294.
const preview = asset("welcome-garden-preview.png");
const items = [
  { id: 1, group: null, pos: { x: 100, y: 100 }, size: { w: 360, h: 294 }, kind: { FileCard: { path: "sample.ai", size_bytes: 1, format: "ai", preview } } },
  { id: 2, group: null, pos: { x: 500, y: 100 }, size: { w: 360, h: 280 }, kind: { FileCard: { path: "sample2.ai", size_bytes: 1, format: "ai", preview } } },
  { id: 3, group: null, pos: { x: 900, y: 100 }, size: { w: 360, h: 248 }, kind: { FileCard: { path: "sample3.ai", size_bytes: 1, format: "ai", preview } } },
];
const board = { items, camera: { x: 0, y: 0, zoom: 1 }, next_id: 4, next_group: 1, bg: "#FFFFFF", grid: "Dots" };
fs.writeFileSync(boardPath, JSON.stringify(board));

const app = await electron.launch({
  executablePath: electronPath,
  args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  cwd: repoRoot,
  env: { ...process.env, BOWERBIRD_BOARD_PATH: boardPath, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome, BOWERBIRD_PLUGINS_DIR: pluginsDir },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForSelector("#board", { timeout: 30000 });
// The preview image loads async and the heal runs on its
// onload, then re-renders. Poll until the stale card shrinks
// (or time out): the card height in the DOM is its board height.
let heights = null;
for (let i = 0; i < 20; i++) {
  heights = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll(".card.filecard")) {
      out[el.getAttribute("data-id")] = Math.round(el.getBoundingClientRect().height);
    }
    return out;
  });
  if (heights["1"] === 248) break;
  await page.waitForTimeout(500);
}
console.log("filecard heights:", JSON.stringify(heights));
const ok = heights["1"] === 248 && heights["2"] === 280 && heights["3"] === 248;
console.log(ok ? "HEAL OK: stale 294 -> 248, resized 280 kept, correct 248 kept" : "HEAL FAILED");
await app.close();
process.exit(ok ? 0 : 1);
