// Old-board load proof: a board.json in the OLD format (no
// `layer`, `layers` or `extensions`) opens unchanged —
// file byte-identical — then the new API is exercised live
// on it: layer heal/create/move/hide, undo/redo, extensions.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// A board in the old format: no layer field anywhere, no
// extensions. Three text cards and one stroke, all near the
// origin so they are on screen at the default camera.
const OLD_BOARD = {
  items: [
    { id: 1, pos: { x: 100, y: 100 }, size: { w: 260, h: 48 }, group: null, kind: { Text: { text: "Alpha", bold: false, size: 16, color: "#1A1A1A" } } },
    { id: 2, pos: { x: 450, y: 100 }, size: { w: 260, h: 48 }, group: null, kind: { Text: { text: "Beta", bold: false, size: 16, color: "#1A1A1A" } } },
    { id: 3, pos: { x: 100, y: 300 }, size: { w: 260, h: 48 }, group: null, kind: { Text: { text: "Gamma", bold: false, size: 16, color: "#1A1A1A" } } },
    { id: 4, pos: { x: 100, y: 500 }, size: { w: 200, h: 20 }, group: null, kind: { Stroke: { points: [{ x: 100, y: 500 }, { x: 300, y: 500 }], color: "#1A1A1A", width: 3, marker: false } } },
  ],
  camera: { x: 0, y: 0, zoom: 1 },
  next_id: 5,
  next_group: 0,
  bg: "#FFFFFF",
  grid: "Dots",
};

const PLUGIN_A_MANIFEST = {
  id: "layer-proof-a",
  name: "Layer Proof A",
  version: "0.1.0",
  apiVersion: "2",
  description: "Proves layers and extensions on an old-format board.",
  permissions: ["board:write"],
  main: "main.ts",
};

// The result lives in this plugin's own extension, so it
// survives the reload and later activations skip re-running.
const PLUGIN_A_MAIN = `
export function activate(api) {
  const existing = api.board.getExtension();
  if (existing && existing.proof) {
    window.__layerProofA = existing.proof;
    return;
  }
  const proof = {};
  const cards = () => document.querySelectorAll("#cards .card").length;
  // User plugins activate before the first board render, so
  // render once before counting cards.
  api.board.render();
  // 1. The old board heals in memory: one default layer,
  //    every item on it, extensions empty.
  const before = api.board.get();
  proof.healedLayers = before.layers;
  proof.healedExtensions = before.extensions;
  proof.itemLayersBefore = [1, 2, 3, 4].map((id) => api.board.getItemLayer(id));
  proof.cardsBefore = cards();
  // 2. Layer create / move / hide, live.
  const layer = api.board.createLayer("Ink");
  proof.createdLayer = layer;
  proof.setItemLayer = api.board.setItemLayer(1, layer.id);
  proof.itemLayerAfter = api.board.getItemLayer(1);
  proof.setVisible = api.board.setLayerVisible(layer.id, false);
  proof.cardsHidden = cards();
  // 3. Undo the hide (one undo step), then redo it.
  proof.undo = api.board.undo();
  proof.visibleAfterUndo = api.board.getLayers().find((l) => l.id === layer.id).visible;
  proof.cardsAfterUndo = cards();
  proof.redo = api.board.redo();
  proof.visibleAfterRedo = api.board.getLayers().find((l) => l.id === layer.id).visible;
  proof.cardsAfterRedo = cards();
  // 4. Extensions: write, read back, and refuse non-JSON.
  api.board.setExtension({ frames: 2, fps: 12 });
  proof.extension = api.board.getExtension();
  const circular = {};
  circular.self = circular;
  try { api.board.setExtension(circular); proof.circularThrew = false; }
  catch { proof.circularThrew = true; }
  proof.extensionAfterCircular = api.board.getExtension();
  proof.finalLayers = api.board.getLayers();
  // The proof rides in the extension itself, so the reload
  // that enabling requires does not lose it.
  api.board.setExtension({ frames: 2, fps: 12, proof });
  window.__layerProofA = proof;
}
export function deactivate() {}
`;

const PLUGIN_B_MANIFEST = {
  id: "layer-proof-b",
  name: "Layer Proof B",
  version: "0.1.0",
  apiVersion: "2",
  description: "Proves a plugin sees only its own extension namespace.",
  permissions: ["board:write"],
  main: "main.ts",
};

const PLUGIN_B_MAIN = `
export function activate(api) {
  // Another plugin's namespace: empty, even though plugin A
  // already wrote its own entry.
  const seen = api.board.getExtension();
  api.board.setExtension({ brush: "pencil" });
  window.__layerProofB = { seenBeforeOwnWrite: seen ?? null, ownAfterWrite: api.board.getExtension() };
}
export function deactivate() {}
`;

const READY_TIMEOUT_MS = 120000;

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
  throw new Error(`timed out waiting for: ${label}${lastError ? ` (last error: ${String(lastError)})` : ""}`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  if (!process.env.DISPLAY && process.platform === "linux") {
    throw new Error("no display: run under xvfb-run -a (see tests/README.md)");
  }
  for (const needed of ["dist/index.html", "electron-dist/main.js"]) {
    if (!fs.existsSync(path.join(repoRoot, needed))) {
      throw new Error(`missing ${needed}: run \`npm run build\` first`);
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-old-board-"));
  const boardPath = path.join(tmp, "board.json");
  const dataHome = path.join(tmp, "data");
  const configHome = path.join(tmp, "config");
  const pluginsDir = path.join(tmp, "plugins");
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });
  const pluginADir = path.join(pluginsDir, "layer-proof-a");
  const pluginBDir = path.join(pluginsDir, "layer-proof-b");
  fs.mkdirSync(pluginADir, { recursive: true });
  fs.mkdirSync(pluginBDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify(OLD_BOARD));
  fs.writeFileSync(path.join(pluginADir, "manifest.json"), JSON.stringify(PLUGIN_A_MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginADir, "main.ts"), PLUGIN_A_MAIN);
  fs.writeFileSync(path.join(pluginBDir, "manifest.json"), JSON.stringify(PLUGIN_B_MANIFEST, null, 2));
  fs.writeFileSync(path.join(pluginBDir, "main.ts"), PLUGIN_B_MAIN);

  const hashBefore = sha256(boardPath);
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ok  ${name}`);
    } catch (error) {
      results.push({ name, ok: false, error });
      console.log(`  FAIL  ${name}: ${String(error.message)}`);
    }
  };

  let app;
  try {
    app = await electron.launch({
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
    const page = await app.firstWindow();
    await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
    // Let any boot-time async work settle before judging the file.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await check("old board loads unchanged: file byte-identical after load", async () => {
      assert.equal(sha256(boardPath), hashBefore);
      const onDisk = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      assert.equal("layers" in onDisk, false);
      assert.equal("extensions" in onDisk, false);
      assert.deepEqual(onDisk.items.map((it) => it.id), [1, 2, 3, 4]);
    });

    await check("old board loads unchanged: all four items render", async () => {
      const n = await page.evaluate(() => document.querySelectorAll("#cards .card").length);
      assert.equal(n, 4);
      for (const text of ["Alpha", "Beta", "Gamma"]) {
        assert.ok(await page.evaluate((t) => [...document.querySelectorAll("#cards .card")].some((el) => el.textContent.includes(t)), text), `missing card ${text}`);
      }
    });

    await check("layers and extensions work live on the healed board", async () => {
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("layer-proof-a", true)), true);
      // Enabling only takes effect on reload, like the main suite.
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      const r = await waitFor("layer proof result", () => page.evaluate(() => window.__layerProofA ?? null));
      assert.deepEqual(r.healedLayers, [{ id: "default", name: "Default", visible: true, locked: false }]);
      assert.deepEqual(r.healedExtensions, {});
      assert.deepEqual(r.itemLayersBefore, ["default", "default", "default", "default"]);
      assert.equal(r.cardsBefore, 4);
      assert.equal(r.createdLayer.id, "layer-1");
      assert.equal(r.setItemLayer, true);
      assert.equal(r.itemLayerAfter, "layer-1");
      assert.equal(r.setVisible, true);
      assert.equal(r.cardsHidden, 3);
      assert.equal(r.undo, true);
      assert.equal(r.visibleAfterUndo, true);
      assert.equal(r.cardsAfterUndo, 4);
      assert.equal(r.redo, true);
      assert.equal(r.visibleAfterRedo, false);
      assert.equal(r.cardsAfterRedo, 3);
      assert.deepEqual(r.extension, { frames: 2, fps: 12 });
      assert.equal(r.circularThrew, true);
      assert.deepEqual(r.extensionAfterCircular, { frames: 2, fps: 12 });
      assert.deepEqual(r.finalLayers.map((l) => l.id), ["default", "layer-1"]);
    });

    await check("extensions are namespaced per plugin", async () => {
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("layer-proof-b", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: READY_TIMEOUT_MS });
      const r = await waitFor("layer proof B result", () => page.evaluate(() => window.__layerProofB ?? null));
      assert.equal(r.seenBeforeOwnWrite, null);
      assert.deepEqual(r.ownAfterWrite, { brush: "pencil" });
      // On disk, each plugin's data sits under its own id and
      // neither clobbered the other.
      const onDisk = await waitFor("extensions on disk", () => {
        const b = JSON.parse(fs.readFileSync(boardPath, "utf8"));
        return b.extensions?.["layer-proof-a"] && b.extensions?.["layer-proof-b"] ? b : null;
      });
      assert.equal(onDisk.extensions["layer-proof-a"].frames, 2);
      assert.deepEqual(onDisk.extensions["layer-proof-a"].proof.createdLayer, { id: "layer-1", name: "Ink", visible: true, locked: false });
      assert.deepEqual(onDisk.extensions["layer-proof-b"], { brush: "pencil" });
      assert.deepEqual(onDisk.layers.map((l) => l.id), ["default", "layer-1"]);
      assert.deepEqual(onDisk.items.map((it) => it.id), [1, 2, 3, 4]);
      assert.equal(onDisk.items[0].layer, "layer-1");
    });
  } finally {
    if (app) await app.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} old-board checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
