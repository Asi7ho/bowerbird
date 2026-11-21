// Screenshot the Settings Shortcuts tab and the General
// Performance section, for a visual check. Saves two PNGs
// next to this script. Requires `npm run build` first.
// Run under xvfb-run -a.
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-settings-shot-"));
const boardPath = path.join(tmp, "board.json");
const dataHome = path.join(tmp, "data");
const configHome = path.join(tmp, "config");
const pluginsDir = path.join(tmp, "plugins");
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });
const board = { items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 1, next_group: 1, bg: "#FFFFFF", grid: "Dots" };
fs.writeFileSync(boardPath, JSON.stringify(board));

const app = await electron.launch({
  executablePath: electronPath,
  args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  cwd: repoRoot,
  env: { ...process.env, BOWERBIRD_BOARD_PATH: boardPath, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome, BOWERBIRD_PLUGINS_DIR: pluginsDir },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForSelector("#board", { timeout: 30000 });
await page.waitForTimeout(1500);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
await page.click("#btn-settings");
await sleep(500);
await page.click('[data-settings-tab="shortcuts"]');
await sleep(400);
await page.screenshot({ path: path.join(repoRoot, "scripts", "settings-shortcuts.png") });
await page.click('[data-settings-tab="general"]');
await sleep(400);
await page.screenshot({ path: path.join(repoRoot, "scripts", "settings-general.png") });
console.log("saved scripts/settings-shortcuts.png and scripts/settings-general.png");
await app.close();
process.exit(0);
