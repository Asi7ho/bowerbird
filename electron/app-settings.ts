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
  // The main window's last geometry, restored on launch.
  // Null on a first run (or when the saved bounds no longer
  // fit any connected display, which the main process checks).
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  windowMaximised: boolean;
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
  windowBounds: null,
  windowMaximised: false,
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
  // Saved window geometry: four finite numbers, sane size.
  // Anything else (a hand-edited file, an old version) falls
  // back to no saved bounds; the main process also checks the
  // bounds still fit on a connected display before using them.
  if (p.windowBounds && typeof p.windowBounds === "object" && !Array.isArray(p.windowBounds)) {
    const b = p.windowBounds as Record<string, unknown>;
    const nums = [b.x, b.y, b.width, b.height];
    if (nums.every((n) => typeof n === "number" && Number.isFinite(n))
      && (b.width as number) >= 200 && (b.width as number) <= 10000
      && (b.height as number) >= 200 && (b.height as number) <= 10000) {
      out.windowBounds = { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number };
    }
  }
  if (typeof p.windowMaximised === "boolean") out.windowMaximised = p.windowMaximised;
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
    windowBounds: s.windowBounds,
    windowMaximised: s.windowMaximised,
  });
}
