// Focused probe: do the rewired board keys still work?
// Launches the built Electron app (like the e2e does) and
// presses v/p/r/x/a, [, ], +/-, 0, f, ctrl+z/y, ctrl+,, ctrl+f
// and Enter, reading back the tool / selection / UI after each.
// Requires `npm run build` first. Run under xvfb-run -a.
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-keys-probe-"));
const boardPath = path.join(tmp, "board.json");
const dataHome = path.join(tmp, "data");
const configHome = path.join(tmp, "config");
const pluginsDir = path.join(tmp, "plugins");
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });
const board = {
  items: [
    { id: 1, pos: { x: 300, y: 300 }, size: { w: 200, h: 100 }, group: null, kind: { Text: { text: "hello", bold: false, size: 16, color: "#000000" } } },
  ], camera: { x: 0, y: 0, zoom: 1 }, next_id: 2, next_group: 1, bg: "#FFFFFF", grid: "Dots"
};
fs.writeFileSync(boardPath, JSON.stringify(board));

const app = await electron.launch({
  executablePath: electronPath,
  args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  cwd: repoRoot,
  env: { ...process.env, BOWERBIRD_BOARD_PATH: boardPath, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome, BOWERBIRD_PLUGINS_DIR: pluginsDir },
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.waitForSelector("#board", { timeout: 30000 });
await page.waitForTimeout(1500);

const toolOf = () => page.evaluate(() => {
  const active = (id) => document.getElementById(id)?.classList.contains("active");
  if (active("tool-select")) return "select";
  if (active("tool-connector")) return "connector";
  if (active("tool-draw")) return "draw:" + document.getElementById("tool-draw").dataset.draw;
  if (active("tool-shape")) return "shape:" + document.getElementById("tool-shape").dataset.shape;
  if (active("tool-eraser")) return "eraser";
  return "unknown";
});
const zoomLabel = () => page.evaluate(() => document.querySelector("#zoom-label")?.textContent);

const out = {};
await page.keyboard.press("p"); out.p = await toolOf();
await page.keyboard.press("v"); out.v = await toolOf();
await page.keyboard.press("a"); out.a = await toolOf();
await page.keyboard.press("r"); out.r = await toolOf();
await page.keyboard.press("x"); out.x = await toolOf();
await page.keyboard.press("v"); out.v2 = await toolOf();
// Select the note, then rotate it with [.
await page.mouse.click(400, 350);
await page.waitForTimeout(300);
out.selected = await page.evaluate(() => document.querySelector(".card.selected") ? "yes" : "no");
// Zoom keys.
out.zoom0 = await zoomLabel();
await page.keyboard.press("=");
out.zoomIn = await zoomLabel();
await page.keyboard.press("-");
out.zoomOut = await zoomLabel();
await page.keyboard.press("0");
out.zoomReset = await zoomLabel();
// f zooms to fit.
await page.keyboard.press("f"); out.f = "pressed";
// Reset the view so the coordinates below land on the note.
await page.keyboard.press("0");
// ctrl+f focuses search.
await page.keyboard.press("Control+f");
out.searchFocused = await page.evaluate(() => document.activeElement?.id);
await page.keyboard.press("Escape");
// ctrl+, opens settings; Escape closes.
await page.keyboard.press("Control+,");
await page.waitForTimeout(400);
out.settingsOpen = await page.evaluate(() => !!document.querySelector("#settings-backdrop.open"));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
out.settingsClosed = await page.evaluate(() => !document.querySelector("#settings-backdrop.open"));
// Draw a stroke, undo with ctrl+z, redo with ctrl+y.
// Pick the pen explicitly: P activates the last draw tool,
// and the probe pressed X (eraser) earlier, so P alone
// would give the eraser here.
await page.click("#tool-draw");
await page.waitForSelector('#draw-picker button[data-draw="pen"]', { state: "visible" });
await page.click('#draw-picker button[data-draw="pen"]');
out.penBeforeDrag = await toolOf();
await page.mouse.move(600, 500); await page.mouse.down(); await page.mouse.move(900, 500, { steps: 20 }); await page.mouse.up();
// The stroke save is debounced: poll board.json until it lands.
const readBoard = () => JSON.parse(fs.readFileSync(boardPath, "utf8"));
const strokeCount = () => readBoard().items.filter((it) => "Stroke" in it.kind).length;
for (let i = 0; i < 20 && strokeCount() === 0; i++) await page.waitForTimeout(250);
out.strokesAfterDraw = strokeCount();
out.strokePathsInDom = await page.evaluate(() => document.querySelectorAll("#cards .card.stroke path").length);
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
out.strokesAfterUndo = strokeCount();
await page.keyboard.press("Control+y");
await page.waitForTimeout(400);
out.strokesAfterRedo = strokeCount();
// Delete the selected note with Delete, undo brings it back.
await page.keyboard.press("v");
await page.mouse.click(400, 350);
await page.waitForTimeout(300);
await page.keyboard.press("Delete");
await page.waitForTimeout(400);
out.notesAfterDelete = readBoard().items.filter((it) => "Text" in it.kind).length;
await page.keyboard.press("Control+z");
await page.waitForTimeout(400);
out.notesAfterUndoDelete = readBoard().items.filter((it) => "Text" in it.kind).length;

console.log(JSON.stringify(out, null, 2));
console.log("page errors:", errors.length ? errors : "none");
await app.close();
process.exit(0);
