// Probe: a drag on a playing video moves its card, and a plain
// click still reaches the video controls. Also covers the heal:
// a video card saved at the stale 16:9 height (360x203) for a
// 4:3 clip is resized to the video's own ratio (360x270) once
// its poster loads. Requires `npm run build` first. Run under
// xvfb-run -a. Not part of the e2e suite: run it by hand when
// the video drag or sizing changes.
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-video-drag-"));
const boardPath = path.join(tmp, "board.json");
const dataHome = path.join(tmp, "data");
const configHome = path.join(tmp, "config");
const pluginsDir = path.join(tmp, "plugins");
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });

const asset = (name) => path.join(repoRoot, "assets", name);
// The 4:3 clip (384x288) at the stale 16:9 card size: the heal
// should take it to 360x270 once the poster loads.
const board = {
  items: [
    { id: 1, group: null, pos: { x: 200, y: 200 }, size: { w: 360, h: 203 }, kind: { Video: { source: asset("welcome-video.mp4"), remote: false, size_bytes: 458653 } } },
  ],
  camera: { x: 0, y: 0, zoom: 1 },
  next_id: 2,
  next_group: 1,
  bg: "#FFFFFF",
  grid: "Dots",
};
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
const cardSel = `#cards .card[data-id="1"]`;
await page.locator(cardSel).first().waitFor({ timeout: 30000 });

// The backfill captures the poster, the heal resizes the card.
await page.waitForFunction(() => {
  const card = document.querySelector(`#cards .card[data-id="1"]`);
  if (!card) return false;
  const r = card.getBoundingClientRect();
  return Math.abs(r.height - 270) <= 2;
}, { timeout: 30000 }).catch(() => fail("card did not heal to 360x270 once the poster loaded"));
const healed = await page.evaluate(() => {
  const card = document.querySelector(`#cards .card[data-id="1"]`);
  const r = card.getBoundingClientRect();
  return { w: r.width, h: r.height };
});
console.log("healed card size:", JSON.stringify(healed));
if (Math.abs(healed.h - 270) > 2) fail(`card height ${healed.h}, expected 270`);

// Press play on the poster: the live <video> mounts and plays.
const thumb = await page.locator(`${cardSel} .video-thumb`).first().boundingBox();
if (!thumb) fail("no poster play tile");
await page.mouse.click(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
await page.waitForFunction(() => {
  const v = document.querySelector(`#cards .card[data-id="1"] video`);
  return v && !v.paused && v.currentTime > 0;
}, { timeout: 30000 }).catch(() => fail("video did not start playing"));
console.log("video playing");

// Drag the playing video by its centre: the card must move,
// and the video must keep playing (not pause, not restart).
const before = await page.evaluate(() => {
  const card = document.querySelector(`#cards .card[data-id="1"]`);
  const v = card.querySelector("video");
  const r = card.getBoundingClientRect();
  return { x: r.x, y: r.y, t: v.currentTime, paused: v.paused, videos: document.querySelectorAll("video").length };
});
const cx = before.x + 180, cy = before.y + 135;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 80, cy + 40, { steps: 12 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 500));
const after = await page.evaluate(() => {
  const card = document.querySelector(`#cards .card[data-id="1"]`);
  const v = card.querySelector("video");
  const r = card.getBoundingClientRect();
  return { x: r.x, y: r.y, t: v ? v.currentTime : -1, paused: v ? v.paused : true, hasVideo: !!v, videos: document.querySelectorAll("video").length };
});
console.log("after drag:", JSON.stringify(after));
if (Math.abs(after.x - (before.x + 80)) > 5 || Math.abs(after.y - (before.y + 40)) > 5) {
  fail(`card did not move with the drag: before (${before.x},${before.y}) after (${after.x},${after.y})`);
}
if (!after.hasVideo) fail("live video element gone after the drag");
if (after.paused) fail("video paused by the drag");
if (after.t <= before.t) fail(`video time did not advance across the drag: ${before.t} -> ${after.t}`);
if (after.videos !== 1) fail(`expected 1 video element, found ${after.videos}`);

// A plain click on the video's control bar still reaches the
// controls: the play/pause button sits in the buttons row
// above the timeline, ~28px from the bottom (12px is the seek
// bar — a click there seeks instead of pausing).
const box = await page.locator(cardSel).first().boundingBox();
await page.mouse.move(box.x + 20, box.y + box.height - 28);
await new Promise((r) => setTimeout(r, 400));
await page.mouse.click(box.x + 20, box.y + box.height - 28);
await new Promise((r) => setTimeout(r, 500));
const clicked = await page.evaluate(() => {
  const v = document.querySelector(`#cards .card[data-id="1"] video`);
  return v ? { paused: v.paused } : null;
});
console.log("after control click:", JSON.stringify(clicked));
if (!clicked || !clicked.paused) fail("clicking the video controls did not pause it");

console.log("PASS: drag moves a playing video card, playback continues, controls still work");
await app.close();
process.exit(0);
