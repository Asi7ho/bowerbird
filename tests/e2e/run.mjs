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

const API_TEST_PLUGIN_MANIFEST = {
  id: "api-test-plugin",
  name: "API Test Plugin",
  version: "0.1.0",
  apiVersion: "2",
  description: "Test plugin for the e2e suite: exercises the tags and checklist APIs on a card of its own.",
  permissions: ["board:write"],
  main: "main.ts",
};

// Exercises the new APIs on a card it creates, and leaves
// the results on the window for the suite to read. The
// plugin is off by default and only the final check enables
// it, so its card cannot disturb the earlier checks.
const API_TEST_PLUGIN_MAIN = `
export function activate(api) {
  const id = api.board.addItem(
    { Text: { text: "API card\\n- [ ] one\\n- [ ] two", bold: false, size: 16, color: "#1A1A1A" } },
    { x: 900, y: 400 }, { w: 320, h: 120 },
  );
  const before = api.cards.getChecklistProgress(api.board.getItem(id));
  api.cards.setChecklistProgress(id, 1);
  const after = api.cards.getChecklistProgress(api.board.getItem(id));
  api.tags.add(id, "api");
  api.tags.add(id, "api");
  window.__apiTest = { id, before, after, tags: api.tags.get(id), all: api.tags.list() };
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
  const apiTestPluginDir = path.join(pluginsDir, "api-test-plugin");
  fs.mkdirSync(apiTestPluginDir, { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify(EMPTY_BOARD));
  fs.writeFileSync(path.join(testPluginDir, "manifest.json"), JSON.stringify(TEST_PLUGIN_MANIFEST, null, 2));
  fs.writeFileSync(path.join(testPluginDir, "main.ts"), TEST_PLUGIN_MAIN);
  fs.writeFileSync(path.join(apiTestPluginDir, "manifest.json"), JSON.stringify(API_TEST_PLUGIN_MANIFEST, null, 2));
  fs.writeFileSync(path.join(apiTestPluginDir, "main.ts"), API_TEST_PLUGIN_MAIN);

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
      // The union of the two cards is (100,100)-(860,600); the
      // frame sits 24px outside it, at client y + 48.
      assert.equal(Math.round(frame.box.x), 76);
      assert.equal(Math.round(frame.box.y), 124);
      assert.equal(Math.round(frame.box.width), 808);
      assert.equal(Math.round(frame.box.height), 550);
      assert.equal(await page.locator(".group-frame .group-label").first().textContent(), "Section 1");
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
      await page.locator("input.group-rename").waitFor({ timeout: 10000 });
      await page.keyboard.type("Reading");
      await page.keyboard.press("Enter");
      await waitFor("renamed label in the DOM", async () => {
        const t = await page.locator(".group-frame .group-label").first().textContent();
        return t === "Reading" ? true : null;
      });
      await waitFor("renamed label on disk", () => readBoard().groups?.[1]?.label === "Reading");
      // Drag one card 100px right: it is in a group, so the
      // whole group moves and the frame follows it.
      await page.mouse.move(730, 624);
      await page.mouse.down();
      await page.mouse.move(830, 624, { steps: 10 });
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
      board.items.push({ id: board.next_id, pos: { x: 900, y: 100 }, size: { w: 320, h: 80 }, group: null, kind: { Text: { text: "From the outside", bold: false, size: 16, color: "#1A1A1A" } } });
      board.next_id += 1;
      const tmp = `${boardPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(board));
      fs.renameSync(tmp, boardPath);
      await page.locator("text=From the outside").first().waitFor({ timeout: 15000 });
      // And the app must not clobber the outside edit with its own
      // next save: the card is still on disk a second later.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(textCards().some((it) => it.kind.Text.text === "From the outside"), true);
    });
    await check("tags and checklist progress show inside cards", async () => {
      // Tags is a core plugin and the checklist progress is
      // core rendering: both on by default, no enabling
      // needed — the reload below proves they survive a fresh
      // load.
      await page.reload();
      await page.waitForSelector("#board", { timeout: 15000 });
      // Select the Hello CI! note by clicking it at its
      // on-screen centre: a synthetic click does not select
      // board cards, and the note is on screen after F
      // (zoom to fit) whatever the camera was doing. The
      // Library panel used to jump here, but it lives in
      // its own PR, not this one.
      const hello = readBoard().items.find((it) => "Text" in it.kind && it.kind.Text.text === "Hello CI!");
      const centre = await page.evaluate((id) => {
        const el = document.querySelector(`#cards .card[data-id="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, hello.id);
      assert.ok(centre, "Hello note on screen");
      await page.mouse.click(centre.x, centre.y);
      await page.locator("#cards .card.selected", { hasText: "Hello CI!" }).waitFor({ timeout: 10000 });
      // Tag it from the card itself: the "+ tag" button at
      // the card's bottom edge opens an input in the same
      // spot; Enter commits the tag.
      const helloId = String(hello.id);
      await page.locator(`.card-decorations[data-for="${helloId}"] .tag-add`).click();
      await page.locator(`.card-decorations[data-for="${helloId}"] .tag-add-input`).fill("urgent");
      await page.keyboard.press("Enter");
      await waitFor("tag shows inside the card", async () => {
        const text = await page.locator(`.card-decorations[data-for="${helloId}"]`).first().textContent().catch(() => "");
        return (text ?? "").includes("#urgent");
      });
      // Tags sit at the bottom left of the card, as a pill:
      // the pill's left edge is near the card's, and it ends
      // well inside the card's right edge. (The row div spans
      // the card, so the pill itself is what is measured.)
      const tagBox = await page.evaluate((cid) => {
        const card = document.querySelector(`#cards .card[data-id="${cid}"]`);
        const pill = document.querySelector(`.card-decorations[data-for="${cid}"] .card-tag`);
        if (!card || !pill) return null;
        const c = card.getBoundingClientRect();
        const d = pill.getBoundingClientRect();
        return { cardLeft: c.left, cardRight: c.right, cardBottom: c.bottom, decLeft: d.left, decRight: d.right, decBottom: d.bottom, isPill: getComputedStyle(pill).borderRadius === "999px" };
      }, helloId);
      assert.ok(tagBox, "tag decoration found");
      assert.ok(tagBox.decLeft - tagBox.cardLeft < 16, "tag pill at the card's left edge");
      assert.ok(tagBox.decRight < tagBox.cardRight - 40, "tag pill ends inside the card");
      assert.ok(tagBox.decBottom <= tagBox.cardBottom && tagBox.cardBottom - tagBox.decBottom < 24, "tag pill inside the card's bottom edge");
      assert.ok(tagBox.isPill, "tag renders as a pill");
      // A checklist note, written from outside like the agent
      // CLI would: the live-follow watcher reloads it.
      const board = readBoard();
      const id = Math.max(board.next_id, ...board.items.map((it) => it.id)) + 1;
      board.items.push({ id, pos: { x: 900, y: 300 }, size: { w: 320, h: 120 }, group: null, kind: { Text: { text: "Checklist card\n- [ ] first\n- [x] second", bold: false, size: 16, color: "#1A1A1A" } } });
      board.next_id = id;
      const tmp = `${boardPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(board));
      fs.renameSync(tmp, boardPath);
      await page.locator("text=Checklist card").first().waitFor({ timeout: 15000 });
      await waitFor("checklist progress shows inside the card", async () => {
        // Progress is the right-hand decoration: the left
        // div now exists even on a tag-less card (it holds
        // the "+ tag" button), so .first() would read it.
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
    });

    await check("the tags and checklist APIs work from a plugin", async () => {
      // The API test plugin is off by default and only this
      // check enables it, so its card cannot disturb the
      // earlier checks.
      assert.equal(await page.evaluate(() => window.bowerbird.setPluginEnabled("api-test-plugin", true)), true);
      await page.reload();
      await page.waitForSelector("#board", { timeout: 15000 });
      const result = await waitFor("API test result on the page", () => page.evaluate(() => window.__apiTest ?? null));
      assert.equal(result.before.done, 0);
      assert.equal(result.before.total, 2);
      assert.equal(result.after.done, 1);
      assert.equal(result.after.total, 2);
      assert.deepEqual(result.tags, ["api"]);
      assert.ok(result.all.includes("api"));
      // The writes landed on disk: the tag is on the card
      // and the first task line is checked.
      const card = readBoard().items.find((it) => it.id === result.id);
      assert.deepEqual(card.tags, ["api"]);
      assert.ok(card.kind.Text.text.includes("- [x] one"));
      assert.ok(card.kind.Text.text.includes("- [ ] two"));
      // And the core's rendered progress agrees with the API.
      await waitFor("API card progress on the card", async () => {
        const text = await page.locator(`.card-decorations-right[data-for="${result.id}"]`).first().textContent().catch(() => "");
        return (text ?? "").includes("1/2") ? true : null;
      });
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
