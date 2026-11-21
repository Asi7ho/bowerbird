// Screenshot a board with one of each media card, for a visual
// check of the card layouts (no descriptive subtitles; the
// PSD/AI pill on design-file previews). Saves one PNG next to
// this script. Requires `npm run build` first. Run under
// xvfb-run -a. Not part of the e2e suite: run it by hand when
// a card layout changes.
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-cards-shot-"));
const boardPath = path.join(tmp, "board.json");
const dataHome = path.join(tmp, "data");
const configHome = path.join(tmp, "config");
const pluginsDir = path.join(tmp, "plugins");
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });

const asset = (name) => path.join(repoRoot, "assets", name);
const fixture = (name) => path.join(repoRoot, "tests", "e2e", "fixtures", name);
// The app-file scheme only serves board-local files and
// bundle assets: a PDF or model pointed at the repo's
// fixtures dir 404s, so the PDF falls back to its tile
// and the model to a blank canvas. Copy those two into
// the probe's own dir so they load like a real board's.
for (const name of ["sample.pdf", "cube.glb"]) {
  fs.copyFileSync(fixture(name), path.join(tmp, name));
}
const local = (name) => path.join(tmp, name);
let id = 1;
const items = [];
const add = (pos, size, kind) => {
  items.push({ id: id++, group: null, pos, size, kind });
};
// One of each media card, laid out in a grid.
add({ x: 100, y: 100 }, { w: 360, h: 280 }, { Image: { path: asset("welcome-bower.jpg") } });
add({ x: 500, y: 100 }, { w: 300, h: 140 }, { UrlCard: { url: "https://example.com", title: "Example Domain", description: "A sample link card that should not show", image: null, icon: null, embed: false } });
add({ x: 840, y: 100 }, { w: 300, h: 280 }, { PdfCard: { path: local("sample.pdf"), size_bytes: 729 } });
add({ x: 100, y: 420 }, { w: 360, h: 225 }, { FileCard: { path: fixture("sample.psd"), size_bytes: 123456, format: "psd", preview: asset("welcome-bower.jpg") } });
add({ x: 500, y: 420 }, { w: 360, h: 240 }, { FileCard: { path: fixture("sample.ai"), size_bytes: 98765, format: "ai", preview: asset("welcome-garden-preview.png") } });
add({ x: 900, y: 420 }, { w: 360, h: 280 }, { Video: { source: asset("welcome-video.mp4"), remote: false, size_bytes: 458653 } });
add({ x: 100, y: 740 }, { w: 360, h: 280 }, { Model3D: { path: local("cube.glb"), size_bytes: 12345 } });
add({ x: 500, y: 740 }, { w: 360, h: 164 }, { Audio: { path: asset("welcome-birdsong.mp3"), transcript: "The quick brown fox jumps over the lazy dog." } });
const board = { items, camera: { x: 0, y: 0, zoom: 1 }, next_id: id, next_group: 1, bg: "#FFFFFF", grid: "Dots" };
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
await page.waitForTimeout(2000);
// Fit the whole board, then give the PDF page, the video
// poster and the 3D model time to render before the shot.
await page.keyboard.press("f");
await page.waitForTimeout(5000);
const out = path.join(repoRoot, "scripts", "cards-shot.png");
await page.screenshot({ path: out });
console.log(`saved ${out}`);
await app.close();
process.exit(0);
