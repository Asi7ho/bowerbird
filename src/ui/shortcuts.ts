// Shortcut registry: every rebindable board action, its default
// key, and the saved overrides. Board keys come from here, not
// from hardcoded checks in board-input, so Settings can rebind
// them and the board follows. Escape, Tab, Space and the arrow
// keys are not here: they are focus and navigation, not actions.
// The command palette (Ctrl+K) is not here either: the core
// palette listens for it itself in the capture phase.

export type ShortcutId =
  | "select" | "pen" | "connector" | "shape" | "eraser"
  | "undo" | "redo" | "group" | "ungroup" | "delete"
  | "zoom-in" | "zoom-out" | "reset-view" | "zoom-fit"
  | "rotate-left" | "rotate-right"
  | "open-settings" | "toggle-panels" | "focus-toolbar" | "search"
  | "create-edit";

interface ShortcutAction {
  id: ShortcutId;
  label: string;
  defaultBinding: string;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "select", label: "Select tool", defaultBinding: "v" },
  { id: "pen", label: "Pen tool", defaultBinding: "p" },
  { id: "connector", label: "Connector tool", defaultBinding: "a" },
  { id: "shape", label: "Shape tool", defaultBinding: "r" },
  { id: "eraser", label: "Eraser tool", defaultBinding: "x" },
  { id: "undo", label: "Undo", defaultBinding: "ctrl+z" },
  { id: "redo", label: "Redo", defaultBinding: "ctrl+shift+z" },
  { id: "group", label: "Group the selection", defaultBinding: "ctrl+g" },
  { id: "ungroup", label: "Ungroup the selection", defaultBinding: "ctrl+u" },
  { id: "delete", label: "Delete the selection", defaultBinding: "delete" },
  { id: "zoom-in", label: "Zoom in", defaultBinding: "+" },
  { id: "zoom-out", label: "Zoom out", defaultBinding: "-" },
  { id: "reset-view", label: "Reset the view", defaultBinding: "0" },
  { id: "zoom-fit", label: "Zoom to fit", defaultBinding: "f" },
  { id: "rotate-left", label: "Rotate the selection −15°", defaultBinding: "[" },
  { id: "rotate-right", label: "Rotate the selection +15°", defaultBinding: "]" },
  { id: "open-settings", label: "Open settings", defaultBinding: "ctrl+," },
  { id: "toggle-panels", label: "Show or hide plugin panels", defaultBinding: "ctrl+b" },
  { id: "focus-toolbar", label: "Focus the toolbar", defaultBinding: "ctrl+t" },
  { id: "search", label: "Search the board", defaultBinding: "ctrl+f" },
  { id: "create-edit", label: "New note, edit the selected note, or rename the selected group", defaultBinding: "enter" },
];

const DEFAULTS: Record<string, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((a) => [a.id, a.defaultBinding]),
);

// A binding is a lowercase key plus modifiers, joined by "+":
// "v", "ctrl+z", "ctrl+shift+z", "[", "delete", "enter".
// Modifiers are stored in the order ctrl, alt, shift, then
// the key. Ctrl covers Cmd as well: on the Mac the Command
// key is the Ctrl key for shortcuts.
interface ParsedBinding {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const MODIFIERS = new Set(["ctrl", "alt", "shift", "meta", "cmd", "command"]);

// Symbols that are only typed with Shift held (on a US layout):
// the Shift is part of the character, not a separate modifier,
// so a binding for one must not also demand Shift.
const SHIFTED_SYMBOLS = new Set("~!@#$%^&*()_+{}|:\"<>?".split(""));

function parseBinding(s: string): ParsedBinding | null {
  const lower = s.toLowerCase().trim();
  if (lower === "") return null;
  let key: string;
  let modPart: string;
  if (lower === "+") {
    key = "+";
    modPart = "";
  } else if (lower.endsWith("+")) {
    // The key is "+" itself (e.g. "ctrl++").
    key = "+";
    modPart = lower.slice(0, -1);
  } else {
    const parts = lower.split("+");
    key = parts[parts.length - 1];
    modPart = parts.slice(0, -1).join("+");
  }
  if (key === "" || MODIFIERS.has(key)) return null;
  const mods = modPart.split("+").map((p) => p.trim()).filter(Boolean);
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const m of mods) {
    if (m === "ctrl" || m === "meta" || m === "cmd" || m === "command") ctrl = true;
    else if (m === "alt") alt = true;
    else if (m === "shift") shift = true;
    else return null;
  }
  return { key, ctrl, alt, shift };
}

export function normalizeBinding(s: string): string | null {
  const b = parseBinding(s);
  if (!b) return null;
  const parts: string[] = [];
  if (b.ctrl) parts.push("ctrl");
  if (b.alt) parts.push("alt");
  if (b.shift) parts.push("shift");
  parts.push(b.key);
  return parts.join("+");
}

// Does this key press fire the given binding? A binding key
// "+" also matches "=" (Shift+= types "+"), and "delete" also
// matches "backspace": the board has always treated those
// pairs as the same key.
function matchesEvent(e: KeyboardEvent, binding: string): boolean {
  const b = parseBinding(binding);
  if (!b) return false;
  const key = e.key.toLowerCase();
  const keyOk = key === b.key
    || (b.key === "+" && (key === "+" || key === "="))
    || (b.key === "delete" && (key === "delete" || key === "backspace"));
  if (!keyOk) return false;
  if ((e.ctrlKey || e.metaKey) !== b.ctrl) return false;
  if (e.altKey !== b.alt) return false;
  // Shift is part of the character for a shifted symbol ("+"
  // is Shift+=), so it is not compared there; for every other
  // key it must match exactly, which is what keeps Ctrl+Z
  // (undo) apart from Ctrl+Shift+Z (redo).
  if (!SHIFTED_SYMBOLS.has(b.key) && e.shiftKey !== b.shift) return false;
  return true;
}

// Build a binding string from a key press, for capture mode.
// Pure modifier presses return null (nothing to bind). Shift
// is not recorded for a bare letter (it is just casing: "v",
// not "shift+v") nor for a shifted symbol ("+" is Shift+=
// already); with Ctrl or Alt held it is a real modifier
// (Ctrl+Z vs Ctrl+Shift+Z), and for a named key (Delete,
// Enter) it is recorded too.
export function bindingFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return null;
  const lower = key.toLowerCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  const isLetter = lower.length === 1 && lower >= "a" && lower <= "z";
  const isShiftedSymbol = lower.length === 1 && SHIFTED_SYMBOLS.has(lower);
  if (e.shiftKey && !isShiftedSymbol) {
    if (!isLetter || e.ctrlKey || e.metaKey || e.altKey) parts.push("shift");
  }
  parts.push(lower);
  return parts.join("+");
}

// The overrides: only actions that differ from their default.
// Loaded once at startup from app settings, saved back when
// a binding changes in Settings.
let overrides: Record<string, string> = {};

export function loadOverrides(o: Record<string, string> | undefined | null): void {
  overrides = {};
  if (!o) return;
  for (const [id, raw] of Object.entries(o)) {
    if (!(id in DEFAULTS)) continue;
    const b = normalizeBinding(raw);
    if (b) overrides[id] = b;
  }
}

export function binding(id: ShortcutId): string {
  return overrides[id] ?? DEFAULTS[id];
}

export function allOverrides(): Record<string, string> {
  return { ...overrides };
}

export function set(id: ShortcutId, raw: string): boolean {
  const b = normalizeBinding(raw);
  if (!b) return false;
  if (b === DEFAULTS[id]) delete overrides[id];
  else overrides[id] = b;
  return true;
}

export function reset(id: ShortcutId): void {
  delete overrides[id];
}

export function resetAll(): void {
  overrides = {};
}

export function matches(e: KeyboardEvent, id: ShortcutId): boolean {
  return matchesEvent(e, binding(id));
}

// Show a binding the way the old table did: "Ctrl / Cmd + Z",
// "Delete / Backspace", "+ / =", "V".
export function displayBinding(b: string): string {
  const parsed = parseBinding(b);
  if (!parsed) return b;
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl / Cmd");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  let key = parsed.key;
  if (key === "+") key = "+ / =";
  else if (key === "delete") key = "Delete / Backspace";
  else if (key === " ") key = "Space";
  else key = key.toUpperCase();
  parts.push(key);
  return parts.join(" + ");
}
