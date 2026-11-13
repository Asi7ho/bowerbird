// The Bowerbird agent CLI: read and write boards from the shell,
// with the app closed — or open, which follows the file within
// about two seconds. Plain Node, no dependencies. JSON out, exit
// codes 0 ok, 1 usage, 2 board or card not found, 3 write failed.
// The contract is BOWERBIRD_SPEC.md; this file implements it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = { OK: 0, USAGE: 1, NOT_FOUND: 2, WRITE_FAILED: 3 };

export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- paths
//
// Mirrors the app's resolution (electron/main.ts): env overrides,
// then XDG_DATA_HOME or ~/.local/share, bowerbird folder unless
// only the old quickboard folder has a board.json.

export function sanitise(name) {
  let out = String(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (out.length > 64) out = out.slice(0, 64);
  return out || "file";
}

export function userDataDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.join(env.HOME || os.homedir(), ".config");
  return path.join(base, "bowerbird");
}

export function resolveBaseDir(env = process.env) {
  const base = env.XDG_DATA_HOME ? env.XDG_DATA_HOME : path.join(env.HOME || os.homedir(), ".local", "share");
  const next = path.join(base, "bowerbird");
  const old = path.join(base, "quickboard");
  if (fs.existsSync(path.join(next, "board.json"))) return next;
  if (fs.existsSync(path.join(old, "board.json"))) return old;
  return next;
}

export function resolveBoardFile(name, env = process.env) {
  // An env override names the Main board file outright; board
  // switching is disabled while one is set, as in the app.
  const override = env.BOWERBIRD_BOARD_PATH || env.QB_BOARD_PATH;
  if (override) return { file: override, name: "Main", base: path.dirname(override) };
  const base = resolveBaseDir(env);
  if (!name || name === "Main") return { file: path.join(base, "board.json"), name: "Main", base };
  const folder = path.join(base, "boards", sanitise(name));
  return { file: path.join(folder, "board.json"), name, base };
}

export function currentBoardName(env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir(env), "settings.json"), "utf8"));
    if (parsed && typeof parsed.currentBoard === "string" && parsed.currentBoard) return parsed.currentBoard;
  } catch { /* no settings yet: Main */ }
  return "Main";
}

// ---------------------------------------------------------------- boards

function boardDisplayName(folder) {
  try {
    const name = fs.readFileSync(path.join(folder, "display-name.txt"), "utf8").trim();
    if (name) return name;
  } catch { /* fall back to the folder name */ }
  return path.basename(folder);
}

function boardItemCount(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed.items) ? parsed.items.length : 0;
  } catch { return 0; }
}

export function listBoards(env = process.env) {
  const base = resolveBaseDir(env);
  const current = currentBoardName(env);
  const out = [{ name: "Main", current: current === "Main", items: boardItemCount(path.join(base, "board.json")) }];
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(base, "boards"), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { entries = []; }
  for (const folder of entries) {
    const folderPath = path.join(base, "boards", folder);
    const name = boardDisplayName(folderPath);
    out.push({ name, current: current === name, items: boardItemCount(path.join(folderPath, "board.json")) });
  }
  return out;
}

export function readBoard(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new CliError(EXIT.WRITE_FAILED, `could not read board: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.items)) throw new CliError(EXIT.WRITE_FAILED, "board.json has no items array");
  return parsed;
}

function kindKey(item) {
  return Object.keys(item.kind || {})[0] || "Unknown";
}

export function cardTitle(item) {
  const key = kindKey(item);
  const k = item.kind?.[key] || {};
  switch (key) {
    case "Text": {
      const first = String(k.text || "").split("\n").find((l) => l.trim() !== "") || "";
      return first.length > 80 ? `${first.slice(0, 80)}…` : first;
    }
    case "Image":
    case "PdfCard":
    case "Audio": return path.basename(String(k.path || ""));
    case "UrlCard": return k.title || k.url || "";
    case "Video": return path.basename(String(k.source || ""));
    case "Swatch": return String(k.hex || "");
    case "Shape": return String(k.shape || "");
    case "Stroke": return `Stroke (${(k.points || []).length} points)`;
    case "Connector": return "Connector";
    case "Plugin": return `${k.plugin || "?"}:${k.kind || "?"}`;
    default: return "";
  }
}

export function listCards(board) {
  return (board.items || []).map((it) => ({
    id: it.id,
    kind: kindKey(it),
    title: cardTitle(it),
    x: it.pos?.x, y: it.pos?.y, w: it.size?.w, h: it.size?.h,
    group: it.group ?? null,
  }));
}

function estimateTextHeight(text, w) {
  // Rough: ~36 characters per line at size 16 in a 320-wide
  // note, 24px a line, 44px of chrome. The user resizes
  // in-app; this only has to land close.
  const perLine = Math.max(10, Math.floor((w - 32) / 8));
  let lines = 0;
  for (const para of String(text).split("\n")) lines += Math.max(1, Math.ceil(para.length / perLine));
  return Math.max(80, 44 + lines * 24);
}

export function addTextCard(board, { text, x, y, w, h }) {
  // next_id is the last issued id, not the next free one: the
  // app allocates by bumping first. Take the max of next_id
  // and the highest id on the board, so a board whose next_id
  // lags behind still gets a fresh id, never a collision.
  const items = board.items || [];
  const highest = items.reduce((m, it) => Math.max(m, it.id || 0), 0);
  const id = Math.max(board.next_id ?? 0, highest) + 1;
  const width = w ?? 320;
  const height = h ?? estimateTextHeight(text, width);
  const pos = { x: x ?? 100, y: y ?? 100 };
  if (x === undefined || y === undefined) {
    // No position given: sit to the right of the existing
    // content, or at 100,100 on an empty board.
    if (items.length > 0) {
      const maxX = Math.max(...items.map((it) => (it.pos?.x ?? 0) + (it.size?.w ?? 0)));
      const minY = Math.min(...items.map((it) => it.pos?.y ?? 0));
      pos.x = maxX + 40;
      pos.y = minY;
    }
  }
  const item = {
    id,
    pos,
    size: { w: width, h: height },
    group: null,
    kind: { Text: { text, bold: false, size: 16, color: "#1A1A1A" } },
  };
  board.items = [...items, item];
  board.next_id = id;
  return item;
}

// A write goes through a temporary file plus rename, so a
// crash never leaves a torn board.json behind.
export function writeBoard(file, board) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(board));
    fs.renameSync(tmp, file);
  } catch (e) {
    throw new CliError(EXIT.WRITE_FAILED, `could not write board: ${e.message}`);
  }
}

// ---------------------------------------------------------------- CLI

const USAGE = `bowerbird — read and write Bowerbird boards from the shell.

Usage:
  bowerbird boards
  bowerbird cards [--board NAME]
  bowerbird add-card --board NAME --text "..." [--x N] [--y N] [--w N] [--h N] [--dry-run]

Options:
  --board NAME   Board to work on (default: the current board, else Main)
  --dry-run      Print what would be written; write nothing
  --human        Readable lines instead of JSON
  --json         JSON output (the default)

Exit codes: 0 ok, 1 usage error, 2 board or card not found, 3 write failed.`;

function parseArgs(argv) {
  const opts = { board: undefined, text: undefined, x: undefined, y: undefined, w: undefined, h: undefined, dryRun: false, human: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const takeValue = (flag) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new CliError(EXIT.USAGE, `${flag} needs a value`);
      i += 1;
      return v;
    };
    const takeNumber = (flag) => {
      const v = Number(takeValue(flag));
      if (!Number.isFinite(v)) throw new CliError(EXIT.USAGE, `${flag} needs a number`);
      return v;
    };
    if (a === "--board") opts.board = takeValue(a);
    else if (a === "--text") opts.text = takeValue(a);
    else if (a === "--x") opts.x = takeNumber(a);
    else if (a === "--y") opts.y = takeNumber(a);
    else if (a === "--w") opts.w = takeNumber(a);
    else if (a === "--h") opts.h = takeNumber(a);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--human") opts.human = true;
    else if (a === "--json") opts.human = false;
    else if (a === "--help" || a === "-h") return { help: true };
    else if (a.startsWith("--")) throw new CliError(EXIT.USAGE, `unknown option: ${a}`);
    else positional.push(a);
  }
  return { ...opts, positional };
}

function humanBoards(boards) {
  return boards.map((b) => `${b.name}${b.current ? " (current)" : ""} — ${b.items} item${b.items === 1 ? "" : "s"}`).join("\n");
}

function humanCards(boardName, cards) {
  if (cards.length === 0) return `No cards on ${boardName}.`;
  return cards.map((c) => `#${c.id} ${c.kind} "${c.title}" at ${c.x},${c.y} ${c.w}×${c.h}`).join("\n");
}

export function run(argv, env = process.env, stdout = process.stdout, stderr = process.stderr) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    stderr.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
    return e instanceof CliError ? e.code : EXIT.USAGE;
  }
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }
  const [cmd] = parsed.positional;
  if (!cmd || parsed.positional.length > 1) {
    stderr.write(`${JSON.stringify({ ok: false, error: cmd ? `unknown command: ${cmd}` : "no command given — try: boards, cards, add-card" })}\n`);
    return EXIT.USAGE;
  }
  const out = (obj) => {
    if (parsed.human) return;
    stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  };
  try {
    if (cmd === "boards") {
      const boards = listBoards(env);
      if (parsed.human) stdout.write(`${humanBoards(boards)}\n`);
      else out({ ok: true, boards });
      return EXIT.OK;
    }
    if (cmd === "cards") {
      const { file, name } = resolveBoardFile(parsed.board ?? currentBoardName(env), env);
      const board = readBoard(file);
      if (board === null && parsed.board && parsed.board !== "Main") throw new CliError(EXIT.NOT_FOUND, `no board named ${parsed.board}`);
      const cards = listCards(board ?? { items: [] });
      if (parsed.human) stdout.write(`${humanCards(name, cards)}\n`);
      else out({ ok: true, board: name, cards });
      return EXIT.OK;
    }
    if (cmd === "add-card") {
      if (parsed.text === undefined) throw new CliError(EXIT.USAGE, "add-card needs --text");
      const { file, name } = resolveBoardFile(parsed.board ?? currentBoardName(env), env);
      const board = readBoard(file);
      if (board === null && parsed.board && parsed.board !== "Main") throw new CliError(EXIT.NOT_FOUND, `no board named ${parsed.board}`);
      const working = board ?? { items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 1, next_group: 1, bg: "#FFFFFF", grid: "Dots" };
      const item = addTextCard(working, { text: parsed.text, x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h });
      if (parsed.dryRun) {
        if (parsed.human) stdout.write(`Would add card ${item.id} to ${name} at ${item.pos.x},${item.pos.y} (dry run — nothing written).\n`);
        else out({ ok: true, dryRun: true, board: name, item });
        return EXIT.OK;
      }
      writeBoard(file, working);
      if (parsed.human) stdout.write(`Added card ${item.id} to ${name}.\n`);
      else out({ ok: true, board: name, item });
      return EXIT.OK;
    }
    throw new CliError(EXIT.USAGE, `unknown command: ${cmd}`);
  } catch (e) {
    if (e instanceof CliError) {
      stderr.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
      return e.code;
    }
    stderr.write(`${JSON.stringify({ ok: false, error: String(e) })}\n`);
    return EXIT.WRITE_FAILED;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = run(process.argv.slice(2));
}
