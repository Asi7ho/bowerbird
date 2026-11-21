// Live probe: Settings Shortcuts tab + Performance toggle.
// Launches the built Electron app (like the e2e does).
// Opens Settings, switches to the Shortcuts tab, checks the
// editable rows render, captures a rebind, resets it, and
// checks the hardware acceleration toggle.
// Requires `npm run build` first. Run under xvfb-run -a.
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-settings-probe-"));
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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.waitForSelector("#board", { timeout: 30000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const r = {};
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  // Open Settings via the toolbar gear button.
  document.querySelector("#btn-settings")?.click();
  await sleep(500);
  r.settingsOpen = !!document.querySelector("#settings-backdrop.open");
  r.tabs = Array.from(document.querySelectorAll("#settings-tabs button")).map((b) => b.textContent);
  // Switch to Shortcuts tab.
  document.querySelector('[data-settings-tab="shortcuts"]')?.click();
  await sleep(300);
  const rows = Array.from(document.querySelectorAll("#shortcuts-edit-list .shortcut-row"));
  r.editRowCount = rows.length;
  r.firstRowLabel = rows[0]?.querySelector(".shortcut-label")?.textContent;
  r.firstRowKey = rows[0]?.querySelector(".shortcut-key")?.textContent;
  r.firstRowHasReset = !!rows[0]?.querySelector(".shortcut-reset");
  r.fixedRowCount = document.querySelectorAll("#shortcuts-fixed-table tr").length;
  // Capture: click the first key button, press "s", check it binds.
  rows[0]?.querySelector(".shortcut-key")?.click();
  await sleep(200);
  r.capturingText = document.querySelector("#shortcuts-edit-list .shortcut-key.capturing")?.textContent;
  document.querySelector("#shortcuts-edit-list .shortcut-key.capturing")?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }));
  await sleep(500);
  r.afterCaptureKey = document.querySelectorAll("#shortcuts-edit-list .shortcut-row")[0]?.querySelector(".shortcut-key")?.textContent;
  // Reset it.
  document.querySelectorAll("#shortcuts-edit-list .shortcut-row")[0]?.querySelector(".shortcut-reset")?.click();
  await sleep(500);
  r.afterResetKey = document.querySelectorAll("#shortcuts-edit-list .shortcut-row")[0]?.querySelector(".shortcut-key")?.textContent;
  // Performance toggle (General tab).
  document.querySelector('[data-settings-tab="general"]')?.click();
  await sleep(500);
  const toggle = document.querySelector("#btn-hardware-accel");
  r.toggleText = toggle?.textContent;
  r.restartHidden = document.querySelector("#btn-restart")?.style.display === "none";
  toggle?.click();
  await sleep(500);
  r.toggleAfterClick = document.querySelector("#btn-hardware-accel")?.textContent;
  r.restartShown = document.querySelector("#btn-restart")?.style.display !== "none";
  // Toggle it back so the probe leaves the setting as found.
  document.querySelector("#btn-hardware-accel")?.click();
  await sleep(500);
  r.toggleRestored = document.querySelector("#btn-hardware-accel")?.textContent;
  return r;
});

console.log(JSON.stringify(out, null, 2));
console.log("page errors:", errors.length ? errors : "none");
await app.close();
process.exit(0);
