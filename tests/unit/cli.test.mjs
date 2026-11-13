import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sanitise,
  resolveBaseDir,
  resolveBoardFile,
  listBoards,
  listCards,
  addTextCard,
  writeBoard,
  readBoard,
  run,
  EXIT,
} from "../../cli/bowerbird.mjs";

function makeEnv() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cli-data-"));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "bb-cli-config-"));
  return { env: { XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, HOME: data }, data, config };
}

function collect() {
  const chunks = [];
  return { stream: { write: (s) => { chunks.push(s); } }, chunks };
}

describe("sanitise", () => {
  it("replaces unsafe characters and truncates", () => {
    expect(sanitise("My Board!")).toBe("My_Board_");
    expect(sanitise("...x")).toBe("x");
    expect(sanitise("a".repeat(100))).toBe("a".repeat(64));
    expect(sanitise("")).toBe("file");
  });
});

describe("resolveBaseDir", () => {
  it("prefers the bowerbird folder when it has a board", () => {
    const { env, data } = makeEnv();
    fs.mkdirSync(path.join(data, "bowerbird"), { recursive: true });
    fs.writeFileSync(path.join(data, "bowerbird", "board.json"), "{}");
    expect(resolveBaseDir(env)).toBe(path.join(data, "bowerbird"));
  });
  it("falls back to the old quickboard folder", () => {
    const { env, data } = makeEnv();
    fs.mkdirSync(path.join(data, "quickboard"), { recursive: true });
    fs.writeFileSync(path.join(data, "quickboard", "board.json"), "{}");
    expect(resolveBaseDir(env)).toBe(path.join(data, "quickboard"));
  });
  it("defaults to the bowerbird folder when neither exists", () => {
    const { env, data } = makeEnv();
    expect(resolveBaseDir(env)).toBe(path.join(data, "bowerbird"));
  });
});

describe("boards and cards", () => {
  let env;
  let data;
  beforeEach(() => {
    ({ env, data } = makeEnv());
    const base = path.join(data, "bowerbird");
    fs.mkdirSync(path.join(base, "boards", "Research"), { recursive: true });
    fs.writeFileSync(path.join(base, "boards", "Research", "display-name.txt"), "Research");
    writeBoard(path.join(base, "board.json"), {
      items: [
        { id: 1, pos: { x: 10, y: 20 }, size: { w: 320, h: 100 }, group: null, kind: { Text: { text: "Hello\nworld", bold: false, size: 16, color: "#1A1A1A" } } },
        { id: 2, pos: { x: 400, y: 20 }, size: { w: 200, h: 120 }, group: null, kind: { Image: { path: "/tmp/x/photo.png" } } },
        { id: 3, pos: { x: 10, y: 200 }, size: { w: 200, h: 100 }, group: null, kind: { UrlCard: { url: "https://example.com", title: "Example", description: null } } },
      ],
      camera: { x: 0, y: 0, zoom: 1 }, next_id: 4, next_group: 1, bg: "#FFFFFF", grid: "Dots",
    });
    writeBoard(path.join(base, "boards", "Research", "board.json"), {
      items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 1, next_group: 1, bg: "#FFFFFF", grid: "Dots",
    });
  });
  afterEach(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("lists Main and named boards with counts", () => {
    const boards = listBoards(env);
    expect(boards).toEqual([
      { name: "Main", current: true, items: 3 },
      { name: "Research", current: false, items: 0 },
    ]);
  });

  it("lists cards with titles", () => {
    const board = readBoard(resolveBoardFile("Main", env).file);
    expect(listCards(board)).toEqual([
      { id: 1, kind: "Text", title: "Hello", x: 10, y: 20, w: 320, h: 100, group: null },
      { id: 2, kind: "Image", title: "photo.png", x: 400, y: 20, w: 200, h: 120, group: null },
      { id: 3, kind: "UrlCard", title: "Example", x: 10, y: 200, w: 200, h: 100, group: null },
    ]);
  });

  it("addTextCard takes the next free id and sits right of the content", () => {
    const board = readBoard(resolveBoardFile("Main", env).file);
    const item = addTextCard(board, { text: "New note", x: undefined, y: undefined, w: undefined, h: undefined });
    expect(item.id).toBe(5); // next_id 4 is the last issued id, not the next free one
    expect(board.next_id).toBe(5);
    expect(item.pos.x).toBe(640); // right of the image card (400 + 200 + 40)
    expect(item.kind).toEqual({ Text: { text: "New note", bold: false, size: 16, color: "#1A1A1A" } });
  });

  it("addTextCard never collides when next_id lags behind the highest id", () => {
    // The welcome board's shape: ids 1..3 with next_id 2.
    const board = { items: [
      { id: 1, pos: { x: 0, y: 0 }, size: { w: 10, h: 10 }, group: null, kind: { Text: { text: "a", bold: false, size: 16, color: "#1A1A1A" } } },
      { id: 2, pos: { x: 0, y: 0 }, size: { w: 10, h: 10 }, group: null, kind: { Text: { text: "b", bold: false, size: 16, color: "#1A1A1A" } } },
      { id: 3, pos: { x: 0, y: 0 }, size: { w: 10, h: 10 }, group: null, kind: { Text: { text: "c", bold: false, size: 16, color: "#1A1A1A" } } },
    ], camera: { x: 0, y: 0, zoom: 1 }, next_id: 2, next_group: 1, bg: "#FFFFFF", grid: "Dots" };
    const item = addTextCard(board, { text: "New", x: 10, y: 10, w: 320, h: 80 });
    expect(item.id).toBe(4);
    expect(board.next_id).toBe(4);
  });

  it("addTextCard on an empty board lands at 100,100", () => {
    const board = readBoard(resolveBoardFile("Research", env).file);
    const item = addTextCard(board, { text: "First", x: undefined, y: undefined, w: undefined, h: undefined });
    expect(item.pos).toEqual({ x: 100, y: 100 });
  });

  it("writeBoard round-trips and leaves no temp file", () => {
    const file = resolveBoardFile("Research", env).file;
    const board = readBoard(file);
    addTextCard(board, { text: "Saved", x: 10, y: 10, w: 320, h: 80 });
    writeBoard(file, board);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(readBoard(file).items.length).toBe(1);
  });
});

describe("run()", () => {
  let env;
  let data;
  beforeEach(() => {
    ({ env, data } = makeEnv());
    const base = path.join(data, "bowerbird");
    fs.mkdirSync(base, { recursive: true });
    writeBoard(path.join(base, "board.json"), {
      items: [{ id: 1, pos: { x: 0, y: 0 }, size: { w: 320, h: 80 }, group: null, kind: { Text: { text: "Hi", bold: false, size: 16, color: "#1A1A1A" } } }],
      camera: { x: 0, y: 0, zoom: 1 }, next_id: 2, next_group: 1, bg: "#FFFFFF", grid: "Dots",
    });
  });
  afterEach(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("boards prints JSON and exits 0", () => {
    const out = collect();
    const err = collect();
    expect(run(["boards"], env, out.stream, err.stream)).toBe(EXIT.OK);
    const parsed = JSON.parse(out.chunks.join(""));
    expect(parsed.boards).toEqual([{ name: "Main", current: true, items: 1 }]);
  });

  it("cards on a missing board exits 2", () => {
    const out = collect();
    const err = collect();
    expect(run(["cards", "--board", "Nope"], env, out.stream, err.stream)).toBe(EXIT.NOT_FOUND);
    expect(JSON.parse(err.chunks.join("")).ok).toBe(false);
  });

  it("add-card --dry-run writes nothing", () => {
    const out = collect();
    const err = collect();
    const file = path.join(data, "bowerbird", "board.json");
    const before = fs.readFileSync(file, "utf8");
    expect(run(["add-card", "--text", "Dry", "--dry-run"], env, out.stream, err.stream)).toBe(EXIT.OK);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(out.chunks.join("")).dryRun).toBe(true);
  });

  it("add-card writes and bumps next_id", () => {
    const out = collect();
    const err = collect();
    expect(run(["add-card", "--text", "Real", "--x", "5", "--y", "6"], env, out.stream, err.stream)).toBe(EXIT.OK);
    const board = readBoard(path.join(data, "bowerbird", "board.json"));
    expect(board.items.length).toBe(2);
    expect(board.items[1].id).toBe(3);
    expect(board.next_id).toBe(3);
    expect(board.items[1].pos).toEqual({ x: 5, y: 6 });
  });

  it("unknown command exits 1", () => {
    const out = collect();
    const err = collect();
    expect(run(["explode"], env, out.stream, err.stream)).toBe(EXIT.USAGE);
  });

  it("--help exits 0", () => {
    const out = collect();
    const err = collect();
    expect(run(["--help"], env, out.stream, err.stream)).toBe(EXIT.OK);
    expect(out.chunks.join("")).toContain("boards");
  });
});
