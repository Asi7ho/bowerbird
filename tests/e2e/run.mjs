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

async function waitFor(label, fn, timeoutMs = 15000) {
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
  fs.writeFileSync(boardPath, JSON.stringify(EMPTY_BOARD));
  fs.writeFileSync(path.join(testPluginDir, "manifest.json"), JSON.stringify(TEST_PLUGIN_MANIFEST, null, 2));
  fs.writeFileSync(path.join(testPluginDir, "main.ts"), TEST_PLUGIN_MAIN);

  const readBoard = () => JSON.parse(fs.readFileSync(boardPath, "utf8"));
  const strokes = () => readBoard().items.filter((it) => "Stroke" in it.kind);
  const textCards = () => readBoard().items.filter((it) => "Text" in it.kind);

  const results = [];
  let app;
  let page;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [".", "--no-sandbox"],
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
      await page.waitForSelector("#board", { timeout: 15000 });
      assert.equal(await page.title(), "Bowerbird");
      assert.equal(readBoard().items.length, 0);
    });

    await check("toolbar shows zoom level and saved state", async () => {
      const zoom = page.locator("#zoom-label");
      await zoom.waitFor({ timeout: 10000 });
      assert.equal(await zoom.textContent(), "100%");
      assert.equal(await page.locator("#saved-label").textContent(), "Saved");
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

    await check("undo removes the stroke", async () => {
      await page.keyboard.press("Control+z");
      await waitFor("empty board after undo", () => readBoard().items.length === 0);
    });

    await check("double-click creates a text note and typing saves it", async () => {
      await page.keyboard.press("v");
      await doubleClick(page, 600, 600);
      await page.waitForSelector("textarea.note-edit", { timeout: 10000 });
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
      await editor.waitFor({ timeout: 10000 });
      assert.equal(await editor.inputValue(), "Hello CI");
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
      await page.waitForSelector("#board", { timeout: 15000 });
      await page.locator("text=CI plugin card").first().waitFor({ timeout: 15000 });
    });

    await check("a bundled plugin enables and its panel opens", async () => {
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("command-palette", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: 15000 });
      await page.keyboard.press("Control+k");
      await page.locator(".cmd-palette").waitFor({ state: "visible", timeout: 10000 });
      await page.keyboard.press("Escape");
    });

    await check("board survives a reload", async () => {
      await page.reload();
      await page.waitForSelector("#board", { timeout: 15000 });
      await waitFor("text note still on disk after reload", () =>
        textCards().some((it) => it.kind.Text.text === "Hello CI!"),
      );
      await page.locator("text=CI plugin card").first().waitFor({ timeout: 15000 });
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
