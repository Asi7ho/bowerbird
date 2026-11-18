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
      // The model lives in the card's own canvas now (the
      // shared layer renders offscreen and each frame is
      // copied there), so sample the canvas directly. The
      // cube is blue; the card background is light grey,
      // where the channels are nearly equal.
      const sample = () => page.evaluate((mid) => {
        const cv = document.querySelector(`#cards .card[data-id="${mid}"] canvas.model3d`);
        if (!cv) return null;
        const x = cv.getContext("2d");
        if (!x) return null;
        const pts = [];
        for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
          const bx = Math.floor(cv.width * fx);
          const by = Math.floor(cv.height * fy);
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
      // The canvas can flicker invisible while the card
      // re-renders after the model load completes, so poll
      // for its box instead of reading it once: the pixels
      // above already proved the model rendered.
      let box = null;
      for (let i = 0; i < 20; i++) {
        box = await canvas.boundingBox();
        if (box) break;
        await new Promise((r) => setTimeout(r, 500));
      }
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

    await check("the fit button re-frames a rotated model", async () => {
      // The cube is blue; the fit button must bring a
      // rotated view back to the opening framing. The
      // opening view is azimuth 0, so fit first (the model
      // has been turning on its own since it loaded),
      // measure its silhouette, drag to rotate it, then
      // fit again and check the silhouette comes back.
      const assetsDir = path.join(tmp, "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.copyFileSync(path.join(repoRoot, "tests/e2e/fixtures/cube.glb"), path.join(assetsDir, "cube.glb"));
      const board = readBoard();
      let id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      const modelId = id;
      board.items.push({ id, pos: { x: 100, y: 1250 }, size: { w: 360, h: 300 }, group: null, kind: { Model3D: { path: path.join(assetsDir, "cube.glb"), size_bytes: 1472 } } });
      board.next_id = id + 1;
      const tmp2 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp2, JSON.stringify(board));
      fs.renameSync(tmp2, boardPath);
      await new Promise((r) => setTimeout(r, 1200));
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 500));
      const canvas = page.locator(`#cards .card[data-id="${modelId}"] canvas.model3d`).first();
      await canvas.waitFor({ timeout: READY_TIMEOUT_MS });
      const fitBtn = page.locator(`#cards .card[data-id="${modelId}"] .model3d-fit`).first();
      await fitBtn.waitFor({ timeout: READY_TIMEOUT_MS });
      // The blue silhouette's bounding box over the card
      // rect, in card-local CSS pixels, plus how many grid
      // points hit the cube. Null when the cube is not
      // visible. The model lives in the card's own canvas
      // now, so read it directly — no layer readback.
      const bbox = () => page.evaluate((mid) => {
        const cv = document.querySelector(`#cards .card[data-id="${mid}"] canvas.model3d`);
        if (!cv) return null;
        const x = cv.getContext("2d");
        if (!x) return null;
        const COLS = 28, ROWS = 20;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
        for (let i = 0; i < COLS; i++) {
          for (let j = 0; j < ROWS; j++) {
            const fx = (i + 0.5) / COLS, fy = (j + 0.5) / ROWS;
            const bx = Math.floor(cv.width * fx);
            const by = Math.floor(cv.height * fy);
            const d = x.getImageData(bx, by, 1, 1).data;
            if (d[3] > 10 && d[2] > d[0] + 30 && d[2] > 80) {
              const px = cv.clientWidth * fx, py = cv.clientHeight * fy;
              if (px < x0) x0 = px; if (px > x1) x1 = px;
              if (py < y0) y0 = py; if (py > y1) y1 = py;
              n++;
            }
          }
        }
        if (n === 0) return null;
        return { x0, y0, x1, y1, n };
      }, String(modelId));
      // Five sample points over the card rect, like the
      // render check: the RGB at each point. A rotated view
      // moves the cube's faces across them; a fitted view
      // puts them back. More sensitive than the silhouette
      // box, whose edges move only a few screen pixels at
      // fit zoom.
      const sample5 = () => page.evaluate((mid) => {
        const cv = document.querySelector(`#cards .card[data-id="${mid}"] canvas.model3d`);
        if (!cv) return null;
        const x = cv.getContext("2d");
        if (!x) return null;
        const pts = [];
        for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
          const bx = Math.floor(cv.width * fx);
          const by = Math.floor(cv.height * fy);
          const d = x.getImageData(bx, by, 1, 1).data;
          pts.push([d[0], d[1], d[2]]);
        }
        return pts;
      }, String(modelId));
      const differs = (a, b) =>
        a.some((p, j) => {
          const q = b[j];
          return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 30;
        });
      // Wait for the cube to appear (same slow first load
      // as the render check — up to 30s under SwiftShader).
      let seen = null;
      for (let i = 0; i < 60; i++) {
        seen = await bbox();
        if (seen) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(seen, "the model rendered");
      // Force the opening view (azimuth 0): the model has
      // been turning since it loaded, so its angle is
      // unknown until a fit.
      await fitBtn.click();
      let fitted0 = null;
      for (let i = 0; i < 8; i++) {
        fitted0 = await sample5();
        if (fitted0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(fitted0, "view readable after the first fit");
      // Drag to rotate: the view must move.
      let box = null;
      for (let i = 0; i < 20; i++) {
        box = await canvas.boundingBox();
        if (box) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(box, "model canvas on screen");
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 120, cy, { steps: 10 });
      await page.mouse.up();
      let rotated = null;
      let didRotate = false;
      for (let i = 0; i < 20; i++) {
        rotated = await sample5();
        if (rotated && differs(rotated, fitted0)) { didRotate = true; break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(rotated, "view readable after the drag");
      assert.ok(didRotate, "dragging rotated the view (pixels changed)");
      // Fit again: the view must come back to the opening
      // framing. Poll briefly — the fit also restarts the
      // idle clock, so the model holds still for 3s.
      await fitBtn.click();
      let fitted1 = null;
      let back = false;
      for (let i = 0; i < 8; i++) {
        fitted1 = await sample5();
        if (fitted1 && !differs(fitted1, fitted0)) { back = true; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(fitted1, "view readable after the second fit");
      assert.ok(back, "the fit button re-framed the model (pixels back)");
    });

    await check("a card over a 3D card covers the cube", async () => {
      // The model lives in its card's own canvas now, so a
      // card over it must cover it — the way it covers any
      // card. Before, the shared layer sat above every card
      // and the cube floated over the covering card. This
      // reads the composite (a screenshot), not the DOM:
      // the old layer was pointer-events:none, so
      // elementFromPoint would have called the covering
      // card "on top" even while the cube showed through.
      const board = readBoard();
      const model = [...board.items].reverse().find((it) => it.kind.Model3D);
      assert.ok(model, "a 3D card is on the board");
      // Screenshot a clip to pixels: decode it in the page
      // (an Image drawn to a canvas) and sample points.
      const shot = async (clip) => {
        const buf = await page.screenshot({ clip });
        return page.evaluate(async (url) => {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          const x = c.getContext("2d");
          if (!x) return null;
          x.drawImage(img, 0, 0);
          const pts = [];
          for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
            const d = x.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
            pts.push([d[0], d[1], d[2]]);
          }
          return pts;
        }, "data:image/png;base64," + buf.toString("base64"));
      };
      const isBlue = (p) => p[2] > p[0] + 30 && p[2] > 80;
      // The fit check left the model selected, and
      // selection brings a card to the front — so the
      // covering card would land underneath it. Escape
      // clears the selection (a second press if the search
      // box had text, which Escape clears first), so the
      // cover is the top card by plain stacking order.
      // This replaces clicking an empty spot: cards are
      // pointer-events:none, so elementFromPoint can call
      // a point "empty" while the board's geometric
      // hit-test selects the card under it — which is how
      // this timed out on CI's narrower window even with
      // a retry.
      let deselected = false;
      for (let attempt = 0; attempt < 2 && !deselected; attempt++) {
        await page.keyboard.press("Escape");
        await new Promise((r) => setTimeout(r, 200));
        deselected = await page.evaluate(() => document.querySelectorAll("#cards .card.selected").length === 0);
      }
      assert.ok(deselected, "the model deselected before covering");
      await page.keyboard.press("f");
      await new Promise((r) => setTimeout(r, 500));
      const rect = await page.evaluate((mid) => {
        const el = document.querySelector(`#cards .card[data-id="${mid}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, String(model.id));
      assert.ok(rect, "the 3D card is on screen");
      // Baseline: the cube is visible at the card's centre.
      const before = await shot(rect);
      assert.ok(before && before.some(isBlue), "the cube shows before it is covered");
      // Cover the whole card with a filled rectangle.
      let id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      const coverId = id;
      board.items.push({ id, pos: { x: model.pos.x, y: model.pos.y }, size: { w: 360, h: 300 }, group: null, kind: { Shape: { shape: "rect", fill: "#FFCC00" } } });
      board.next_id = id + 1;
      const tmp2 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp2, JSON.stringify(board));
      fs.renameSync(tmp2, boardPath);
      await waitFor("cover card rendered", async () => {
        const n = await page.evaluate((cid) => document.querySelector(`#cards .card[data-id="${cid}"]`) ? true : null, String(coverId));
        return n;
      });
      await new Promise((r) => setTimeout(r, 500));
      // The cube must be gone from the composite: the
      // centre is the cover's yellow now, not the cube.
      const after = await shot(rect);
      assert.ok(after && !after.some(isBlue), "the covering card hides the cube");
      // Take the cover back off, so later checks start clean.
      const board2 = readBoard();
      board2.items = board2.items.filter((it) => it.id !== coverId);
      fs.writeFileSync(tmp2, JSON.stringify(board2));
      fs.renameSync(tmp2, boardPath);
      await waitFor("cover card removed", async () => {
        const gone = await page.evaluate((cid) => document.querySelector(`#cards .card[data-id="${cid}"]`) ? null : true, String(coverId));
        return gone;
      });
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
      // No layer to count any more: the shared canvas is
      // offscreen and the models live in their own cards.
      // The check that matters is that every model's centre
      // pixel is the cube's blue — a per-card renderer
      // would have given up at 17 contexts.
      // Poll until every model's centre pixel is the cube's
      // blue (or time out): SwiftShader renders slowly.
      let rendered = 0;
      for (let i = 0; i < 60; i++) {
        rendered = await page.evaluate((mids) => {
          let n = 0;
          for (const mid of mids) {
            const cv = document.querySelector(`#cards .card[data-id="${mid}"] canvas.model3d`);
            if (!cv) continue;
            const x = cv.getContext("2d");
            if (!x) continue;
            const d = x.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
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
        // Clear any stale toast text first, so the wait below
        // proves THIS write was followed, not an earlier reload.
        await page.evaluate(() => { const t = document.querySelector("#toast"); if (t) t.textContent = ""; });
        fs.writeFileSync(tmp2, JSON.stringify(board));
        fs.renameSync(tmp2, boardPath);
        // Wait for the watcher to deliver the write and the
        // renderer to reload it (reloadFromDisk toasts after
        // applying the new board) before fitting. A fixed
        // sleep races the watcher under load: F pressed before
        // the model updates fits the old board, and the note
        // — placed clear of the restored board's cards —
        // stays off-screen and culled from the DOM, so no
        // later wait can ever see it.
        await waitFor("board reload toast after bar note write", async () => {
          const toast = await page.evaluate(() => document.querySelector("#toast")?.textContent ?? "");
          return toast.includes("Board updated on disk") ? true : null;
        });
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

    await check("editing a linked SVG source re-imports its group in place", async () => {
      // The SVG drop above kept its source file in the board's
      // assets and linked its group to it: the file is the
      // original, not a conversion output.
      const board = readBoard();
      const linked = Object.entries(board.groups ?? {}).find(([, entry]) => entry.source?.kind === "svg");
      assert.ok(linked, "svg drop linked its group to a source");
      const group = Number(linked[0]);
      // The linked group has no label and no visible frame —
      // its cards sit on the board like any other cards. Its
      // frame element is there but invisible, and it becomes
      // a solid blue outline around the whole import when a
      // member is selected.
      const label = await page.$(`.group-label[data-group="${group}"]`);
      assert.equal(label, null, "linked group has no label");
      const frame = await page.$(`.group-frame.live-import[data-group="${group}"]`);
      assert.ok(frame, "linked group has an invisible live-import frame");
      const frameClass = await frame.evaluate((el) => el.className);
      assert.ok(!frameClass.includes("selected"), "linked group has no outline before selection");
      // Click a member: the whole group is selected, and the
      // outline appears around it without a full render.
      const red = board.items.find((it) => it.group === group && "Shape" in it.kind && it.kind.Shape.fill === "#ff0000");
      const redBox = await page.locator(`#cards .card[data-id="${red.id}"]`).boundingBox();
      assert.ok(redBox, "red rect card is on screen");
      await page.mouse.click(redBox.x + redBox.width / 2, redBox.y + redBox.height / 2);
      await waitFor("live-import outline on selection", async () => {
        const el = await page.$(`.group-frame.live-import[data-group="${group}"]`);
        if (!el) return null;
        const cls = await el.evaluate((n) => n.className);
        return cls.includes("selected") ? true : null;
      });
      const entry = linked[1];
      const sourcePath = entry.source.path;
      assert.ok(fs.existsSync(sourcePath), "kept source file exists in the board assets");
      const membersBefore = board.items.filter((it) => it.group === group);
      assert.equal(membersBefore.length, 8, "svg group has its 8 imported cards");
      const anchorOf = (items) => ({ x: Math.min(...items.map((it) => it.pos.x)), y: Math.min(...items.map((it) => it.pos.y)) });
      const anchor = anchorOf(membersBefore);
      // Edit the source outside the app: the red rect turns
      // blue and a purple circle appears, so the re-import
      // is visible in board.json.
      const edited = fs.readFileSync(path.join(repoRoot, "tests/e2e/fixtures", "sample.svg"), "utf8")
        .replace('fill="#ff0000"', 'fill="#0000ff"')
        .replace("</svg>", '  <circle cx="150" cy="50" r="15" fill="#800080"/>\n</svg>');
      fs.writeFileSync(sourcePath, edited);
      await waitFor("re-imported svg in board.json", () => {
        const b = readBoard();
        const members = b.items.filter((it) => it.group === group);
        const blue = members.filter((it) => "Shape" in it.kind && it.kind.Shape.fill === "#0000ff");
        const purple = members.filter((it) => "Shape" in it.kind && it.kind.Shape.fill === "#800080");
        return blue.length === 2 && purple.length === 1 && members.length === 9 ? b : null;
      });
      // The group kept its place on the board, and the
      // stored stat moved to the edited file.
      const after = readBoard();
      const anchorAfter = anchorOf(after.items.filter((it) => it.group === group));
      assert.ok(Math.abs(anchorAfter.x - anchor.x) < 1 && Math.abs(anchorAfter.y - anchor.y) < 1, "re-import kept the group's place");
      assert.notEqual(after.groups[group].source.size, entry.source.size, "source stat updated");
      assert.ok(after.groups[group].source.mtimeMs > entry.source.mtimeMs, "source mtime updated");
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

    await check("dropping a PSD lands one FileCard with a preview", async () => {
      const before = countKind("FileCard");
      await dropFixture("sample.psd", "image/vnd.adobe.photoshop");
      const card = await waitFor("psd file card in board.json", () => {
        const found = readBoard().items.filter((it) => "FileCard" in it.kind && it.kind.FileCard.format === "psd");
        return found.length === before + 1 ? found[found.length - 1] : null;
      });
      assert.equal(card.size.w, 360, "file card is 360 wide");
      assert.ok(card.kind.FileCard.path.endsWith("sample.psd"), "file card points at the kept source");
      assert.ok(fs.existsSync(card.kind.FileCard.path), "kept psd source exists on disk");
      assert.ok(card.kind.FileCard.preview, "file card has a preview");
      assert.ok(fs.existsSync(card.kind.FileCard.preview), "preview png exists on disk");
      assert.ok(card.kind.FileCard.size_bytes > 0, "file card records the source size");
      assert.ok(card.group !== null, "file card is in its linked group");
    });

    await check("dropping a PDF-compatible .ai lands one FileCard, not a PdfCard", async () => {
      const before = {
        pdf: countKind("PdfCard"),
        ai: readBoard().items.filter((it) => "FileCard" in it.kind && it.kind.FileCard.format === "ai").length,
      };
      await dropFixture("sample.ai", "application/pdf");
      const card = await waitFor("ai file card in board.json", () => {
        const found = readBoard().items.filter((it) => "FileCard" in it.kind && it.kind.FileCard.format === "ai");
        return found.length === before.ai + 1 ? found[found.length - 1] : null;
      });
      assert.equal(countKind("PdfCard"), before.pdf, "no PdfCard for the .ai file");
      assert.ok(card.kind.FileCard.path.endsWith("sample.ai"), "file card points at the kept source");
      assert.ok(fs.existsSync(card.kind.FileCard.path), "kept ai source exists on disk");
      assert.ok(card.kind.FileCard.preview, "file card has a preview");
      assert.ok(fs.existsSync(card.kind.FileCard.preview), "preview png exists on disk");
      assert.ok(card.group !== null, "file card is in its linked group");
    });

    await check("dropping a vector .ai lands one FileCard with a preview of the artwork", async () => {
      const before = readBoard().items.filter((it) => "FileCard" in it.kind && it.kind.FileCard.format === "ai").length;
      await dropFixture("sample-vector.ai", "application/pdf");
      const card = await waitFor("vector ai file card in board.json", () => {
        const found = readBoard().items.filter((it) => "FileCard" in it.kind && it.kind.FileCard.format === "ai");
        return found.length === before + 1 ? found[found.length - 1] : null;
      });
      assert.equal(card.size.w, 360, "file card is 360 wide");
      assert.ok(card.kind.FileCard.path.endsWith("sample-vector.ai"), "file card points at the kept source");
      assert.ok(fs.existsSync(card.kind.FileCard.preview), "preview png exists on disk");
      assert.ok(card.group !== null, "file card is in its linked group");
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

    // fix/shape-preview-above-cards: the shape draw preview
    // must paint above the existing cards, not hide behind
    // them (it used to live in the canvas SVG below #cards).
    await check("the shape preview draws above an existing card", async () => {
      // The bar-test note is buried under the cards the formats
      // checks dropped at the screen centre, so clicking it
      // would select the topmost import instead of the note.
      // Put a fresh note in clear space for this check, past
      // the rightmost card, where nothing overlaps it.
      await page.evaluate(() => {
        const t = document.querySelector("#toast");
        if (t) t.textContent = "";
      });
      const board0 = readBoard();
      const maxRight0 = board0.items.reduce((m, it) => Math.max(m, it.pos.x + it.size.w), 0);
      const id0 = Math.max(board0.next_id, ...board0.items.map((it) => it.id)) + 1;
      board0.items.push({ id: id0, pos: { x: maxRight0 + 200, y: 300 }, size: { w: 260, h: 80 }, group: null, kind: { Text: { text: "Preview test note", bold: false, size: 16, color: "#1A1A1A" } } });
      board0.next_id = id0 + 1;
      const tmp3 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp3, JSON.stringify(board0));
      fs.renameSync(tmp3, boardPath);
      // The reload toast only shows once the new board is
      // applied, so waiting for it beats the fixed 1.5s sleep
      // the bar checks use — under load the watcher takes
      // longer than that and F would fit the stale board.
      await waitFor("preview note reloaded", () => page.evaluate(() => (document.querySelector("#toast")?.textContent ?? "").includes("Board updated on disk") ? true : null));
      await page.keyboard.press("f");
      await waitFor("preview test note in the DOM", async () => {
        const n = await page.evaluate(() => [...document.querySelectorAll("#cards .card .note-body")].some((b) => (b.innerText || "").includes("Preview test note")));
        return n ? true : null;
      });
      const ctr = await page.evaluate(() => {
        const c = [...document.querySelectorAll("#cards .card .note-body")].find((b) => (b.innerText || "").includes("Preview test note"));
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      });
      assert.ok(ctr, "preview test note has a centre on screen");
      // Select the note, so its colour bar and resize handle
      // are showing: the preview must paint above those too,
      // not just above the card. The click is at the note
      // centre and the drag starts elsewhere, so it cannot
      // pair with the drag's press as a double-click.
      await page.mouse.click(ctr.x, ctr.y);
      await waitFor("note bar and resize handle visible", async () => {
        const s = await page.evaluate(() => {
          const bar = document.querySelector("#note-colours");
          const h = document.querySelector("#resize-handle");
          return bar && getComputedStyle(bar).display === "flex" && h && getComputedStyle(h).display !== "none" ? true : null;
        });
        return s;
      });
      const geom = await page.evaluate(() => {
        const bar = document.querySelector("#note-colours");
        const sw = bar.querySelector(".swatch");
        const h = document.querySelector("#resize-handle");
        const br = bar.getBoundingClientRect();
        const sr = sw.getBoundingClientRect();
        const hr = h.getBoundingClientRect();
        return {
          barLeft: br.left,
          swatch: { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 },
          handle: { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 },
        };
      });
      // Select the rectangle shape tool, then draw across
      // the note in ONE gesture: a click first would select
      // the note, and a second press at the same spot reads
      // as a double-click and opens the editor instead of
      // drawing.
      await page.keyboard.press("r");
      await new Promise((r) => setTimeout(r, 300));
      // Drag diagonally from left of the colour bar to past
      // the resize handle, so the preview rect covers the
      // bar, the note and the handle alike (a horizontal drag
      // makes a zero-height rect, which paints nothing). The
      // drag starts 20px above the first swatch, so the swatch
      // sits inside the preview fill: starting exactly on its
      // centre would put it on the rect's top edge, and at a
      // fit zoom below 1 the edge can round a fraction of a
      // pixel past the point — a filled shape has no stroke to
      // catch it.
      const sx = geom.barLeft - 20, sy = geom.swatch.y - 20;
      const ex = geom.handle.x + 15, ey = geom.handle.y + 15;
      const mx = (sx + ex) / 2, my = (sy + ey) / 2;
      const before = await page.evaluate(() => document.querySelectorAll("#cards .card").length);
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(ex, ey, { steps: 12 });
      await new Promise((r) => setTimeout(r, 400));
      // The preview must be the topmost element at the drag
      // midpoint: it lives in the preview layer above #cards,
      // so it paints over the note instead of hiding behind it.
      // The layer is pointer-events: none in the app (it must
      // never intercept a click on a card below), so
      // elementFromPoint skips it by default — restore hit
      // testing just for this probe. That changes nothing
      // about paint order; it only reveals it.
      const hit = await page.evaluate(([x, y]) => {
        const svg = document.querySelector("#preview-svg");
        const prev = svg.style.pointerEvents;
        svg.style.pointerEvents = "auto";
        const prevEl = document.querySelector("#shape-preview");
        const el = document.elementFromPoint(x, y);
        const out = {
          previewExists: !!prevEl,
          previewParent: prevEl ? prevEl.parentElement?.id : null,
          hitId: el ? el.id : null,
          hitInCards: el ? !!el.closest("#cards") : false,
        };
        svg.style.pointerEvents = prev;
        return out;
      }, [mx, my]);
      assert.ok(hit.previewExists, "shape preview exists mid-drag");
      assert.equal(hit.previewParent, "preview-world", "shape preview lives in the preview layer");
      assert.equal(hit.hitId, "shape-preview", "the preview is the topmost element over the note");
      assert.equal(hit.hitInCards, false, "the note does not cover the preview");
      // The preview must also paint above the resize handle
      // (z-index 100) and the note colour bar (40), not just
      // above the card: the preview layer carries z-index 110.
      // elementsFromPoint skips pointer-events: none elements,
      // so flip the preview and the handle to auto just for
      // this probe — that reveals the paint order without
      // changing it.
      const order = await page.evaluate(([hx, hy, bx, by]) => {
        const svg = document.querySelector("#preview-svg");
        const hd = document.querySelector("#resize-handle");
        const prevSvg = svg.style.pointerEvents, prevHd = hd.style.pointerEvents;
        svg.style.pointerEvents = "auto";
        hd.style.pointerEvents = "auto";
        const at = (x, y) => [...document.elementsFromPoint(x, y)].map((el) => el.id).filter(Boolean);
        const out = { handle: at(hx, hy), bar: at(bx, by) };
        svg.style.pointerEvents = prevSvg;
        hd.style.pointerEvents = prevHd;
        return out;
      }, [geom.handle.x, geom.handle.y, geom.swatch.x, geom.swatch.y]);
      assert.ok(order.handle.includes("shape-preview"), "preview is in the stack at the handle");
      assert.ok(order.handle.indexOf("shape-preview") < order.handle.indexOf("resize-handle"), "preview paints above the resize handle");
      assert.ok(order.bar.includes("shape-preview"), "preview is in the stack at the bar");
      assert.ok(order.bar.indexOf("shape-preview") < order.bar.indexOf("note-colours"), "preview paints above the note colour bar");
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 500));
      // The preview is cleared by the render on mouseup, and
      // the shape lands as a new card.
      const after = await page.evaluate(() => ({
        previewGone: !document.querySelector("#shape-preview"),
        cards: document.querySelectorAll("#cards .card").length,
      }));
      assert.ok(after.previewGone, "shape preview is gone after mouseup");
      assert.equal(after.cards, before + 1, "the drawn shape lands as a new card");
      // The completed shape lands ABOVE the card it overlaps,
      // not behind it: it is the last card in the DOM. The shape
      // is the last card, not the first non-note one: the
      // hit-test checks above replace the board with 14 shapes,
      // so the first non-note card predates the note this check
      // drew over.
      const stack = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#cards .card"));
        const note = cards.find((c) => (c.querySelector(".note-body")?.textContent ?? "").includes("Preview test note"));
        const shape = cards[cards.length - 1];
        if (!note || !shape || shape === note) return { shapeAfterNote: false, noteZ: 0, shapeZ: 0 };
        return {
          shapeAfterNote: !!(note.compareDocumentPosition(shape) & Node.DOCUMENT_POSITION_FOLLOWING),
          noteZ: Number(getComputedStyle(note).zIndex),
          shapeZ: Number(getComputedStyle(shape).zIndex),
        };
      });
      assert.ok(stack.shapeAfterNote, "completed shape is after the note in the DOM");
      // Selecting the note brings it to the front: while it
      // is selected it paints above the shape it was drawn
      // under, and its handle and colour bar sit above it
      // coherently instead of floating over the shape while
      // the note stays behind.
      assert.ok(stack.noteZ > stack.shapeZ, "the selected note paints above the shape");
      // Deselecting returns the note to its place, below the
      // shape: switch back to the select tool, then click
      // empty board, which clears the selection. (With the
      // shape tool still active, the click would start
      // another shape drag instead of deselecting.)
      await page.keyboard.press("v");
      await new Promise((r) => setTimeout(r, 300));
      const empty = await page.evaluate(() => {
        const rects = [...document.querySelectorAll("#cards .card")].map((c) => c.getBoundingClientRect());
        const tb = document.querySelector("#toolbar")?.getBoundingClientRect();
        const bar = document.querySelector("#note-colours")?.getBoundingClientRect();
        const blocked = [...rects, tb, bar].filter(Boolean);
        for (let y = 90; y < 800; y += 80) {
          for (let x = 100; x < 1200; x += 80) {
            if (!blocked.some((r) => x > r.left - 4 && x < r.right + 4 && y > r.top - 4 && y < r.bottom + 4)) return { x, y };
          }
        }
        return null;
      });
      assert.ok(empty, "there is empty board to click to deselect");
      await page.mouse.click(empty.x, empty.y);
      await new Promise((r) => setTimeout(r, 400));
      const back = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("#cards .card")];
        const note = cards.find((c) => (c.querySelector(".note-body")?.textContent ?? "").includes("Preview test note"));
        const shape = cards[cards.length - 1];
        return {
          selected: document.querySelectorAll("#cards .card.selected").length,
          noteZ: Number(getComputedStyle(note).zIndex),
          shapeZ: Number(getComputedStyle(shape).zIndex),
        };
      });
      assert.equal(back.selected, 0, "nothing is selected after clicking empty board");
      assert.ok(back.noteZ < back.shapeZ, "deselecting returns the note below the shape");
    });
    // --- fix/tool-shortcut-bugs: a shortcut keeps the tool in
    // use, and no toolbar button keeps an outline after one.
    await check("a shortcut keeps the tool in use and leaves no outline on the toolbar", async () => {
      const toolOf = () => {
        const active = (id) => document.getElementById(id)?.classList.contains("active");
        if (active("tool-select")) return "select";
        if (active("tool-connector")) return "connector";
        if (active("tool-draw")) return document.getElementById("tool-draw").dataset.draw;
        if (active("tool-shape")) return document.getElementById("tool-shape").dataset.shape;
        return "unknown";
      };
      const outlined = () => {
        const out = [];
        for (const b of document.querySelectorAll("#toolbar button")) {
          const cs = getComputedStyle(b);
          if (cs.outlineStyle !== "none" && cs.outlineWidth !== "0px") out.push(b.id || b.className);
        }
        return out;
      };
      // Pencil stays pencil through P, not back to the pen.
      await page.click("#tool-draw");
      await page.waitForSelector('#draw-picker button[data-draw="pencil"]', { state: "visible" });
      await page.click('#draw-picker button[data-draw="pencil"]');
      await page.keyboard.press("p");
      assert.equal(await page.evaluate(toolOf), "pencil", "P must not switch the pencil back to the pen");
      // R is the one geometry shortcut: it activates the
      // shape last chosen, not always the rectangle. A
      // triangle stays a triangle through R, and R remembers
      // it after switching away and back.
      await page.click("#tool-shape");
      await page.waitForSelector('#shape-picker button[data-shape="triangle"]', { state: "visible" });
      await page.click('#shape-picker button[data-shape="triangle"]');
      await page.keyboard.press("r");
      assert.equal(await page.evaluate(toolOf), "triangle", "R must not reset the triangle to a rectangle");
      await page.keyboard.press("v");
      await page.keyboard.press("r");
      assert.equal(await page.evaluate(toolOf), "triangle", "R must remember the triangle after switching away");
      // Picking another shape updates what R remembers.
      await page.click("#tool-shape");
      await page.waitForSelector('#shape-picker button[data-shape="ellipse"]', { state: "visible" });
      await page.click('#shape-picker button[data-shape="ellipse"]');
      await page.keyboard.press("v");
      await page.keyboard.press("r");
      assert.equal(await page.evaluate(toolOf), "ellipse", "R must remember the ellipse once it is chosen");
      // E is gone: it must not switch to the ellipse, from
      // a shape or from select.
      await page.keyboard.press("e");
      assert.equal(await page.evaluate(toolOf), "ellipse", "E must not change the tool");
      await page.keyboard.press("v");
      await page.keyboard.press("e");
      assert.equal(await page.evaluate(toolOf), "select", "E must not switch to the ellipse from select");
      // V is the one select shortcut: it activates the
      // selection mode last chosen (plain select or lasso).
      // A lasso stays a lasso through V, and V remembers it
      // after switching away and back — and a real lasso loop
      // selects the card it encloses.
      const modeOf = () => document.getElementById("tool-select")?.dataset.mode ?? "select";
      await page.click("#tool-select");
      await page.waitForSelector('#select-picker button[data-mode="lasso"]', { state: "visible" });
      await page.click('#select-picker button[data-mode="lasso"]');
      assert.equal(await page.evaluate(modeOf), "lasso", "picking lasso must show it on the select button");
      await page.keyboard.press("p");
      await page.keyboard.press("v");
      assert.equal(await page.evaluate(modeOf), "lasso", "V must remember the lasso after switching away");
      // A lasso loop around the Preview test note selects it.
      // The loop starts on empty board around the note, so
      // the drag is a lasso, not a card drag.
      const note = await page.evaluate(() => {
        const card = [...document.querySelectorAll("#cards .card")].find((c) => (c.querySelector(".note-body")?.textContent ?? "").includes("Preview test note"));
        if (!card) return null;
        const r = card.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      assert.ok(note, "the Preview test note is on screen to lasso");
      await page.mouse.move(note.x - 20, note.y - 20);
      await page.mouse.down();
      await page.mouse.move(note.x + note.w + 20, note.y - 20, { steps: 5 });
      await page.mouse.move(note.x + note.w + 20, note.y + note.h + 20, { steps: 5 });
      await page.mouse.move(note.x - 20, note.y + note.h + 20, { steps: 5 });
      await page.mouse.move(note.x - 20, note.y - 20, { steps: 5 });
      await page.mouse.up();
      const lassoed = await page.evaluate(() => [...document.querySelectorAll("#cards .card")].some((c) => c.classList.contains("selected") && (c.querySelector(".note-body")?.textContent ?? "").includes("Preview test note")));
      assert.ok(lassoed, "the lasso loop must select the note it encloses");
      // Picking plain select updates what V remembers, and
      // L is gone: it must not turn the lasso back on.
      await page.click("#tool-select");
      await page.waitForSelector('#select-picker button[data-mode="select"]', { state: "visible" });
      await page.click('#select-picker button[data-mode="select"]');
      await page.keyboard.press("p");
      await page.keyboard.press("v");
      assert.equal(await page.evaluate(modeOf), "select", "V must remember plain select once it is chosen");
      await page.keyboard.press("l");
      assert.equal(await page.evaluate(modeOf), "select", "L must not turn the lasso on");
      // The colour bar hides the shape picker: only one
      // flyout shows at a time. Closing the colour bar does
      // not bring it back — it only appears on a tool button
      // click or a tool shortcut, so the shape button does.
      await page.click("#tool-shape");
      await page.waitForSelector("#shape-picker", { state: "visible" });
      await page.click("#tool-colour");
      await page.waitForSelector("#shape-picker", { state: "hidden" });
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("palette")).display), "flex", "the colour bar must show while the shape picker hides");
      await page.click("#tool-colour");
      await page.waitForSelector("#shape-picker", { state: "hidden" });
      await page.click("#tool-shape");
      await page.waitForSelector("#shape-picker", { state: "visible" });
      // A flyout disappears once a tool is picked from it,
      // and a tool shortcut opens it again.
      await page.click('#shape-picker button[data-shape="triangle"]');
      await page.waitForSelector("#shape-picker", { state: "hidden" });
      await page.keyboard.press("r");
      await page.waitForSelector("#shape-picker", { state: "visible" });
      // Clicking empty board dismisses it too.
      const empty2 = await page.evaluate(() => {
        const rects = [...document.querySelectorAll("#cards .card")].map((c) => c.getBoundingClientRect());
        rects.push(document.getElementById("toolbar-wrap").getBoundingClientRect());
        rects.push(document.getElementById("note-colours").getBoundingClientRect());
        // The flyouts hang off the toolbar's right side, so
        // the toolbar's own rect does not cover them.
        for (const p of document.querySelectorAll("#toolbar .palette")) rects.push(p.getBoundingClientRect());
        for (let y = 100; y < 800; y += 20) {
          for (let x = 100; x < 1200; x += 20) {
            if (!rects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)) return { x, y };
          }
        }
        return null;
      });
      assert.ok(empty2, "there is empty board to click to dismiss the flyout");
      await page.mouse.click(empty2.x, empty2.y);
      await page.waitForSelector("#shape-picker", { state: "hidden" });
      // No toolbar button shows an outline after a shortcut:
      // a clicked button is blurred, so it cannot keep focus
      // and match :focus-visible on the next keypress.
      await page.click("#tool-draw");
      await page.keyboard.press("p");
      assert.deepEqual(await page.evaluate(outlined), [], "no toolbar button may show an outline after a shortcut");
      // The arrow shows the pen colour, and a drawn arrow
      // uses it too. The colour button shows no outline
      // when the colour bar is open.
      await page.click("#tool-colour");
      await page.waitForSelector("#palette", { state: "visible" });
      await page.click('#palette button[title="#E63946"]');
      // The toolbar arrow stays black: only the drawn
      // arrow takes the pen colour.
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("tool-connector")).color), "rgb(29, 29, 31)", "the toolbar arrow must stay black");
      await page.click("#tool-colour");
      await page.waitForSelector("#palette", { state: "visible" });
      const swatchRing = await page.evaluate(() => getComputedStyle(document.getElementById("tool-colour"), "::before").boxShadow);
      assert.ok(!swatchRing.includes("0, 122, 255"), "the colour button must show no accent outline when the colour bar is open");
      await page.click("#tool-colour");
      // Draw an arrow from the Preview test note to empty
      // board: it must land in the pen colour.
      const before = readBoard().items.filter((it) => "Connector" in it.kind).length;
      const from = await page.evaluate(() => {
        const card = [...document.querySelectorAll("#cards .card")].find((c) => (c.querySelector(".note-body")?.textContent ?? "").includes("Preview test note"));
        if (!card) return null;
        const r = card.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      assert.ok(from, "the Preview test note is on screen to draw an arrow from");
      const to = await page.evaluate(() => {
        const rects = [...document.querySelectorAll("#cards .card")].map((c) => c.getBoundingClientRect());
        rects.push(document.getElementById("toolbar-wrap").getBoundingClientRect());
        for (let y = 100; y < 800; y += 20) {
          for (let x = 100; x < 1200; x += 20) {
            if (!rects.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)) return { x, y };
          }
        }
        return null;
      });
      assert.ok(to, "there is empty board to draw the arrow to");
      await page.keyboard.press("a");
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
      await waitFor("arrow saved", () => readBoard().items.filter((it) => "Connector" in it.kind).length > before ? true : null);
      const drawn = readBoard().items.find((it) => "Connector" in it.kind);
      assert.equal(drawn.kind.Connector.color, "#E63946", "a drawn arrow must use the pen colour");
    });
    // ---------------------------------------------------------------
    // feat/reliability-trust: crash recovery, version history UI,
    // and the save-on-quit flush. These run last: the kill check
    // SIGKILLs the app and relaunches it, and the quit check
    // closes the window for good.
    const recoveryPath = path.join(path.dirname(boardPath), "recovery.json");
    const launchApp = () =>
      electron.launch({
        executablePath: electronPath,
        args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
        cwd: repoRoot,
        env: {
          ...process.env,
          BOWERBIRD_BOARD_PATH: boardPath,
          XDG_DATA_HOME: dataHome,
          XDG_CONFIG_HOME: configHome,
          BOWERBIRD_PLUGINS_DIR: pluginsDir,
        },
      });

    await check("a version restores from the Boards panel history", async () => {
      // Enable the Boards plugin (bundled, opt-in) and open its panel.
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("boards", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      await page.locator('.plugin-tab[aria-label="Boards"]').click();
      await page.locator(".bd-history").waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
      // The oldest kept backup is the suite's first snapshot.
      const oldest = await waitFor("a backup row in Versions", async () => {
        const list = await page.evaluate(() => window.bowerbird.listAllBackups());
        return list.length >= 1 ? list[list.length - 1] : null;
      });
      const backupCount = (await page.evaluate(() => window.bowerbird.listAllBackups())).length;
      await waitFor("all backup rows render", async () => {
        const n = await page.locator(".bd-version-row").count();
        return n === backupCount ? true : null;
      });
      // Two-click arm, like the board list's delete: the first
      // click arms it, the second restores.
      const row = page.locator(".bd-version-row").last();
      await row.locator(".bd-restore").click();
      await row.locator(".bd-restore").click();
      await waitFor("board.json restored to the oldest version", () => {
        const restored = readBoard();
        return (
          restored.items.length === oldest.items &&
          !textCards().some((it) => it.kind.Text.text === "Bar test note")
        );
      });
      // The file is restored; reload proves the app loads it.
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      assert.equal(textCards().some((it) => it.kind.Text.text === "Bar test note"), false);
    });

    await check("a kill mid-edit is offered back at launch", async () => {
      // Make an edit, then make its save refuse: rewrite
      // board.json on disk while the note editor is open, so
      // the guard sees disk != lastSavedJson when Escape
      // commits the note. The refused save keeps the journal.
      await page.keyboard.press("v");
      await doubleClick(page, 600, 600);
      await page.waitForSelector("textarea.note-edit", { timeout: READY_TIMEOUT_MS });
      await page.keyboard.type("Do not lose me");
      const disk = readBoard();
      disk.camera.zoom = 9.9; // obviously external, so the guard refuses
      const tmp3 = `${boardPath}.tmp`;
      fs.writeFileSync(tmp3, JSON.stringify(disk));
      fs.renameSync(tmp3, boardPath);
      await page.keyboard.press("Escape");
      // The journal is the write-ahead copy of the refused
      // save: it must hold the edit even though board.json does not.
      await waitFor("journal holds the refused edit", () => {
        if (!fs.existsSync(recoveryPath)) return null;
        const rec = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
        return rec.board?.items?.some((it) => "Text" in it.kind && it.kind.Text.text === "Do not lose me") ? true : null;
      });
      assert.equal(textCards().some((it) => it.kind.Text.text === "Do not lose me"), false);
      // Kill the process dead (no beforeunload, no save) and relaunch.
      // Playwright's app.process() throws once the process is
      // dead, so capture the ChildProcess first and poll it —
      // the object stays valid after death. Node leaves exitCode
      // null for a signal-killed process and sets signalCode
      // instead, so accept either.
      const proc = app.process();
      assert.ok(proc, "electron process handle");
      process.kill(proc.pid, "SIGKILL");
      await waitFor("app process exits after SIGKILL", () => (proc.exitCode !== null || proc.signalCode !== null ? true : null), 10000);
      app = await launchApp();
      page = await app.firstWindow();
      await page.waitForSelector("#recovery-dialog", { timeout: READY_TIMEOUT_MS });
      await page.locator(".recovery-restore").click();
      await waitFor("restored note in board.json", () =>
        textCards().some((it) => it.kind.Text.text === "Do not lose me"),
      );
      assert.equal(fs.existsSync(recoveryPath), false);
    });

    await check("a pending save flushes on quit", async () => {
      // A wheel pan saves only after a 400 ms debounce, so
      // closing the window right after it proves the
      // beforeunload flush, not the ordinary save.
      const before = readBoard();
      const zoom = before.camera.zoom;
      // The wheel event is queued in the renderer, so a
      // close evaluated at once can run before the wheel
      // handler moves the camera — and the flush would
      // faithfully save the un-panned board. Wait for the
      // pan to land in the DOM (applyCamera sets the
      // cards transform synchronously in the wheel
      // handler) before closing, so the flush is what is
      // tested. Closing still happens well inside the
      // 400 ms debounce, so the ordinary save cannot
      // explain it.
      const cardsTransform = () => page.evaluate(() => document.querySelector("#cards")?.style.transform ?? "");
      const transformBefore = await cardsTransform();
      await page.mouse.move(640, 100);
      await page.mouse.wheel(0, 100);
      await waitFor("wheel pan applied", async () => (await cardsTransform()) !== transformBefore ? true : null);
      // Capture the process before closing: app.process()
      // throws once the process is dead.
      const proc = app.process();
      assert.ok(proc, "electron process handle");
      await page.evaluate(() => window.bowerbird.closeWindow()).catch(() => undefined);
      await waitFor("app process exits after close", () => (proc.exitCode !== null ? true : null), 10000);
      const after = readBoard();
      const expectedY = before.camera.y + 100 / zoom;
      assert.ok(Math.abs(after.camera.y - expectedY) < 1, `camera y should be ${expectedY}, got ${after.camera.y}`);
      assert.equal(after.camera.x, before.camera.x);
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
