// App settings (settings.json in userData): the persisted
// main-process state — corner, panel layout, hardware
// acceleration, shortcut overrides, current board. Pure
// parsing and serialising, so it is unit-testable without
// Electron: main.ts does the file I/O and owns the live
// values; this module only knows how to read and write them.

export interface AppSettings {
  corner: string;
  panelOrder: string[];
  panelWidth: number;
  dockVisible: boolean;
  hardwareAcceleration: boolean;
  shortcuts: Record<string, string>;
  currentBoard: string | null;
}

export const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right", "off"];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  corner: "bottom-left",
  panelOrder: [],
  panelWidth: 290,
  dockVisible: true,
  hardwareAcceleration: true,
  shortcuts: {},
  currentBoard: null,
};

export function clampPanelWidth(w: unknown): number {
  const n = typeof w === "number" && Number.isFinite(w) ? Math.round(w) : 290;
  return Math.min(600, Math.max(200, n));
}

// Shortcut overrides: an object of string action ids to
// string bindings, capped at 50 entries. Bad entries are
// dropped, never trusted; the renderer ignores unknown ids
// and bad bindings when it loads them.
export function cleanShortcuts(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") continue;
    if (Object.keys(out).length >= 50) break;
    out[k] = val.slice(0, 64);
  }
  return out;
}

// Read a parsed settings.json (or anything else) into a full
// settings object. Missing or wrong-typed fields fall back
// to the defaults — so a settings file from before hardware
// acceleration existed still loads with it on, and a
// hand-edited file with a bad value does not break the app.
export function parseAppSettings(parsed: unknown): AppSettings {
  const out: AppSettings = { ...DEFAULT_APP_SETTINGS, panelOrder: [], shortcuts: {} };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const p = parsed as Record<string, unknown>;
  if (typeof p.corner === "string" && CORNERS.includes(p.corner)) out.corner = p.corner;
  if (Array.isArray(p.panelOrder)) out.panelOrder = p.panelOrder.filter((x): x is string => typeof x === "string");
  if (typeof p.panelWidth === "number") out.panelWidth = clampPanelWidth(p.panelWidth);
  if (typeof p.dockVisible === "boolean") out.dockVisible = p.dockVisible;
  if (typeof p.hardwareAcceleration === "boolean") out.hardwareAcceleration = p.hardwareAcceleration;
  out.shortcuts = cleanShortcuts(p.shortcuts);
  if (typeof p.currentBoard === "string" && p.currentBoard && p.currentBoard !== "Main") {
    out.currentBoard = p.currentBoard.slice(0, 64);
  }
  return out;
}

export function serialiseAppSettings(s: AppSettings): string {
  return JSON.stringify({
    corner: s.corner,
    panelOrder: s.panelOrder,
    panelWidth: s.panelWidth,
    dockVisible: s.dockVisible,
    hardwareAcceleration: s.hardwareAcceleration,
    shortcuts: s.shortcuts,
    currentBoard: s.currentBoard,
  });
}
