// End-to-end tests for Bowerbird: boots the production build in
// Electron and drives it like a user — pen, undo, text, plugins.
// Run after `npm run build`: `npm run test:e2e` (under xvfb-run
// in CI, or with a display locally). No test framework: plain
// node:assert plus playwright-core's Electron launcher.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactsDir = path.join(repoRoot, "tests", "e2e", "artifacts");

const EMPTY_BOARD = {
  items: [],
  camera: { x: 0, y: 0, zoom: 1 },
  next_id: 1,
  next_group: 0,
  bg: "#FFFFFF",
  grid: "Dots",
};

// How long a "wait for it to appear" may take before the test
// calls it a failure. This is a safety net for a genuinely
// broken app, not a performance budget: the waits return the
// moment the condition holds, so a generous bound costs a
// passing run nothing and only slows down a failing one.
// It has to be generous because the boot is machine-speed
// dependent — locally #board appears in ~3s, but on the
// 2-core SwiftShader CI runner it has taken over 15s, and
// a bound that sits that close to reality flakes. 60s is
// far above any boot or render the suite has ever seen.
const READY_TIMEOUT_MS = 60000;

// A short spoken sentence, so the voice-note check records
// real speech and the transcript assertion proves Whisper
// actually ran — a tone has no words to transcribe.
const SPEECH_B64 = fs.readFileSync(path.join(repoRoot, "tests", "e2e", "fixtures", "speech.mp3")).toString("base64");

const TEST_PLUGIN_MANIFEST = {
  id: "ci-test-plugin",
  name: "CI Test Plugin",
  version: "0.1.0",
  apiVersion: "2",
  description: "Test plugin for the e2e suite: registers a card kind and adds one on activate.",
  permissions: ["board:write"],
  main: "main.ts",
  contributions: { cards: [{ kind: "CI", title: "CI card" }] },
};

// A minimal TypeScript plugin: the app compiles it in-app with
// Sucrase at load time, so this also proves that path works.
const TEST_PLUGIN_MAIN = `
export function activate(api) {
  api.cards.register({
    kind: "CI",
    title: "CI card",
    render: (_item, data) => '<div style="padding:12px"><div style="font-size:14px">CI plugin card</div><div style="font-size:13px">' + String((data && data.text) || "") + "</div></div>",
  });
  api.board.addPluginCard("CI", { text: "from activate" }, { x: 100, y: 100 }, { w: 260, h: 96 });
}
export function deactivate() {}
`;

const API_TEST_PLUGIN_MANIFEST = {
  id: "api-test-plugin",
  name: "API Test Plugin",
  version: "0.1.0",
  apiVersion: "2",
  description: "Test plugin for the e2e suite: exercises the checklist API on a card of its own.",
  permissions: ["board:write"],
  main: "main.ts",
};

// Exercises the new API on cards it creates, and leaves
// the results on the window for the suite to read. The
// plugin is off by default and only the final check enables
// it, so its card cannot disturb the earlier checks.
const API_TEST_PLUGIN_MAIN = `
export async function activate(api) {
  // Live counters for the handlers, left on the window so a
  // later check can tell whether another plugin managed to
  // trigger this plugin's registrations.
  const counts = { cmd: 0, action: 0, shortcut: 0 };
  window.__apiTestCounts = counts;
  const id = api.board.addItem(
    { Text: { text: "API card\\n- [ ] one\\n- [ ] two", bold: false, size: 16, color: "#1A1A1A" } },
    { x: 900, y: 400 }, { w: 320, h: 120 },
  );
  const before = api.cards.getChecklistProgress(api.board.getItem(id));
  api.cards.setChecklistProgress(id, 1);
  const after = api.cards.getChecklistProgress(api.board.getItem(id));
  // Frame, action and double-click: a frame kind, and a kind
  // whose renderer answers an action and a double-click.
  // These are exercised on in-memory items, not cards on the
  // board: adding cards here would widen the board and move
  // the fit zoom the mic check below depends on.
  api.cards.register({
    kind: "APIFrame",
    title: "API frame",
    frame: true,
    render: () => '<div style="padding:12px">API frame</div>',
  });
  let actionSeen = null;
  let dblSeen = false;
  api.cards.register({
    kind: "APIAction",
    title: "API action card",
    render: () => '<div style="padding:12px">API action card</div>',
    onAction: (action, item) => { counts.action++; actionSeen = action + ":" + item.id; },
    onDoubleClick: (item) => { dblSeen = item.id; },
  });
  const frameItem = { id: 901, pos: { x: 0, y: 0 }, size: { w: 300, h: 200 }, group: null, kind: { Plugin: { plugin: "api-test-plugin", kind: "APIFrame", data: {} } } };
  const actionItem = { id: 902, pos: { x: 0, y: 0 }, size: { w: 260, h: 96 }, group: null, kind: { Plugin: { plugin: "api-test-plugin", kind: "APIAction", data: {} } } };
  const textItem = api.board.getItem(id);
  const isFrameFrame = api.cards.isFrame(frameItem);
  const isFrameText = api.cards.isFrame(textItem);
  const actionOk = api.cards.dispatchAction("ping", actionItem);
  const dblOk = api.cards.dispatchDoubleClick(actionItem);
  const actionMiss = api.cards.dispatchAction("ping", textItem);
  const dblMiss = api.cards.dispatchDoubleClick(textItem);
  // Tool and shortcut: register both, then read the tool back
  // and dispatch the shortcut through the API.
  let shortcutSeen = false;
  api.ui.registerTool({ id: "apitest", title: "API test tool" });
  api.ui.registerShortcut({ key: "j", title: "API test shortcut", run: () => { counts.shortcut++; shortcutSeen = true; } });
  const toolDef = api.ui.getToolDef("plugin:api-test-plugin:apitest");
  const toolMiss = api.ui.getToolDef("plugin:api-test-plugin:nope");
  const shortcutOk = api.ui.dispatchShortcut("j");
  const shortcutMiss = api.ui.dispatchShortcut("z");
  // A command: register it and run it ourselves. Running
  // another plugin's command is rejected, but our own is
  // always allowed.
  api.ui.registerCommand({ id: "api-cmd", title: "API test command", run: () => { counts.cmd++; window.__apiCmdRan = counts.cmd; } });
  await api.ui.runCommand("api-test-plugin", "api-cmd");
  // The routing gate: this plugin is not the palette, so
  // routing its own command must throw and the command must
  // not run.
  let routeThrew = false;
  try { await api.ui.routeCommand("api-test-plugin", "api-cmd"); } catch { routeThrew = true; }
  window.__apiTest = { id, before, after, isFrameFrame, isFrameText, actionOk, dblOk, actionMiss, dblMiss, actionSeen, dblSeen, toolDef: toolDef ? { id: toolDef.id, title: toolDef.title, pluginId: toolDef.pluginId } : null, toolMiss, shortcutOk, shortcutMiss, shortcutSeen, cmdCount: counts.cmd, actionCount: counts.action, shortcutCount: counts.shortcut, routeThrew };
}
export function deactivate() {}
`;

// Probes the api-test plugin's registrations and the core's
// own surface: every cross-plugin attempt must throw, and
// our own command and shortcut must still work. The results
// are left on the window for the e2e check. The controller
// probe runs last: if the gate ever failed, a fake controller
// would break the board for every check after this one.
const ISOLATION_TEST_PLUGIN_MANIFEST = {
  id: "isolation-test-plugin",
  name: "Isolation Test Plugin",
  version: "0.1.0",
  apiVersion: "2",
  description: "Probes another plugin's registrations to prove they are isolated.",
  permissions: [],
  main: "main.ts",
};

const ISOLATION_TEST_PLUGIN_MAIN = `
export async function activate(api) {
  // Wait for the victim to have activated (its result object
  // is set at the end of its activate), so the probes run
  // against registered handlers, not an empty registry.
  for (let i = 0; i < 50 && !window.__apiTest; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const r = {};
  const probe = async (key, fn) => {
    try { await fn(); r[key] = false; } catch { r[key] = true; }
  };
  await probe("runCommandThrew", () => api.ui.runCommand("api-test-plugin", "api-cmd"));
  await probe("shortcutThrew", () => api.ui.dispatchShortcut("j"));
  const victimItem = { id: 902, pos: { x: 0, y: 0 }, size: { w: 260, h: 96 }, group: null, kind: { Plugin: { plugin: "api-test-plugin", kind: "APIAction", data: {} } } };
  await probe("actionThrew", () => api.cards.dispatchAction("ping", victimItem));
  await probe("dblThrew", () => api.cards.dispatchDoubleClick(victimItem));
  await probe("emitThrew", () => api.events.emit("board"));
  let ownCmd = false;
  api.ui.registerCommand({ id: "iso-cmd", title: "Isolation test command", run: () => { ownCmd = true; } });
  await api.ui.runCommand("isolation-test-plugin", "iso-cmd");
  r.ownCmdRan = ownCmd;
  let ownShortcut = false;
  api.ui.registerShortcut({ key: "x", title: "Isolation test shortcut", run: () => { ownShortcut = true; } });
  r.ownShortcutRan = api.ui.dispatchShortcut("x") && ownShortcut;
  await probe("controllerThrew", () => api.board.registerController({}));
  window.__isolationTest = r;

}
export function deactivate() {}
`;

const PERM_TEST_PLUGIN_MANIFEST = {
  id: "perm-test-plugin",
  name: "Permission Test Plugin",
  version: "0.1.0",
  apiVersion: "2",
  description: "Test plugin for the e2e suite: no permissions, tries a board write on activate.",
  permissions: [],
  main: "main.ts",
};

// Tries the write a plugin without board:write must not be
// able to make, and leaves the outcome on the window: the
// host must throw, and nothing may land on the board.
const PERM_TEST_PLUGIN_MAIN = `
export function activate(api) {
  let threw = null;
  try {
    api.board.addItem(
      { Text: { text: "must not land", bold: false, size: 16, color: "#1A1A1A" } },
      { x: 0, y: 0 }, { w: 320, h: 80 },
    );
  } catch (e) {
    threw = String(e);
  }
  window.__permTest = { threw };
}
export function deactivate() {}
`;

function fail(message) {
  throw new Error(message);
}

// Double-click through raw CDP: Playwright's mouse synthesises
// pointerdown with detail 0, so page.mouse.dblclick() cannot be
// used to prove anything about the app's double-click path.
// Two CDP clicks with clickCount 1 then 2 are the closest thing
// to a real double-click (the app detects one from two presses
// close in time and space — see board.ts).
async function doubleClick(page, x, y) {
  const session = await page.context().newCDPSession(page);
  for (const clickCount of [1, 2]) {
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
  }
}

async function waitFor(label, fn, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`timed out waiting for: ${label}${lastError ? ` (last error: ${String(lastError)})` : ""}`);
}

async function main() {
  if (!process.env.DISPLAY && process.platform === "linux") {
    fail("no display: run under xvfb-run -a (see tests/README.md)");
  }
  for (const needed of ["dist/index.html", "electron-dist/main.js"]) {
    if (!fs.existsSync(path.join(repoRoot, needed))) {
      fail(`missing ${needed}: run \`npm run build\` first`);
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-e2e-"));
  const boardPath = path.join(tmp, "board.json");
  const dataHome = path.join(tmp, "data");
  const configHome = path.join(tmp, "config");
  const pluginsDir = path.join(tmp, "plugins");
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });
  const testPluginDir = path.join(pluginsDir, "ci-test-plugin");
  fs.mkdirSync(testPluginDir, { recursive: true });
  const apiTestPluginDir = path.join(pluginsDir, "api-test-plugin");
  fs.mkdirSync(apiTestPluginDir, { recursive: true });
  const permTestPluginDir = path.join(pluginsDir, "perm-test-plugin");
  fs.mkdirSync(permTestPluginDir, { recursive: true });
  const isoTestPluginDir = path.join(pluginsDir, "isolation-test-plugin");
  fs.mkdirSync(isoTestPluginDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify(EMPTY_BOARD));
  fs.writeFileSync(path.join(testPluginDir, "manifest.json"), JSON.stringify(TEST_PLUGIN_MANIFEST, null, 2));
  fs.writeFileSync(path.join(testPluginDir, "main.ts"), TEST_PLUGIN_MAIN);
  fs.writeFileSync(path.join(apiTestPluginDir, "manifest.json"), JSON.stringify(API_TEST_PLUGIN_MANIFEST, null, 2));
  fs.writeFileSync(path.join(apiTestPluginDir, "main.ts"), API_TEST_PLUGIN_MAIN);
  fs.writeFileSync(path.join(permTestPluginDir, "manifest.json"), JSON.stringify(PERM_TEST_PLUGIN_MANIFEST, null, 2));
  fs.writeFileSync(path.join(permTestPluginDir, "main.ts"), PERM_TEST_PLUGIN_MAIN);
  fs.writeFileSync(path.join(isoTestPluginDir, "manifest.json"), JSON.stringify(ISOLATION_TEST_PLUGIN_MANIFEST, null, 2));
  fs.writeFileSync(path.join(isoTestPluginDir, "main.ts"), ISOLATION_TEST_PLUGIN_MAIN);

  const readBoard = () => JSON.parse(fs.readFileSync(boardPath, "utf8"));
  const strokes = () => readBoard().items.filter((it) => "Stroke" in it.kind);
  const textCards = () => readBoard().items.filter((it) => "Text" in it.kind);

  const results = [];
  let app;
  let page;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        ".",
        "--no-sandbox",
        // The 3D model check needs WebGL. CI has no GPU, so
        // Chromium blocklists it; SwiftShader (software GL)
        // is the fallback that makes the canvas render there.
        // A real machine uses its own GPU and never needs this.
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
      cwd: repoRoot,
      env: {
        ...process.env,
        BOWERBIRD_BOARD_PATH: boardPath,
        XDG_DATA_HOME: dataHome,
        XDG_CONFIG_HOME: configHome,
        BOWERBIRD_PLUGINS_DIR: pluginsDir,
      },
    });
    page = await app.firstWindow();

    const check = async (name, fn) => {
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ok  ${name}`);
      } catch (error) {
        results.push({ name, ok: false, error });
        console.log(`  FAIL  ${name}: ${String(error.message).split("\n")[0]}`);
      }
    };

    await check("app boots with an empty board", async () => {
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      assert.equal(await page.title(), "Bowerbird");
      assert.equal(readBoard().items.length, 0);
    });

    await check("toolbar shows zoom level and title bar shows saved state", async () => {
      const zoom = page.locator("#zoom-label");
      await zoom.waitFor({ timeout: READY_TIMEOUT_MS });
      assert.equal(await zoom.textContent(), "100%");
      assert.equal(await page.locator("#title-bar-left #saved-label").textContent(), "Saved");
      assert.equal(await page.locator("#toolbar #saved-label").count(), 0);
      await page.keyboard.press("+");
      await waitFor("zoom label 120%", async () => (await zoom.textContent()) === "120%");
      await page.keyboard.press("0");
      await waitFor("zoom label back to 100%", async () => (await zoom.textContent()) === "100%");
    });

    await check("pen draws a stroke and it is saved to disk", async () => {
      await page.keyboard.press("p");
      await page.mouse.move(300, 300);
      await page.mouse.down();
      await page.mouse.move(600, 300, { steps: 20 });
      await page.mouse.up();
      const stroke = await waitFor("stroke in board.json", () => {
        const found = strokes();
        return found.length === 1 && found[0].kind.Stroke.points.length >= 2 ? found[0] : null;
      });
      assert.ok(stroke.kind.Stroke.points.length >= 2);
    });

    await check("a fast stroke renders as a smooth curve, not a polyline", async () => {
      // The stroke above was drawn in one fast drag, so its
      // stored points are sparse and a polyline through them
      // would show corners. The rendered path is a
      // Catmull-Rom spline: cubic segments, no straight L
      // segments — the same path the selection halo uses.
      const d = await waitFor("smooth stroke path in the DOM", async () => {
        const ds = await page.evaluate(() => [...document.querySelectorAll("#world path")].map((p) => p.getAttribute("d") ?? ""));
        const curved = ds.find((x) => x.includes(" C"));
        return curved ?? null;
      });
      assert.ok(!d.includes(" L"), `stroke path should have no straight segments: ${d.slice(0, 80)}`);
    });

    await check("undo removes the stroke", async () => {
      await page.keyboard.press("Control+z");
      await waitFor("empty board after undo", () => readBoard().items.length === 0);
    });

    await check("double-click creates a text note and typing saves it", async () => {
      await page.keyboard.press("v");
      await doubleClick(page, 600, 600);
      await page.waitForSelector("textarea.note-edit", { timeout: READY_TIMEOUT_MS });
      await page.keyboard.type("Hello CI");
      await page.keyboard.press("Escape");
      const note = await waitFor("text note in board.json", () => {
        const found = textCards();
        return found.length === 1 && found[0].kind.Text.text === "Hello CI" ? found[0] : null;
      });
      assert.equal(note.kind.Text.text, "Hello CI");
    });

    await check("double-click edits an existing note", async () => {
      // The note was created at world (600, 552); its centre is
      // client (730, 624).
      await doubleClick(page, 730, 624);
      const editor = page.locator("textarea.note-edit");
      await editor.waitFor({ timeout: READY_TIMEOUT_MS });
      assert.equal(await editor.inputValue(), "Hello CI");
      // The mic is only for new notes: editing an existing
      // note shows the text box alone.
      assert.equal(await page.locator(".note-edit-mic").count(), 0);
      await page.keyboard.type("!");
      await page.keyboard.press("Escape");
      await waitFor("edited text in board.json", () =>
        textCards().some((it) => it.kind.Text.text === "Hello CI!"),
      );
    });

    await check("two slow clicks do not open an editor", async () => {
      // Settle first: the previous check's last press must be
      // outside the double-click window, or the first click
      // here would itself count as a double-click with it.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await page.mouse.click(730, 624);
      await new Promise((resolve) => setTimeout(resolve, 700));
      await page.mouse.click(730, 624);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await page.locator("textarea.note-edit").count(), 0);
    });

    await check("a user plugin loads, activates and renders its card", async () => {
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("ci-test-plugin", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      await page.locator("text=CI plugin card").first().waitFor({ timeout: READY_TIMEOUT_MS });
    });

    await check("a plugin without board:write cannot write the board", async () => {
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("perm-test-plugin", true)), true);
      // Enabling a plugin only takes effect on reload, like
      // the ci-test-plugin check above.
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      const result = await waitFor("permission result on the window", async () => {
        const r = await page.evaluate(() => window.__permTest);
        return r ? r : null;
      });
      assert.ok(
        result.threw && result.threw.includes("lacks permission board:write"),
        `expected a permission throw, got ${result.threw}`,
      );
      assert.equal(textCards().some((it) => it.kind.Text.text === "must not land"), false);
      // The plugin stays enabled but harmless; its failed write
      // must not have left the board dirty.
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("perm-test-plugin", false)), false);
    });

    await check("a bundled plugin enables and its panel opens", async () => {
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("command-palette", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      await page.keyboard.press("Control+k");
      await page.locator(".cmd-palette").waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
      await page.keyboard.press("Escape");
    });

    await check("board survives a reload", async () => {
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      await waitFor("text note still on disk after reload", () =>
        textCards().some((it) => it.kind.Text.text === "Hello CI!"),
      );
      await page.locator("text=CI plugin card").first().waitFor({ timeout: READY_TIMEOUT_MS });
    });

    await check("grouping cards frames them as a section", async () => {
      // The board holds the "Hello CI!" note at world (600, 552),
      // 260x48, and CI plugin cards stacked at (100, 100), 260x96
      // (the plugin adds one per reload). Select the note and
      // the top CI card, then group them with Ctrl+G.
      await page.mouse.click(730, 624);
      await page.keyboard.down("Shift");
      await page.mouse.click(230, 196);
      await page.keyboard.up("Shift");
      await waitFor("two cards selected", async () => {
        const n = await page.evaluate(() => document.querySelectorAll("#cards .card.selected").length);
        return n === 2 ? true : null;
      });
      await page.keyboard.press("Control+g");
      const frame = await waitFor("group frame in the DOM", async () => {
        const el = await page.$(".group-frame");
        if (!el) return null;
        const box = await el.boundingBox();
        return box ? { box } : null;
      });
      // The union of the two cards is (100,100)-(860,633):
      // the note is 81 tall now (its text measured as
      // rendered, plus 36 of room for the bottom row), so
      // its bottom is 633. The frame sits 24px outside
      // it, at client y + 48.
      assert.equal(Math.round(frame.box.x), 76);
      assert.equal(Math.round(frame.box.y), 124);
      assert.equal(Math.round(frame.box.width), 808);
      assert.equal(Math.round(frame.box.height), 581);
      assert.equal(await page.locator(".group-label").first().textContent(), "Section 1");
      const grouped = await waitFor("group label on disk", () => {
        const b = readBoard();
        const note = b.items.find((it) => "Text" in it.kind);
        const ci = b.items.find((it) => "Plugin" in it.kind && it.group === 1);
        return b.groups?.[1]?.label === "Section 1" && note?.group === 1 && ci ? b : null;
      });
      assert.equal(grouped.items.filter((it) => it.group === 1).length, 2);
      // Rename by double-clicking the label: the chip sits
      // astride the frame's top border — click its centre.
      await doubleClick(page, 123, 123);
      await page.locator("input.group-rename").waitFor({ timeout: READY_TIMEOUT_MS });
      await page.keyboard.type("Reading");
      await page.keyboard.press("Enter");
      await waitFor("renamed label in the DOM", async () => {
        const t = await page.locator(".group-label").first().textContent();
        return t === "Reading" ? true : null;
      });
      await waitFor("renamed label on disk", () => readBoard().groups?.[1]?.label === "Reading");
      // Drag one card 100px right: it is in a group, so the
      // whole group moves and the frame follows it — mid-drag,
      // not only after release (the frame is a derived div,
      // so the drag path moves it from the live board).
      await page.mouse.move(730, 624);
      await page.mouse.down();
      await page.mouse.move(830, 624, { steps: 10 });
      await waitFor("frame follows the drag mid-drag", async () => {
        const el = await page.$(".group-frame");
        const box = el && (await el.boundingBox());
        return box && Math.round(box.x) === 176 ? true : null;
      });
      await page.mouse.up();
      await waitFor("frame follows the drag", async () => {
        const el = await page.$(".group-frame");
        const box = el && (await el.boundingBox());
        return box && Math.round(box.x) === 176 ? true : null;
      });
      const moved = readBoard().items.find((it) => "Text" in it.kind);
      assert.equal(moved.pos.x, 700);
      const movedCi = readBoard().items.find((it) => "Plugin" in it.kind && it.group === 1);
      assert.equal(movedCi.pos.x, 200);
      // One undo restores the drag, and the frame with it.
      await page.keyboard.press("Control+z");
      await waitFor("frame back after undo", async () => {
        const el = await page.$(".group-frame");
        const box = el && (await el.boundingBox());
        return box && Math.round(box.x) === 76 ? true : null;
      });
      assert.equal(readBoard().items.find((it) => "Text" in it.kind).pos.x, 600);
      assert.equal(readBoard().items.find((it) => "Plugin" in it.kind && it.group === 1).pos.x, 100);
    });

    await check("pasting an image from the clipboard adds an image card", async () => {
      // A synthetic paste carrying a 1x1 PNG, the way a
      // copied screenshot arrives on the clipboard.
      await page.evaluate(() => {
        const dt = new DataTransfer();
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
        document.body.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
      });
      const image = await waitFor("pasted image in board.json", () => {
        const found = readBoard().items.filter((it) => "Image" in it.kind);
        return found.length === 1 ? found[0] : null;
      });
      assert.ok(fs.existsSync(image.kind.Image.path), "embedded asset file exists on disk");
    });

    await check("dropping an image file adds an image card", async () => {
      // A synthetic drop carrying a 1x1 PNG, the way a file
      // dragged from Finder arrives: bytes, never a path.
      // Only the clipboard paste was covered before; the drop
      // path through window drop + dropPaths was not.
      await page.evaluate(() => {
        const dt = new DataTransfer();
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
        document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: 640, clientY: 400, dataTransfer: dt }));
      });
      const image = await waitFor("dropped image in board.json", () => {
        const found = readBoard().items.filter((it) => "Image" in it.kind);
        return found.length === 2 ? found[1] : null;
      });
      assert.ok(fs.existsSync(image.kind.Image.path), "embedded asset file exists on disk");
    });

    await check("F zooms to fit the whole board", async () => {
      // Zoom in until the CI cards at world (100, 100) are
      // pushed off the left edge — they stay in the DOM
      // (the visible rect has a 200px margin), so the probe
      // is their screen rect, not their presence — then F
      // must bring every card back on screen.
      for (let i = 0; i < 5; i++) await page.keyboard.press("+");
      await waitFor("CI cards off-screen while zoomed in", async () => {
        const boardLeft = await page.locator("#board").evaluate((el) => el.getBoundingClientRect().left);
        const rights = await page.locator("#cards .card", { hasText: "CI plugin card" }).evaluateAll((els) =>
          els.map((el) => el.getBoundingClientRect().right),
        );
        return rights.length > 0 && rights.every((right) => right < boardLeft) ? true : null;
      });
      await page.keyboard.press("f");
      await waitFor("all cards back in the DOM after F", async () => {
        const n = await page.locator("#cards .card").count();
        return n === readBoard().items.length ? true : null;
      });
      const inside = await page.evaluate(() => {
        const boardRect = document.querySelector("#board").getBoundingClientRect();
        return [...document.querySelectorAll("#cards .card")].every((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= boardRect.left - 1 && r.top >= boardRect.top - 1
            && r.right <= boardRect.right + 1 && r.bottom <= boardRect.bottom + 1;
        });
      });
      assert.ok(inside, "every card is fully inside the board after F");
    });

    await check("an external board edit is followed live", async () => {
      const board = readBoard();
      // next_id is the last allocated id (allocId increments
      // first), so a fresh card is next_id + 1 — using
      // next_id itself reuses the last card's id, and the
      // board then carries a duplicate.
      const id = board.next_id + 1;
      board.items.push({ id, pos: { x: 900, y: 100 }, size: { w: 320, h: 80 }, group: null, kind: { Text: { text: "From the outside", bold: false, size: 16, color: "#1A1A1A" } } });
      board.next_id = id;
      const tmp = `${boardPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(board));
      fs.renameSync(tmp, boardPath);
      await page.locator("text=From the outside").first().waitFor({ timeout: READY_TIMEOUT_MS });
      // And the app must not clobber the outside edit with its own
      // next save: the card is still on disk a second later.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(textCards().some((it) => it.kind.Text.text === "From the outside"), true);
    });
    await check("checklist progress shows inside cards", async () => {
      // Checklist progress is core rendering: on by default,
      // no enabling needed — the reload below proves it
      // survives a fresh load.
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      // A checklist note, written from outside like the agent
      // CLI would: the live-follow watcher reloads it.
      const board = readBoard();
      const id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      board.items.push({ id, pos: { x: 900, y: 300 }, size: { w: 320, h: 120 }, group: null, kind: { Text: { text: "Checklist card\n- [ ] first\n- [x] second", bold: false, size: 16, color: "#1A1A1A" } } });
      board.next_id = id;
      const tmp = `${boardPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(board));
      fs.renameSync(tmp, boardPath);
      await page.locator("text=Checklist card").first().waitFor({ timeout: READY_TIMEOUT_MS });
      await waitFor("checklist progress shows inside the card", async () => {
        const text = await page.locator(`.card-decorations-right[data-for="${id}"]`).first().textContent().catch(() => "");
        return (text ?? "").includes("1/2");
      });
      // Progress sits at the bottom right, as plain text —
      // not a pill — with its right edge near the card's.
      const progBox = await page.evaluate((cid) => {
        const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
        const span = document.querySelector(`.card-decorations-right[data-for="${cid}"] .card-progress`);
        if (!card || !span) return null;
        const c = card.getBoundingClientRect();
        const d = span.getBoundingClientRect();
        return { cardRight: c.right, cardBottom: c.bottom, decRight: d.right, decBottom: d.bottom, isPill: getComputedStyle(span).borderRadius === "999px" };
      }, String(id));
      assert.ok(progBox, "progress decoration found");
      assert.ok(progBox.cardRight - progBox.decRight < 16, "progress at the card's right edge");
      assert.ok(progBox.decBottom <= progBox.cardBottom && progBox.cardBottom - progBox.decBottom < 24, "progress inside the card's bottom edge");
      assert.ok(!progBox.isPill, "progress is plain text, not a pill");
      // Dragging the card moves its decorations with it: the
      // progress is a sibling div, so the drag path moves it
      // by the same rule that placed it — it must follow
      // mid-drag, not only after release.
      const centre = await page.evaluate((cid) => {
        const el = document.querySelector(`#cards .card[data-id="${cid}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, String(id));
      assert.ok(centre, "checklist card on screen");
      const before = await page.evaluate((cid) => {
        const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
        const span = document.querySelector(`.card-decorations-right[data-for="${cid}"] .card-progress`);
        if (!card || !span) return null;
        return { cardLeft: card.getBoundingClientRect().left, progLeft: span.getBoundingClientRect().left };
      }, String(id));
      assert.ok(before, "progress and card found before drag");
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      await page.mouse.move(centre.x + 100, centre.y, { steps: 10 });
      await waitFor("progress follows the card mid-drag", async () => {
        const after = await page.evaluate((cid) => {
          const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
          const span = document.querySelector(`.card-decorations-right[data-for="${cid}"] .card-progress`);
          if (!card || !span) return null;
          return { cardLeft: card.getBoundingClientRect().left, progLeft: span.getBoundingClientRect().left };
        }, String(id));
        return !!after && Math.abs(after.cardLeft - before.cardLeft - 100) < 5 && Math.abs(after.progLeft - before.progLeft - 100) < 5;
      });
      await page.mouse.up();
      // The drag is undone, so the card is back where the
      // checks after this one expect it.
      await page.keyboard.press("Control+z");
      await waitFor("card back after undoing the drag", async () => {
        const back = await page.evaluate((cid) => {
          const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
          return card ? card.getBoundingClientRect().left : null;
        }, String(id));
        return back !== null && Math.abs(back - before.cardLeft) < 5;
      });
    });

    await check("the checklist API works from a plugin", async () => {
      // The API test plugin is off by default and only this
      // check enables it, so its card cannot disturb the
      // earlier checks.
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("api-test-plugin", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      const result = await waitFor("API test result on the page", () => page.evaluate(() => window.__apiTest ?? null));
      assert.equal(result.before.done, 0);
      assert.equal(result.before.total, 2);
      assert.equal(result.after.done, 1);
      assert.equal(result.after.total, 2);
      // The PR #23 API methods with no direct test before:
      // a frame card is a frame and a text card is not.
      assert.equal(result.isFrameFrame, true);
      assert.equal(result.isFrameText, false);
      // dispatchAction / dispatchDoubleClick run the card's
      // handlers and return true; on a card with no handler
      // they return false and run nothing.
      assert.equal(result.actionOk, true);
      assert.equal(result.actionSeen, "ping:902");
      assert.equal(result.dblOk, true);
      assert.equal(result.dblSeen, 902);
      assert.equal(result.actionMiss, false);
      assert.equal(result.dblMiss, false);
      // getToolDef reads a registered tool back by its full
      // id and returns null for an unknown one; dispatchShortcut
      // runs a registered shortcut and returns false for a key
      // with none.
      assert.deepEqual(result.toolDef, { id: "apitest", title: "API test tool", pluginId: "api-test-plugin" });
      assert.equal(result.toolMiss, null);
      assert.equal(result.shortcutOk, true);
      assert.equal(result.shortcutSeen, true);
      assert.equal(result.shortcutMiss, false);
      // Its own command ran once, and its own action and
      // shortcut handlers each ran once.
      assert.equal(result.cmdCount, 1);
      assert.equal(result.actionCount, 1);
      assert.equal(result.shortcutCount, 1);
      // The write landed on disk: the first task line is
      // checked.
      const card = readBoard().items.find((it) => it.id === result.id);
      assert.ok(card.kind.Text.text.includes("- [x] one"));
      assert.ok(card.kind.Text.text.includes("- [ ] two"));
      // And the core's rendered progress agrees with the API.
      await waitFor("API card progress on the card", async () => {
        const text = await page.locator(`.card-decorations-right[data-for="${result.id}"]`).first().textContent().catch(() => "");
        return (text ?? "").includes("1/2") ? true : null;
      });
    });

    await check("a plugin cannot trigger another plugin's registrations", async () => {
      // The api-test plugin (the victim) is already enabled
      // and re-activates on this reload, so its handlers are
      // registered and its counters are reset to one own
      // trigger each.
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("isolation-test-plugin", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      const iso = await waitFor("isolation test result on the page", () => page.evaluate(() => window.__isolationTest ?? null));
      // Every cross-plugin attempt threw.
      assert.equal(iso.runCommandThrew, true);
      assert.equal(iso.shortcutThrew, true);
      assert.equal(iso.actionThrew, true);
      assert.equal(iso.dblThrew, true);
      assert.equal(iso.emitThrew, true);
      assert.equal(iso.controllerThrew, true);
      // Its own registrations still work.
      assert.equal(iso.ownCmdRan, true);
      assert.equal(iso.ownShortcutRan, true);
      // And the victim's handlers did not run again: the
      // attempts threw before reaching them.
      const counts = await page.evaluate(() => window.__apiTestCounts);
      assert.equal(counts.cmd, 1);
      assert.equal(counts.action, 1);
      assert.equal(counts.shortcut, 1);
    });

    await check("the palette routes a plugin command to its plugin", async () => {
      // The palette is already enabled (bundled plugin check)
      // and the api-test-plugin is enabled (checklist check).
      // Reload so both are active, then open the palette,
      // filter to the api command and run it: the palette
      // routes the pick to the host, which runs it as the
      // api-test-plugin. The gate probe in the plugin's
      // activate already proved a non-palette plugin cannot
      // route — its own routeCommand threw and the command
      // did not run.
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      const before = await waitFor("API test result on the page", () => page.evaluate(() => window.__apiTest ?? null));
      assert.equal(before.routeThrew, true);
      assert.equal(before.cmdCount, 1);
      await page.keyboard.press("Control+k");
      await page.locator(".cmd-palette").waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
      await page.keyboard.type("API test command");
      await page.locator(".cmd-row", { hasText: "API test command" }).first().waitFor({ timeout: READY_TIMEOUT_MS });
      await page.keyboard.press("Enter");
      await waitFor("API command ran via the palette", async () => {
        const ran = await page.evaluate(() => window.__apiCmdRan ?? 0);
        return ran === 2 ? true : null;
      });
    });

    await check("a voice note records and lands as an audio card", async () => {
      // No microphone in CI, and live capture through a
      // looped AudioContext proved environment-sensitive:
      // in headless CI the recorder could land silence even
      // with the model cached and the source sounding, so
      // the card landed with an empty transcript. Instead
      // the recorder itself is stood in: it delivers the
      // speech fixture as the recorded data, deterministi-
      // cally. The plugin's record → embed → transcribe →
      // card flow, and Whisper itself, still run for real;
      // only the microphone capture is faked. The fixture
      // is MP3 data; decodeAudioData sniffs the format from
      // the bytes, so the blob's webm type does not matter.
      await page.addInitScript((speechB64) => {
        const bytes = Uint8Array.from(atob(speechB64), (c) => c.charCodeAt(0));
        navigator.mediaDevices.getUserMedia = async () => new MediaStream();
        window.MediaRecorder = class {
          static isTypeSupported(m) { return m === "audio/webm" || m === ""; }
          constructor(stream, opts) {
            this.stream = stream;
            this.mimeType = opts?.mimeType || "audio/webm";
            this.state = "inactive";
            this.ondataavailable = null;
            this.onstop = null;
          }
          start() {
            this.state = "recording";
            const blob = new Blob([bytes], { type: this.mimeType });
            setTimeout(() => this.ondataavailable?.({ data: blob }), 50);
          }
          stop() {
            this.state = "inactive";
            setTimeout(() => this.onstop?.(), 50);
          }
        };
      }, SPEECH_B64);
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("voice-notes", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      // Let the board finish its first render after the
      // reload before clicking: a double-click into a
      // mid-render board is lost. (No panel tab to wait
      // for here: the plugins enabled so far — the test
      // plugins and command palette — contribute no dock
      // panel, so there is no button.plugin-tab yet.)
      await new Promise((r) => setTimeout(r, 1000));
      // Double-click empty space to the right of the Hello
      // note: the text box opens with the mic beside it,
      // and there is no Voice Notes panel any more. To the
      // right, not below: the Hello note sits at the bottom
      // of the fitted board, so below it is the view
      // switcher, not empty board.
      assert.equal(await page.locator('.plugin-tab[title^="Voice Notes"]').count(), 0);
      // Select tool, as the double-click note check does:
      // a pen left active would draw instead of opening
      // the editor.
      await page.keyboard.press("v");
      // Re-fit first: the camera drifted through the
      // checklist drag and undo, so the Hello note's
      // screen position — and the empty space beside it —
      // is only predictable from a fitted view.
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 300));
      const noteBox = await page.locator("#cards .card", { hasText: "Hello CI!" }).first().boundingBox();
      assert.ok(noteBox);
      const cx = noteBox.x + noteBox.width + 60;
      const cy = noteBox.y + noteBox.height / 2;
      await doubleClick(page, cx, cy);
      await page.locator("textarea.note-edit").waitFor({ timeout: READY_TIMEOUT_MS });
      const mic = page.locator(".note-edit-mic");
      assert.equal(await mic.count(), 1);
      await mic.click();
      await page.locator(".vn-recording", { hasText: "Recording" }).waitFor({ timeout: READY_TIMEOUT_MS });
      // Three seconds of speech, so Whisper hears a whole
      // sentence rather than a fragment.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await page.locator(".vn-stop").click();
      // The card lands after transcription; the model ships
      // with the app, so the wait is for inference, not a
      // download.
      await page.locator("text=voice-note").first().waitFor({ timeout: 180000 });
      const audios = readBoard().items.filter((it) => "Audio" in it.kind);
      assert.equal(audios.length, 1);
      assert.ok(fs.existsSync(audios[0].kind.Audio.path));
      assert.ok(fs.statSync(audios[0].kind.Audio.path).size > 0);
      // Transcription actually ran: the card carries words,
      // not an empty transcript. This is what proves the
      // Whisper path in CI — the card alone would land
      // whether transcription succeeded or failed.
      const transcript = (audios[0].kind.Audio.transcript ?? "").trim();
      assert.ok(transcript.length > 0, "expected a non-empty transcript");
      assert.ok(/hello|world|test|voice|transcription/i.test(transcript), `transcript did not contain the spoken words: ${transcript}`);
      // The card is centred on the double-click point.
      const audioBox = await page.locator("#cards .card", { hasText: "voice-note" }).first().boundingBox();
      assert.ok(audioBox);
      assert.ok(Math.abs(audioBox.x + audioBox.width / 2 - cx) < 5);
      assert.ok(Math.abs(audioBox.y + audioBox.height / 2 - cy) < 5);
      // And typing still works: double-clicking opens the
      // text box directly, with the mic beside it. Left of
      // the Hello note, inside the group frame but on empty
      // space — below it is off the bottom of the window
      // once the audio card has landed there.
      await doubleClick(page, noteBox.x - 110, noteBox.y + noteBox.height / 2);
      await page.locator("textarea.note-edit").waitFor({ timeout: READY_TIMEOUT_MS });
      assert.equal(await page.locator(".note-edit-mic").count(), 1);
      await page.keyboard.press("Escape");
    });

    await check("an audio card's transcript is hidden until expanded", async () => {
      // A voice-note audio card, written from outside: the
      // live-follow watcher reloads it. It reuses the recorded
      // file, so the card does not flip to "File missing".
      const board = readBoard();
      const id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      const audio = board.items.find((it) => "Audio" in it.kind);
      const transcript = "The quick brown fox jumps over the lazy dog.";
      board.items.push({ id, pos: { x: 100, y: 650 }, size: { w: 300, h: 164 }, group: null, kind: { Audio: { path: audio.kind.Audio.path, transcript } } });
      board.next_id = id;
      const tmp = `${boardPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(board));
      fs.renameSync(tmp, boardPath);
      await page.locator(`.audio-transcript-toggle[data-id="${id}"]`).first().waitFor({ timeout: READY_TIMEOUT_MS });
      // Hidden by default: the card is short and the text is not there.
      const hidden = await page.evaluate((cid) => {
        const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
        if (!card) return null;
        return { h: card.getBoundingClientRect().height, hasText: card.textContent.includes("quick brown fox") };
      }, String(id));
      assert.ok(hidden, "transcript card found");
      assert.ok(Math.abs(hidden.h - 164) < 2, "card starts short");
      assert.equal(hidden.hasText, false, "transcript hidden by default");
      // Expand: the card grows and the text appears.
      await page.locator(`.audio-transcript-toggle[data-id="${id}"]`).click();
      await waitFor("transcript shows after expanding", async () => {
        const t = await page.evaluate((cid) => {
          const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
          if (!card) return false;
          return card.textContent.includes("quick brown fox") && Math.abs(card.getBoundingClientRect().height - 240) < 2;
        }, String(id));
        return t;
      });
      // Collapse: back to short, text gone.
      await page.locator(`.audio-transcript-toggle[data-id="${id}"]`).click();
      await waitFor("transcript hides after collapsing", async () => {
        const t = await page.evaluate((cid) => {
          const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
          if (!card) return false;
          return !card.textContent.includes("quick brown fox") && Math.abs(card.getBoundingClientRect().height - 164) < 2;
        }, String(id));
        return t;
      });
    });

    await check("an audio card's title can be renamed", async () => {
      // A voice-note audio card, written from outside: the
      // live-follow watcher reloads it. It reuses the recorded
      // file, so the card does not flip to "File missing".
      const board = readBoard();
      const id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      const audio = board.items.find((it) => "Audio" in it.kind);
      board.items.push({ id, pos: { x: 850, y: 650 }, size: { w: 300, h: 136 }, group: null, kind: { Audio: { path: audio.kind.Audio.path } } });
      board.next_id = id;
      const tmp = `${boardPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(board));
      fs.renameSync(tmp, boardPath);
      // Wait for the live-follow reload first: refitting the
      // camera (F) saves the board, and a save before the
      // reload would clobber this outside write.
      await page.locator(`#cards .card[data-id="${id}"] .title`).first().waitFor({ timeout: READY_TIMEOUT_MS });
      // Refit the camera: the board has grown since F, so the
      // new card can sit below the visible area.
      await page.keyboard.press("f");
      // Double-clicking the name swaps it for an input.
      const titleBox = await page.locator(`#cards .card[data-id="${id}"] .title`).first().boundingBox();
      assert.ok(titleBox, "audio title on screen");
      await doubleClick(page, titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
      await page.locator(`#cards .card[data-id="${id}"] input.audio-rename`).waitFor({ timeout: READY_TIMEOUT_MS });
      // Typing a new name and pressing Enter commits it: the
      // card shows it, and it lands on disk.
      await page.locator(`#cards .card[data-id="${id}"] input.audio-rename`).fill("Morning idea");
      await page.keyboard.press("Enter");
      await waitFor("renamed title shows on the card", async () => {
        const t = await page.locator(`#cards .card[data-id="${id}"] .title`).first().textContent().catch(() => "");
        return (t ?? "").includes("Morning idea");
      });
      const card = readBoard().items.find((it) => it.id === id);
      assert.equal(card.kind.Audio.title, "Morning idea");
    });

    await check("every card type's content is fully visible inside its card", async () => {
      // The video and PDF text were cut by the tag row, and the
      // same class of bug — content reaching into the bottom
      // row or past the card's bottom edge — can hit any type.
      // One card of each kind, from the repo's own fixtures,
      // laid out in a grid; each type's content must sit fully
      // inside its card with clearance from the bottom edge.
      const assetsDir = path.join(tmp, "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      const fixtures = {
        image: "welcome-bower.jpg",
        pdf: "sample.pdf",
        video: "welcome-video.mp4",
        audio: "welcome-birdsong.mp3",
      };
      for (const name of Object.values(fixtures)) {
        fs.copyFileSync(path.join(repoRoot, "assets", name), path.join(assetsDir, name));
      }
      const board = readBoard();
      let id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      const add = (item) => { board.items.push({ id, group: null, ...item }); board.next_id = id; return id++; };
      const ids = {
        text: add({ pos: { x: 100, y: 100 }, size: { w: 260, h: 120 }, kind: { Text: { text: "Layout text\n- [ ] one\n- [x] two", bold: false, size: 16, color: "#1A1A1A" } } }),
        image: add({ pos: { x: 400, y: 100 }, size: { w: 260, h: 180 }, kind: { Image: { path: path.join(assetsDir, fixtures.image) } } }),
        swatch: add({ pos: { x: 700, y: 100 }, size: { w: 200, h: 140 }, kind: { Swatch: { hex: "#2A6D09" } } }),
        url: add({ pos: { x: 950, y: 100 }, size: { w: 300, h: 140 }, kind: { UrlCard: { url: "https://example.com", title: "Example Domain", description: "A sample link card", image: null, icon: null, embed: false } } }),
        pdf: add({ pos: { x: 100, y: 320 }, size: { w: 260, h: 140 }, kind: { PdfCard: { path: path.join(assetsDir, fixtures.pdf), size_bytes: 729 } } }),
        audio: add({ pos: { x: 400, y: 320 }, size: { w: 300, h: 164 }, kind: { Audio: { path: path.join(assetsDir, fixtures.audio), transcript: "The quick brown fox jumps over the lazy dog." } } }),
        video: add({ pos: { x: 750, y: 320 }, size: { w: 360, h: 280 }, kind: { Video: { source: path.join(assetsDir, fixtures.video), remote: false, size_bytes: 458653 } } }),
      };
      const tmp2 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp2, JSON.stringify(board));
      fs.renameSync(tmp2, boardPath);
      // Wait for the live-follow reload, then fit the camera
      // so every card is on screen before measuring.
      await page.locator(`#cards .card[data-id="${ids.video}"]`).first().waitFor({ timeout: READY_TIMEOUT_MS });
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 500));
      // The content selector per kind: the element whose text
      // or image must not be cut. The title/sub are the text
      // that was cut on video and PDF.
      const contentSel = {
        text: ".note-body",
        image: "img",
        swatch: ".swatch-pill",
        url: ".link-title",
        pdf: ".title",
        audio: ".title",
        video: ".title",
      };
      const subSel = { url: ".link-desc", pdf: ".sub", audio: ".sub", video: ".sub" };
      for (const [kind, cid] of Object.entries(ids)) {
        const m = await page.evaluate(([cid2, sel, sub]) => {
          const card = document.querySelector(`#cards .card[data-id="${cid2}"]`);
          let content = card?.querySelector(sel);
          const subEl = sub ? card?.querySelector(sub) : null;
          if (!card || !content) return null;
          // A text card's .note-body is a container that fills
          // the card; the content that must clear the bottom
          // row is its last line of text.
          if (sel === ".note-body") {
            const last = content.lastElementChild;
            if (last) content = last;
          }
          const c = card.getBoundingClientRect();
          const r = content.getBoundingClientRect();
          const s = subEl ? subEl.getBoundingClientRect() : null;
          return {
            card: { top: c.top, left: c.left, right: c.right, bottom: c.bottom },
            content: { top: r.top, left: r.left, right: r.right, bottom: r.bottom },
            sub: s ? { top: s.top, left: s.left, right: s.right, bottom: s.bottom } : null,
          };
        }, [String(cid), contentSel[kind], subSel[kind] ?? null]);
        assert.ok(m, `${kind} card and its content found`);
        const tol = 1;
        assert.ok(m.content.top >= m.card.top - tol, `${kind} content top inside the card`);
        assert.ok(m.content.left >= m.card.left - tol, `${kind} content left inside the card`);
        assert.ok(m.content.right <= m.card.right + tol, `${kind} content right inside the card`);
        // An image fills its card by design (a photo fills
        // its frame), so it has no bottom clearance to check;
        // every other type's content must clear the bottom edge.
        if (kind !== "image") {
          assert.ok(m.content.bottom <= m.card.bottom - 4, `${kind} content clears the card's bottom edge`);
        }
        if (m.sub) {
          assert.ok(m.sub.bottom <= m.card.bottom - 4, `${kind} sub text clears the card's bottom edge`);
          assert.ok(m.sub.top >= m.card.top - tol, `${kind} sub text top inside the card`);
        }
      }
    });

    await check("a video card shows a poster, not a video element, until played", async () => {
      // A video card is a still image until its play button is
      // pressed: no <video> element in the DOM, so a board of
      // videos costs no decoders. The poster is the captured
      // frame, filled in by the backfill for boards that
      // predate it; pressing play mounts the <video> and
      // starts it. Reuses the video card the all-types check
      // laid out, so no new card changes the board's extents
      // (and the fit zoom the later checks rely on).
      const board = readBoard();
      const video = board.items.find((it) => "Video" in it.kind);
      assert.ok(video, "video card on the board");
      const id = video.id;
      await page.locator(`#cards .card[data-id="${id}"]`).first().waitFor({ timeout: READY_TIMEOUT_MS });
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 500));
      const state = () => page.evaluate((cid) => {
        const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
        if (!card) return null;
        return {
          video: !!card.querySelector("video"),
          thumb: !!card.querySelector(".video-thumb"),
          poster: !!card.querySelector(".video-thumb img"),
          sub: card.querySelector(".sub")?.textContent ?? "",
        };
      }, String(id));
      // No <video> element at rest, just the play tile.
      const atRest = await state();
      assert.ok(atRest, "video card on screen");
      assert.equal(atRest.video, false, "no video element before play");
      assert.equal(atRest.thumb, true, "play tile shown before play");
      // The backfill captures the poster frame and writes it
      // to the board: the tile becomes the captured frame,
      // and the duration appears in the sub-line.
      await waitFor("poster frame appears on the video card", async () => (await state())?.poster, 30000);
      const afterPoster = await state();
      assert.ok(afterPoster.sub.includes("0:10"), "duration shows in the sub-line");
      const filled = readBoard().items.find((it) => it.id === id);
      assert.ok(filled.kind.Video.poster, "poster path saved on the card");
      assert.ok(typeof filled.kind.Video.duration === "number" && filled.kind.Video.duration > 0, "duration saved on the card");
      // Pressing play mounts the <video> and starts it.
      const box = await page.locator(`#cards .card[data-id="${id}"] .video-thumb`).first().boundingBox();
      assert.ok(box, "play tile on screen");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await waitFor("video element mounts and plays", async () => {
        const s = await page.evaluate((cid) => {
          const v = document.querySelector(`#cards .card[data-id="${cid}"] video`);
          return v ? { paused: v.paused, t: v.currentTime } : null;
        }, String(id));
        return s && !s.paused && s.t > 0 ? s : null;
      });
    });

    await check("Enter toggles an audio card selected by Tab", async () => {
      // Tab cycles the selection between cards; Enter
      // activates the selected one — for audio that toggles
      // playback, the same action as the tile button. The
      // video card's Enter path is the same branch and is
      // covered live in dev mode (its video is already
      // playing by this point in the suite).
      const board = readBoard();
      const audio = board.items.find((it) => "Audio" in it.kind);
      assert.ok(audio, "audio card on the board");
      const id = audio.id;
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 500));
      // The previous check left focus on the video play
      // button, where Tab keeps its native job instead of
      // cycling the selection — blur it so Tab cycles cards
      // again. Any card hit just becomes the starting
      // selection; the loop below still reaches the audio card.
      await page.mouse.click(1200, 700);
      await page.evaluate(() => document.activeElement?.blur());
      await new Promise((r) => setTimeout(r, 300));
      let selected = false;
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        // The DOM lags a Tab press while the board re-renders
        // (a playing video on SwiftShader): read it too soon
        // and the selection still shows the previous card.
        await new Promise((r) => setTimeout(r, 400));
        selected = await page.evaluate((cid) => !!document.querySelector(`#cards .card[data-id="${cid}"].selected`), String(id));
        if (selected) break;
      }
      assert.ok(selected, "Tab selected the audio card");
      await page.keyboard.press("Enter");
      await waitFor("audio tile shows Pause", async () => {
        const label = await page.evaluate((cid) => document.querySelector(`#cards .card[data-id="${cid}"] button.audio-tile`)?.getAttribute("aria-label") ?? "", String(id));
        return label === "Pause audio" ? true : null;
      });
    });

    await check("hovering a decoration does not change its style", async () => {
      // A tag pill lost its colour and became invisible on
      // hover. The checklist progress is the decoration left
      // in the bottom row; hovering it must not change how it
      // looks.
      const board = readBoard();
      const text = board.items.find((it) => "Text" in it.kind && it.kind.Text.text.includes("Checklist card"));
      assert.ok(text, "checklist card on the board");
      const sel = `.card-decorations-right[data-for="${text.id}"] .card-progress`;
      await page.locator(sel).first().waitFor({ timeout: READY_TIMEOUT_MS });
      const before = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { opacity: cs.opacity, color: cs.color, visibility: cs.visibility };
      }, sel);
      assert.ok(before, "progress found");
      const box = await page.locator(sel).first().boundingBox();
      assert.ok(box, "progress on screen");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await new Promise((r) => setTimeout(r, 300));
      const after = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { opacity: cs.opacity, color: cs.color, visibility: cs.visibility };
      }, sel);
      assert.deepEqual(after, before, "hovering the progress changes nothing about it");
    });

    await check("the new-note mic sits clear of the left border", async () => {
      // The mic was too close to the left border of a new
      // note. It must sit 8px clear of the editor's left edge.
      // (No mic on an existing note is already covered by the
      // double-click-edits check.) Pick an empty world point
      // in the strip below the all-types grid (which ends at
      // y=600) and above the transcript card (which starts at
      // y=650), and convert it to client coords from the
      // saved camera.
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 500));
      const cam = readBoard().camera;
      const cx = Math.round((200 - cam.x) * cam.zoom);
      const cy = Math.round((625 - cam.y) * cam.zoom + 48);
      await doubleClick(page, cx, cy);
      await page.locator("textarea.note-edit").waitFor({ timeout: READY_TIMEOUT_MS });
      const mic = await page.locator(".note-edit-mic").first().boundingBox();
      const row = await page.locator(".note-edit-row").first().boundingBox();
      assert.ok(mic, "mic on a new note");
      assert.ok(row, "editor row found");
      // 8px by the stylesheet; 7px allows sub-pixel rounding.
      assert.ok(mic.x - row.x >= 7, `mic ${Math.round(mic.x - row.x)}px from the row's left edge, expected at least 8`);
      await page.keyboard.press("Escape");
    });

    await check("a GLB model renders on a card and drag rotates it", async () => {
      // The model is a blue cube (tests/e2e/fixtures/cube.glb).
      // It lands via an outside board write, like the
      // all-types grid; the canvas must show the cube, and
      // dragging it must rotate the view.
      const assetsDir = path.join(tmp, "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.copyFileSync(path.join(repoRoot, "tests/e2e/fixtures/cube.glb"), path.join(assetsDir, "cube.glb"));
      const board = readBoard();
      let id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      const modelId = id;
      board.items.push({ id, pos: { x: 100, y: 850 }, size: { w: 360, h: 300 }, group: null, kind: { Model3D: { path: path.join(assetsDir, "cube.glb"), size_bytes: 1472 } } });
      board.next_id = id + 1;
      const tmp2 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp2, JSON.stringify(board));
      fs.renameSync(tmp2, boardPath);
      // Fit after the live-follow reload, not before it: F
      // fits the board in memory, and the reload is debounced
      // (300ms), so pressing F at once would fit the board
      // without the new card and leave it off-screen.
      await new Promise((r) => setTimeout(r, 1200));
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 500));
      const canvas = page.locator(`#cards .card[data-id="${modelId}"] canvas.model3d`).first();
      await canvas.waitFor({ timeout: READY_TIMEOUT_MS });
      // The model is drawn by the one shared WebGL layer
      // (#model3d-layer), not the card's own canvas, so
      // sample the layer at the card's screen rect. Read
      // the layer through a 2D canvas (it sets
      // preserveDrawingBuffer so this is reliable). The
      // cube is blue; the card background is light grey,
      // where the channels are nearly equal.
      const sample = () => page.evaluate((mid) => {
        const layer = document.querySelector("#model3d-layer");
        const cv = document.querySelector(`#cards .card[data-id="${mid}"] canvas.model3d`);
        if (!layer || !cv) return null;
        const r = cv.getBoundingClientRect();
        const lr = layer.getBoundingClientRect();
        const dpr = layer.width / lr.width;
        const c = document.createElement("canvas");
        c.width = layer.width; c.height = layer.height;
        const x = c.getContext("2d");
        if (!x) return null;
        x.drawImage(layer, 0, 0);
        const pts = [];
        for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
          const bx = Math.floor((r.x - lr.x + r.width * fx) * dpr);
          const by = Math.floor((r.y - lr.y + r.height * fy) * dpr);
          const d = x.getImageData(bx, by, 1, 1).data;
          pts.push([d[0], d[1], d[2]]);
        }
        return pts;
      }, String(modelId));
      let before = null;
      // The first model load is slow under SwiftShader
      // (GLTF parse plus the one-time PMREM environment),
      // and background work — media indexing loading its
      // models in the main process — can delay it further,
      // so wait up to 30s for the render instead of 15.
      // The model does render; a short budget only proves
      // the machine was busy, not that the feature broke.
      for (let i = 0; i < 60; i++) {
        const s = await sample();
        if (s && s[0][2] > s[0][0] + 30 && s[0][2] > 80) { before = s; break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(before, "the model rendered (centre pixel is the cube's blue)");
      // Drag on the canvas to rotate, then confirm the view
      // changed. The drag is quick, inside the 3s idle
      // window, so auto-rotate cannot explain a change.
      const box = await canvas.boundingBox();
      assert.ok(box, "model canvas on screen");
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 120, cy, { steps: 10 });
      await page.mouse.up();
      // The drag rotates the view, but the re-render under
      // SwiftShader can lag the drag — a fixed 300ms sleep
      // flaked when the machine was busy, so poll until the
      // pixels actually change instead of hoping the sleep
      // was long enough.
      let after = null;
      let changed = false;
      for (let i = 0; i < 20; i++) {
        after = await sample();
        if (after) {
          changed = before.some((p, j) => {
            const q = after[j];
            return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 30;
          });
          if (changed) break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(after, "canvas still readable after the drag");
      assert.ok(changed, "dragging the model rotated the view (pixels changed)");
    });

    await check("more than 16 3D models all render (shared renderer)", async () => {
      // The old per-card renderer capped at 16 visible
      // models (Chromium's context limit); the 17th went
      // blank. The shared renderer has one context, so 20
      // must all show the cube.
      const assetsDir = path.join(tmp, "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.copyFileSync(path.join(repoRoot, "tests/e2e/fixtures/cube.glb"), path.join(assetsDir, "cube.glb"));
      const board = readBoard();
      let id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      const ids = [];
      for (let i = 0; i < 20; i++) {
        const col = i % 5, row = Math.floor(i / 5);
        board.items.push({ id, pos: { x: 100 + col * 400, y: 100 + row * 340 }, size: { w: 360, h: 300 }, group: null, kind: { Model3D: { path: path.join(assetsDir, "cube.glb"), size_bytes: 1472 } } });
        ids.push(id);
        id++;
      }
      board.next_id = id;
      const before = await page.evaluate(() => document.querySelectorAll("#cards .card").length);
      const tmp2 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp2, JSON.stringify(board));
      fs.renameSync(tmp2, boardPath);
      // Wait for the live-follow reload before pressing F:
      // the card count can only grow once the new board
      // lands (the old cards stay, the new ones add).
      await waitFor("models reloaded", async () => {
        const n = await page.evaluate(() => document.querySelectorAll("#cards .card").length);
        return n > before ? true : null;
      });
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 500));
      const count = await page.evaluate(() => document.querySelectorAll("#model3d-layer").length);
      assert.strictEqual(count, 1, "exactly one shared WebGL layer");
      // Poll until every model's centre pixel is the cube's
      // blue (or time out): SwiftShader renders slowly.
      let rendered = 0;
      for (let i = 0; i < 60; i++) {
        rendered = await page.evaluate((mids) => {
          const layer = document.querySelector("#model3d-layer");
          if (!layer) return 0;
          const lr = layer.getBoundingClientRect();
          const dpr = layer.width / lr.width;
          const c = document.createElement("canvas");
          c.width = layer.width; c.height = layer.height;
          const x = c.getContext("2d");
          if (!x) return 0;
          x.drawImage(layer, 0, 0);
          let n = 0;
          for (const mid of mids) {
            const cv = document.querySelector(`#cards .card[data-id="${mid}"] canvas.model3d`);
            if (!cv) continue;
            const r = cv.getBoundingClientRect();
            const bx = Math.floor((r.x - lr.x + r.width / 2) * dpr);
            const by = Math.floor((r.y - lr.y + r.height / 2) * dpr);
            const d = x.getImageData(bx, by, 1, 1).data;
            if (d[2] > d[0] + 30 && d[2] > 80) n++;
          }
          return n;
        }, ids.map(String));
        if (rendered === ids.length) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.strictEqual(rendered, ids.length, `${rendered}/${ids.length} models rendered, expected all ${ids.length}`);
    });

    await check("fit reaches a very wide board (zoom floor)", async () => {
      // A 0.1 zoom floor silently cropped any board wider
      // than ~12,800 world units. 500 cards in a 45-column
      // grid is ~16,200 wide; F must show all of them.
      const board = readBoard();
      let id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      const cols = 45;
      for (let i = 0; i < 500; i++) {
        const col = i % cols, row = Math.floor(i / cols);
        board.items.push({ id: id++, pos: { x: 100 + col * 360, y: 100 + row * 120 }, size: { w: 320, h: 80 }, group: null, kind: { Text: { text: `card ${i}`, bold: false, size: 16, color: "#1A1A1A" } } });
      }
      board.next_id = id;
      const before = await page.evaluate(() => document.querySelectorAll("#cards .card").length);
      const tmp2 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp2, JSON.stringify(board));
      fs.renameSync(tmp2, boardPath);
      // Wait for the live-follow reload, not a fixed sleep:
      // pressing F before the swap fits the old board, and
      // the count below then only ever sees the cards in
      // that viewport. The count can only grow once the new
      // board lands (the old cards stay, the new ones add).
      await waitFor("wide board reloaded", async () => {
        const n = await page.evaluate(() => document.querySelectorAll("#cards .card").length);
        return n > before ? true : null;
      });
      await page.keyboard.press("f");
      let shown = 0;
      for (let i = 0; i < 20; i++) {
        shown = await page.evaluate(() => document.querySelectorAll("#cards .card").length);
        if (shown >= 500) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(shown >= 500, `${shown} cards in the DOM after fit, expected at least 500`);
    });

    await check("search finds a note by text and Enter jumps to it", async () => {
      // A note with a word nothing else on the board has, so
      // the match count is exactly one. Search had no e2e
      // check at all before this.
      await page.keyboard.press("v");
      // The board holds 500+ cards and 20 models by now, so
      // the main thread can be busy enough that the two
      // presses land more than 500ms apart and the app reads
      // them as two single clicks: retry the double-click
      // once if no editor appears.
      await doubleClick(page, 200, 200);
      try {
        await page.waitForSelector("textarea.note-edit", { timeout: 3000 });
      } catch {
        await doubleClick(page, 200, 200);
        await page.waitForSelector("textarea.note-edit", { timeout: READY_TIMEOUT_MS });
      }
      await page.keyboard.type("Zebra crossing");
      await page.keyboard.press("Escape");
      await waitFor("zebra note in board.json", () =>
        textCards().some((it) => it.kind.Text.text === "Zebra crossing"),
      );
      // Select a different card first, so the jump below has
      // somewhere to jump from: creating the note selected it,
      // and a selection that never moves proves nothing.
      const zebra = textCards().find((it) => it.kind.Text.text === "Zebra crossing");
      assert.ok(zebra, "zebra note on the board");
      const firstCard = await page.locator("#cards .card").first().boundingBox();
      assert.ok(firstCard, "a card on screen to select first");
      await page.mouse.click(firstCard.x + firstCard.width / 2, firstCard.y + firstCard.height / 2);
      await new Promise((r) => setTimeout(r, 300));
      await page.keyboard.press("Control+f");
      await page.locator("#search-input").waitFor({ timeout: READY_TIMEOUT_MS });
      await page.keyboard.type("Zebra");
      // The count can carry a " · Indexing context…" suffix
      // while media indexes, so match on the prefix.
      await waitFor("one search match", async () => {
        const count = (await page.locator("#search-count").textContent()) ?? "";
        return count.startsWith("1 match") ? true : null;
      });
      await page.keyboard.press("Enter");
      // The jump selects the note. The count alone cannot
      // prove it: the background context search can append a
      // media match and reopen the results list, so the count
      // can read "2 matches" instead of "1 of 1" after the
      // jump. The selection is the jump's own effect.
      await waitFor("jumped to the zebra note", async () =>
        page.evaluate((cid) => !!document.querySelector(`#cards .card[data-id="${cid}"].selected`), String(zebra.id)),
      );
      // Escape clears the search and leaves the note selected.
      await page.keyboard.press("Escape");
      await waitFor("search cleared", async () => {
        const count = (await page.locator("#search-count").textContent()) ?? "";
        return count === "" ? true : null;
      });
    });

    await check("a backup restores the board to its snapshot", async () => {
      // Backups are made at most once an hour on save, so the
      // suite's first save left one snapshot: the board as it
      // was before the checks built on it. listBackups returns
      // only the newest entry. Last check: restoring reverts
      // everything the suite added since.
      const snapshot = await waitFor("a backup exists", async () => {
        const list = await page.evaluate(() => window.bowerbird.listBackups());
        return list.length >= 1 ? list[0] : null;
      });
      // Change the board after the snapshot, by writing the
      // file directly (the fit check's pattern): the watcher
      // follows it live, no pointer aim needed.
      const board = readBoard();
      let id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      board.items.push({ id, pos: { x: 5000, y: 5000 }, size: { w: 320, h: 80 }, group: null, kind: { Text: { text: "Doomed note", bold: false, size: 16, color: "#1A1A1A" } } });
      board.next_id = id + 1;
      const tmp2 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp2, JSON.stringify(board));
      fs.renameSync(tmp2, boardPath);
      await new Promise((r) => setTimeout(r, 1500));
      await waitFor("doomed note followed live", () =>
        textCards().some((it) => it.kind.Text.text === "Doomed note"),
      );
      await page.evaluate((name) => window.bowerbird.restoreBackup(name), snapshot.name);
      await waitFor("board.json restored to the snapshot", () => {
        const restored = readBoard();
        return (
          restored.items.length === snapshot.items &&
          !textCards().some((it) => it.kind.Text.text === "Doomed note")
        );
      });
      // The file is restored; reload proves the app loads it.
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      await waitFor("board renders after restore", async () => {
        const n = await page.evaluate(() => document.querySelectorAll("#cards .card").length);
        return n >= 1 ? true : null;
      });
      assert.equal(textCards().some((it) => it.kind.Text.text === "Doomed note"), false);
    });

    // The note colour bar and the resize/rotate handles must
    // never paint over the toolbar, and the bar must stay
    // attached to its note (PR #49 rounds 6-11). These checks
    // build their own note so they do not depend on the
    // restored board's contents, and measure everything at
    // runtime so they do not assume a window size.
    const barTestNote = async () => {
      const board = readBoard();
      let note = board.items.find((it) => "Text" in it.kind && it.kind.Text.text === "Bar test note");
      if (!note) {
        const maxRight = board.items.reduce((m, it) => Math.max(m, it.pos.x + it.size.w), 0);
        const id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
        note = { id, pos: { x: maxRight + 200, y: 300 }, size: { w: 260, h: 80 }, group: null, kind: { Text: { text: "Bar test note", bold: false, size: 16, color: "#1A1A1A" } } };
        board.items.push(note);
        board.next_id = id + 1;
        const tmp2 = `${boardPath}.tmp`;
        fs.writeFileSync(tmp2, JSON.stringify(board));
        fs.renameSync(tmp2, boardPath);
        // Give the watcher time to follow the write (the
        // external-edit check waits the same 1.5s) before
        // fitting: F pressed before the model updates fits
        // the old board, and the note — placed clear of the
        // restored board's cards — stays off-screen and
        // culled from the DOM.
        await new Promise((r) => setTimeout(r, 1500));
        await page.keyboard.press("f");
        await waitFor("bar test note in the DOM", async () => {
          const n = await page.evaluate(() => [...document.querySelectorAll("#cards .card .note-body")].some((b) => (b.innerText || "").includes("Bar test note")));
          return n ? true : null;
        });
      }
      return note;
    };
    const barTestCentre = () => page.evaluate(() => {
      const c = [...document.querySelectorAll("#cards .card .note-body")].find((b) => (b.innerText || "").includes("Bar test note"));
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    });
    const barTestState = () => page.evaluate(() => {
      const bar = document.querySelector("#note-colours");
      const rh = document.querySelector("#resize-handle");
      const tb = document.querySelector("#toolbar");
      const c = [...document.querySelectorAll("#cards .card .note-body")].find((b) => (b.innerText || "").includes("Bar test note"));
      if (!bar || !c) return null;
      const br = bar.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      const tr = tb ? tb.getBoundingClientRect() : null;
      const rhr = rh ? rh.getBoundingClientRect() : null;
      const overlaps = (a, b) => a && b && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
      return {
        barDisplay: getComputedStyle(bar).display,
        bar: { x: br.left, y: br.top, right: br.right, bottom: br.bottom },
        note: { x: cr.left, y: cr.top, right: cr.right, bottom: cr.bottom, w: cr.width, h: cr.height },
        toolbar: tr ? { left: tr.left, right: tr.right, top: tr.top, bottom: tr.bottom } : null,
        resizeDisplay: rh ? getComputedStyle(rh).display : null,
        resize: rhr ? { x: rhr.left, y: rhr.top, right: rhr.right, bottom: rhr.bottom } : null,
        gap: cr.left - br.right,
        topDiff: br.top - cr.top,
        barOverToolbar: overlaps(br, tr),
        resizeOverToolbar: rh && getComputedStyle(rh).display !== "none" ? overlaps(rhr, tr) : false,
      };
    });
    const selectBarTestNote = async () => {
      // Settle first: the previous check ends with a mouse-up,
      // and a click too soon after it at the same spot reads
      // as a double-click, which opens the editor, hides the
      // bar, and makes the wait below time out. Escape closes
      // an editor left open by such a double-click.
      await new Promise((r) => setTimeout(r, 700));
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 200));
      const ctr = await barTestCentre();
      assert.ok(ctr, "bar test note has a centre on screen");
      await page.mouse.click(ctr.x, ctr.y);
      await waitFor("colour bar visible", async () => {
        const s = await barTestState();
        return s && s.barDisplay === "flex" ? true : null;
      });
    };

    await check("the note colour bar stays attached to its note through a pan", async () => {
      await barTestNote();
      await new Promise((r) => setTimeout(r, 800));
      // Drag the note to the centre of the screen in a single
      // gesture: mousedown selects it and starts the drag.
      // A separate click to select first would pair with the
      // drag's press as a double-click and open the editor,
      // which hides the bar and swallows the drag.
      const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const ctr = await barTestCentre();
      assert.ok(ctr, "bar test note has a centre on screen");
      await page.mouse.move(ctr.x, ctr.y);
      await page.mouse.down();
      await page.mouse.move(size.w / 2, size.h / 2, { steps: 10 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 300));
      const atCentre = await waitFor("bar attached at centre", async () => {
        const s = await barTestState();
        return s && s.barDisplay === "flex" && Math.abs(s.gap - 8) <= 2 && Math.abs(s.topDiff) <= 2 ? s : null;
      });
      assert.ok(Math.abs(atCentre.gap - 8) <= 2, `bar gap should be 8, got ${atCentre.gap}`);
      assert.ok(Math.abs(atCentre.topDiff) <= 2, `bar top should match note top, got ${atCentre.topDiff}`);
      // Pan down with Space+drag, sampling mid-pan: the bar
      // must track the note exactly. Both the fixed-Y
      // experiment and the viewport clamp showed up here as
      // a topDiff that grew while the note moved.
      await page.keyboard.down("Space");
      await page.mouse.move(size.w / 2, size.h / 2);
      await page.mouse.down();
      for (let i = 1; i <= 4; i++) {
        await page.mouse.move(size.w / 2, size.h / 2 + i * 60, { steps: 4 });
        await new Promise((r) => setTimeout(r, 100));
        const s = await barTestState();
        assert.ok(s, "bar and note measurable mid-pan");
        assert.ok(Math.abs(s.gap - 8) <= 2, `mid-pan gap should stay 8, got ${s.gap}`);
        assert.ok(Math.abs(s.topDiff) <= 2, `mid-pan topDiff should stay 0, got ${s.topDiff}`);
      }
      await page.mouse.up();
      await page.keyboard.up("Space");
      const afterPan = await barTestState();
      assert.ok(Math.abs(afterPan.gap - 8) <= 2, `after-pan gap should be 8, got ${afterPan.gap}`);
      assert.ok(Math.abs(afterPan.topDiff) <= 2, `after-pan topDiff should be 0, got ${afterPan.topDiff}`);
      // Pan back up so the next checks start from the centre.
      await page.keyboard.down("Space");
      await page.mouse.move(size.w / 2, size.h / 2);
      await page.mouse.down();
      await page.mouse.move(size.w / 2, size.h / 2 - 240, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up("Space");
    });

    await check("the note colour bar never covers the toolbar", async () => {
      await selectBarTestNote();
      // Pan right in steps, moving the note left toward the
      // toolbar: at every step the bar must be on the note's
      // right side or hidden, never on the toolbar. Panning
      // (not dragging the note) keeps the board untouched.
      const start = await barTestState();
      const tb = start.toolbar;
      const targetRight = tb.left + (tb.right - tb.left) / 2;
      const total = start.note.right - targetRight;
      const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await page.keyboard.down("Space");
      await page.mouse.move(size.w / 2, size.h / 2);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(size.w / 2 + (total * i) / 6, size.h / 2, { steps: 4 });
        await new Promise((r) => setTimeout(r, 100));
        const s = await barTestState();
        assert.ok(s, "bar and note measurable while panning toward the toolbar");
        assert.equal(s.barOverToolbar, false, `bar must never cover the toolbar (step ${i}, bar at ${Math.round(s.bar.x)},${Math.round(s.bar.y)})`);
      }
      await page.mouse.up();
      await page.keyboard.up("Space");
      await new Promise((r) => setTimeout(r, 300));
      const end = await barTestState();
      assert.equal(end.barOverToolbar, false, "bar must not cover the toolbar after the pan");
      // Pan back left so the next checks start centred.
      await page.keyboard.down("Space");
      await page.mouse.move(size.w / 2, size.h / 2);
      await page.mouse.down();
      await page.mouse.move(size.w / 2 - total, size.h / 2, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up("Space");
    });

    await check("the resize handle hides over the toolbar and returns", async () => {
      await selectBarTestNote();
      const start = await barTestState();
      assert.equal(start.resizeDisplay, "block", "resize handle shows on a selected note");
      assert.equal(start.resizeOverToolbar, false, "resize handle starts clear of the toolbar");
      // Pan right until the note's bottom-right corner (the
      // resize handle) is over the toolbar: the handle must
      // hide rather than paint over it.
      const tb = start.toolbar;
      const targetRight = tb.left + (tb.right - tb.left) / 2;
      const total = start.note.right - targetRight;
      const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await page.keyboard.down("Space");
      await page.mouse.move(size.w / 2, size.h / 2);
      await page.mouse.down();
      await page.mouse.move(size.w / 2 + total, size.h / 2, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      await waitFor("resize handle hidden over the toolbar", async () => {
        const s = await barTestState();
        return s && s.resizeDisplay === "none" && !s.resizeOverToolbar ? true : null;
      });
      // Pan back left: the handle returns.
      await page.keyboard.down("Space");
      await page.mouse.move(size.w / 2, size.h / 2);
      await page.mouse.down();
      await page.mouse.move(size.w / 2 - total, size.h / 2, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      await waitFor("resize handle back", async () => {
        const s = await barTestState();
        return s && s.resizeDisplay === "block" ? true : null;
      });
      const back = await barTestState();
      assert.equal(back.resizeOverToolbar, false, "resize handle back clear of the toolbar");
    });

    await check("the note colour bar hides with a fully off-screen note and returns", async () => {
      await selectBarTestNote();
      const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      // Pan the note fully off-screen to the left. The pan is
      // the mouse drag, so it cannot start at the note and run
      // 900px left — the mouse would leave the window at x 0
      // and clamp, short of moving the note off-screen. Start
      // near the right edge instead, for a drag long enough
      // to push the note's right edge past x 0.
      await page.keyboard.down("Space");
      await page.mouse.move(size.w - 80, size.h / 2);
      await page.mouse.down();
      await page.mouse.move(100, size.h / 2, { steps: 12 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      // The bar is checked directly, not through the note:
      // a fully off-screen note is culled from the DOM, so
      // a helper that finds the note's card would return
      // null and the wait would never see the bar hide.
      await waitFor("colour bar hidden with the note off-screen", async () => {
        const d = await page.evaluate(() => {
          const bar = document.querySelector("#note-colours");
          return bar ? getComputedStyle(bar).display : null;
        });
        return d === "none" ? true : null;
      });
      // Pan back: the bar returns, attached to the note.
      await page.keyboard.down("Space");
      await page.mouse.move(100, size.h / 2);
      await page.mouse.down();
      await page.mouse.move(size.w - 80, size.h / 2, { steps: 12 });
      await page.mouse.up();
      await page.keyboard.up("Space");
      const back = await waitFor("colour bar back and attached", async () => {
        const s = await barTestState();
        return s && s.barDisplay === "flex" && Math.abs(s.gap - 8) <= 2 && Math.abs(s.topDiff) <= 2 ? s : null;
      });
      assert.ok(Math.abs(back.gap - 8) <= 2, `bar gap should be 8 on return, got ${back.gap}`);
      assert.ok(Math.abs(back.topDiff) <= 2, `bar top should match note top on return, got ${back.topDiff}`);
    });

    // ---- feat/file-formats: importing files onto the board ----
    // Drop each format the same way a file dragged from Finder
    // arrives (bytes in a DataTransfer, never a path) and prove
    // the right cards land in board.json.
    const dropFixture = async (file, type) => {
      const b64 = fs.readFileSync(path.join(repoRoot, "tests/e2e/fixtures", file)).toString("base64");
      await page.evaluate(([b64, file, type]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], file, { type }));
        document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: 640, clientY: 400, dataTransfer: dt }));
      }, [b64, file, type]);
    };
    const countKind = (name) => readBoard().items.filter((it) => name in it.kind).length;

    await check("dropping an SVG file lands its shapes, strokes and text as cards", async () => {
      const before = { shape: countKind("Shape"), stroke: countKind("Stroke"), text: countKind("Text") };
      await dropFixture("sample.svg", "image/svg+xml");
      await waitFor("svg cards in board.json", () => {
        const b = readBoard();
        const hello = b.items.filter((it) => "Text" in it.kind && it.kind.Text.text === "Hello SVG");
        return countKind("Shape") === before.shape + 4 && countKind("Stroke") === before.stroke + 3 && hello.length === 1 ? b : null;
      });
      // Imported strokes obey the board contract: their
      // points are absolute, so the min of the points is
      // pos. Relative points used to render at the origin.
      const strokes = readBoard().items.filter((it) => "Stroke" in it.kind).slice(-3);
      for (const s of strokes) {
        const xs = s.kind.Stroke.points.map((p) => p.x);
        const ys = s.kind.Stroke.points.map((p) => p.y);
        assert.ok(Math.abs(Math.min(...xs) - s.pos.x) < 0.01, "svg stroke points are absolute in x");
        assert.ok(Math.abs(Math.min(...ys) - s.pos.y) < 0.01, "svg stroke points are absolute in y");
      }
    });

    await check("dropping a PNG with transparency lands an image card", async () => {
      const before = countKind("Image");
      await dropFixture("transparent.png", "image/png");
      const image = await waitFor("png image in board.json", () => {
        const found = readBoard().items.filter((it) => "Image" in it.kind);
        return found.length === before + 1 ? found[found.length - 1] : null;
      });
      assert.equal(image.size.w, 40);
      assert.equal(image.size.h, 40);
      assert.ok(fs.existsSync(image.kind.Image.path), "embedded png asset exists on disk");
    });

    await check("dropping a PSD lands its layers as cards", async () => {
      const before = { image: countKind("Image"), text: countKind("Text") };
      await dropFixture("sample.psd", "image/vnd.adobe.photoshop");
      await waitFor("psd cards in board.json", () => {
        const hello = readBoard().items.filter((it) => "Text" in it.kind && it.kind.Text.text === "Hello PSD");
        return countKind("Image") === before.image + 2 && hello.length === 1 ? true : null;
      });
      const layers = readBoard().items.filter((it) => "Image" in it.kind).slice(-2);
      for (const layer of layers) assert.ok(fs.existsSync(layer.kind.Image.path), "psd layer asset exists on disk");
    });

    await check("dropping a PDF-compatible .ai lands its artwork as editable cards, not a PdfCard", async () => {
      const before = { pdf: countKind("PdfCard"), text: countKind("Text") };
      await dropFixture("sample.ai", "application/pdf");
      await waitFor("ai text card in board.json", () => {
        const hello = readBoard().items.filter((it) => "Text" in it.kind && it.kind.Text.text === "Hello PDF");
        return countKind("PdfCard") === before.pdf && countKind("Text") === before.text + 1 && hello.length === 1 ? hello[0] : null;
      });
      const hello = readBoard().items.find((it) => "Text" in it.kind && it.kind.Text.text === "Hello PDF");
      assert.equal(hello.kind.Text.size, 18, "ai text keeps its 18pt size");
      assert.ok(!readBoard().items.some((it) => "PdfCard" in it.kind && it.kind.PdfCard.path.endsWith("sample.ai")), "no PdfCard for the .ai file");
    });

    await check("dropping a vector .ai lands shapes, strokes, text, an image and a raster fallback page", async () => {
      const before = { shape: countKind("Shape"), stroke: countKind("Stroke"), text: countKind("Text"), image: countKind("Image") };
      await dropFixture("sample-vector.ai", "application/pdf");
      await waitFor("vector ai cards in board.json", () => {
        const hello = readBoard().items.filter((it) => "Text" in it.kind && it.kind.Text.text === "Hello AI");
        const b = readBoard();
        return countKind("Shape") === before.shape + 3 && countKind("Stroke") === before.stroke + 1 &&
          hello.length === 1 && countKind("Image") === before.image + 2 ? b : null;
      });
      const shapes = readBoard().items.filter((it) => "Shape" in it.kind).slice(-3);
      const fills = shapes.map((it) => it.kind.Shape.fill).sort();
      assert.deepEqual(fills, ["#0000ff", "#ff0000", "#ff8000"], "rect, circle and form rect land with their fills");
      assert.ok(shapes.some((it) => it.kind.Shape.shape === "ellipse"), "the circle lands as an ellipse Shape");
      const stroke = readBoard().items.filter((it) => "Stroke" in it.kind).slice(-1)[0];
      assert.equal(stroke.kind.Stroke.color, "#008000", "stroked path keeps its colour");
      // The stroke's points are absolute (min == pos), and
      // the path in the DOM starts at the stroke's first
      // point — relative points used to render it at the
      // origin, off-screen.
      const sxs = stroke.kind.Stroke.points.map((p) => p.x);
      const sys = stroke.kind.Stroke.points.map((p) => p.y);
      assert.ok(Math.abs(Math.min(...sxs) - stroke.pos.x) < 0.01, "ai stroke points are absolute in x");
      assert.ok(Math.abs(Math.min(...sys) - stroke.pos.y) < 0.01, "ai stroke points are absolute in y");
      const first = stroke.kind.Stroke.points[0];
      await waitFor("ai stroke path in the DOM", async () => {
        const starts = await page.evaluate(() => [...document.querySelectorAll("#world path")].map((p) => p.getAttribute("d") ?? ""));
        const atRealPosition = starts.some((d) => {
          const m = /^M(-?[\d.]+),(-?[\d.]+)/.exec(d);
          return m !== null && Math.abs(parseFloat(m[1]) - first.x) < 0.01 && Math.abs(parseFloat(m[2]) - first.y) < 0.01;
        });
        return atRealPosition ? true : null;
      });
      const images = readBoard().items.filter((it) => "Image" in it.kind).slice(-2);
      const sizes = images.map((it) => `${it.size.w}x${it.size.h}`).sort();
      assert.deepEqual(sizes, ["100x60", "300x200"], "embedded image lands at its placed size, gradient page as one raster of the page");
      for (const img of images) assert.ok(fs.existsSync(img.kind.Image.path), "vector ai image asset exists on disk");
    });

    await check("dropping a legacy .ai reports it as unsupported and lands nothing", async () => {
      const before = readBoard().items.length;
      await dropFixture("legacy.ai", "application/postscript");
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(readBoard().items.length, before, "no card should land for a non-PDF .ai");
      const toast = await page.evaluate(() => document.querySelector("#toast")?.textContent ?? "");
      assert.ok(toast.includes("PDF compatibility"), `toast should explain the limit, got ${JSON.stringify(toast)}`);
    });

    await check("dropping a PDF still lands a PdfCard", async () => {
      const before = countKind("PdfCard");
      await dropFixture("sample.pdf", "application/pdf");
      const card = await waitFor("pdf card in board.json", () => {
        const found = readBoard().items.filter((it) => "PdfCard" in it.kind);
        return found.length === before + 1 ? found[found.length - 1] : null;
      });
      assert.ok(fs.existsSync(card.kind.PdfCard.path), "embedded pdf asset exists on disk");
    });

    // Shapes are hit on their visible geometry, not their
    // box (PR #10): a click on a shape's empty corner must
    // select nothing, and an outline shape's empty interior
    // must select nothing — only its edge does. A plain
    // click must not re-select by box either: pointerdown
    // settles the selection by geometry, and a zero-area
    // marquee on pointerup used to undo that. These checks
    // replace the board with the 14 shapes (7 filled, 7
    // outline) and click each one's empty and visible points.
    const shapeBoard = () => {
      const shapes = ["rect", "ellipse", "triangle", "diamond", "hexagon", "star", "arrow"];
      const items = [];
      let id = 1;
      for (const [row, outline] of [[0, false], [1, true]]) {
        for (const [col, shape] of shapes.entries()) {
          items.push({ id: id++, pos: { x: col * 340, y: row * 320 }, size: { w: 200, h: 150 }, group: null, kind: { Shape: { shape, fill: "#FFCC00", ...(outline ? { outline: true } : {}) } } });
        }
      }
      const board = { items, camera: { x: 0, y: 0, zoom: 1 }, next_id: id, next_group: 1, bg: "#F5F5F5", grid: false, groups: {} };
      const tmp2 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp2, JSON.stringify(board));
      fs.renameSync(tmp2, boardPath);
    };
    const shapeRect = (id) => page.evaluate((sid) => {
      const el = document.querySelector(`#cards .card.shape[data-id="${sid}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, id);
    const selectedId = () => page.evaluate(() => {
      const el = document.querySelector(".card.selected");
      return el ? Number(el.dataset.id) : null;
    });
    const clickShapePoint = async (id, fx, fy) => {
      const r = await shapeRect(id);
      assert.ok(r, `shape ${id} has a card in the DOM`);
      await page.mouse.click(r.x + fx * r.w, r.y + fy * r.h);
      await new Promise((r2) => setTimeout(r2, 300));
      return selectedId();
    };

    await check("a click on a filled shape's empty corner selects nothing", async () => {
      await shapeBoard();
      // Wait for the watcher to load the new board BEFORE
      // fitting: F pressed while the old board is still the
      // model fits the old board, and the shapes land
      // off-screen and culled from the DOM. The 1.5s sleep
      // the bar checks use is not enough under load. The
      // wait must match a SHAPE card: the old board already
      // has a card with id 3, so an unscoped id match is a
      // false positive.
      await waitFor("shape board loaded", async () => (await shapeRect(3)) ? true : null);
      await page.keyboard.press("f");
      await waitFor("all 14 shapes in the DOM", async () => {
        const ids = await page.evaluate(() => [...document.querySelectorAll("#cards .card.shape")].map((el) => Number(el.dataset.id)));
        return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].every((id) => ids.includes(id)) ? true : null;
      });
      // Filled ellipse/triangle/diamond/hexagon/star/arrow
      // corners are empty: clicking one must select nothing.
      // (Rect fills its box, so it has no empty corner.)
      const corners = [[2, 0.08, 0.08], [3, 0.1, 0.1], [4, 0.08, 0.08], [5, 0.05, 0.05], [6, 0.05, 0.05], [7, 0.08, 0.08]];
      for (const [id, fx, fy] of corners) {
        const sel = await clickShapePoint(id, fx, fy);
        assert.equal(sel, null, `filled shape ${id} corner (${fx},${fy}) should select nothing, got ${sel}`);
      }
      // ... and the centres still select the shape.
      for (const id of [2, 3, 4, 5, 6, 7]) {
        const sel = await clickShapePoint(id, 0.5, 0.5);
        assert.equal(sel, id, `filled shape ${id} centre should select it, got ${sel}`);
      }
    });

    await check("a click on an outline shape's empty interior selects nothing, its edge selects it", async () => {
      // The shape board is already loaded by the previous check.
      for (const id of [8, 9, 10, 11, 12, 13, 14]) {
        const sel = await clickShapePoint(id, 0.5, 0.5);
        assert.equal(sel, null, `outline shape ${id} centre should select nothing, got ${sel}`);
      }
      // Edge points: top border/vertex/edge for each shape.
      // The arrow's top is not its box top — its shaft top
      // edge is at fy 0.4, so that is the edge point.
      const edges = [[8, 0.5, 0.02], [9, 0.5, 0.02], [10, 0.5, 0.97], [11, 0.5, 0.02], [12, 0.5, 0.02], [13, 0.5, 0.02], [14, 0.3, 0.4]];
      for (const [id, fx, fy] of edges) {
        const sel = await clickShapePoint(id, fx, fy);
        assert.equal(sel, id, `outline shape ${id} edge (${fx},${fy}) should select it, got ${sel}`);
      }
    });
  } catch (error) {
    results.push({ name: "setup", ok: false, error });
    console.log(`  FAIL  setup: ${String(error.message).split("\n")[0]}`);
  } finally {
    if (page && results.some((r) => !r.ok)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
      const shot = path.join(artifactsDir, "e2e-failure.png");
      await page.screenshot({ path: shot }).catch(() => undefined);
      console.log(`  failure screenshot: ${shot}`);
      console.log(`  board.json kept at: ${boardPath}`);
    }
    if (app) await app.close().catch(() => undefined);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\ne2e: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`\nFAILED: ${f.name}\n${String(f.error?.stack ?? f.error)}`);
    // Keep the temp dir on failure so the board can be inspected.
    console.log(`\ntemp dir kept: ${tmp}`);
    process.exitCode = 1;
    return;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
