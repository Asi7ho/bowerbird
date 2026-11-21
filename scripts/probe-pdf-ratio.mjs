// Verify the PdfCard stale-size heal: a card saved at the old
// fixed size (260x360) is resized to the ratio of its first
// page (260x174 for the landscape 200x100 sample PDF) once the
// page loads, while a card the user resized by hand and one
// already at the right size are left alone. Requires
// `npm run build` first. Run under xvfb-run -a.
// Not part of the e2e suite: run it by hand when the heal changes.
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-pdf-heal-"));
const boardPath = path.join(tmp, "board.json");
const dataHome = path.join(tmp, "data");
const configHome = path.join(tmp, "config");
const pluginsDir = path.join(tmp, "plugins");
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });

const fixture = (name) => path.join(repoRoot, "tests", "e2e", "fixtures", name);
// The sample PDF's first page is 200x100 (landscape), so the
// correct card at 260 wide is 260x174; the stale fixed size
// is 260x360. Copy it into the probe dir so the app-file
// scheme serves it like a real board's.
fs.copyFileSync(fixture("sample.pdf"), path.join(tmp, "probe-sample.pdf"));
const local = (name) => path.join(tmp, name);
const items = [
  { id: 1, group: null, pos: { x: 100, y: 100 }, size: { w: 260, h: 360 }, kind: { PdfCard: { path: local("probe-sample.pdf"), size_bytes: 583 } } },
  { id: 2, group: null, pos: { x: 500, y: 100 }, size: { w: 260, h: 280 }, kind: { PdfCard: { path: local("probe-sample.pdf"), size_bytes: 583 } } },
  { id: 3, group: null, pos: { x: 900, y: 100 }, size: { w: 260, h: 174 }, kind: { PdfCard: { path: local("probe-sample.pdf"), size_bytes: 583 } } },
];
const board = { items, camera: { x: 0, y: 0, zoom: 1 }, next_id: 4, next_group: 1, bg: "#FFFFFF", grid: "Dots" };
fs.writeFileSync(boardPath, JSON.stringify(board));

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const app = await electron.launch({
  executablePath: electronPath,
  args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  cwd: repoRoot,
  env: { ...process.env, BOWERBIRD_BOARD_PATH: boardPath, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome, BOWERBIRD_PLUGINS_DIR: pluginsDir },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForSelector("#board", { timeout: 30000 });
// The PDF loads async and the heal runs once the first page
// is measured, then re-renders. Poll until the stale card
// shrinks (or time out): the card height in the DOM is its
// board height.
let heights = null;
for (let i = 0; i < 30; i++) {
  heights = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll("#cards .card")) {
      const id = el.getAttribute("data-id");
      if (el.querySelector("[data-pdf-canvas]")) out[id] = Math.round(el.getBoundingClientRect().height);
    }
    return out;
  });
  if (heights["1"] === 174) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log("pdf heights:", JSON.stringify(heights));
if (heights["1"] !== 174) fail(`stale card 1 is ${heights["1"]} tall, expected 174`);
if (heights["2"] !== 280) fail(`hand-resized card 2 is ${heights["2"]} tall, expected 280`);
if (heights["3"] !== 174) fail(`correct card 3 is ${heights["3"]} tall, expected 174`);
// The heal also saves to disk, so the board on disk agrees.
const saved = JSON.parse(fs.readFileSync(boardPath, "utf8"));
const saved1 = saved.items.find((it) => it.id === 1);
if (!saved1 || saved1.size.h !== 174) fail(`stale card 1 on disk is ${saved1?.size.h}, expected 174`);
console.log("HEAL OK: stale 360 -> 174, hand-resized 280 kept, correct 174 kept");
await app.close();
process.exit(0);
