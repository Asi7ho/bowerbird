// Opening a board-local file from a card double-click.
//
// A .psd or .ai double-click should land in an editor, not in the
// Mac's default viewer: Preview renders both formats as a flat
// image, so the card opens looking like a PNG. On macOS, try the
// format's editors first and fall back to the system default
// when none of them is installed; on other platforms, and for
// every other extension, the default is the only option, so it
// is used directly.
//
// Each editor is tried two ways. A bundle identifier (`open -b`)
// is version-proof — com.adobe.Photoshop is Photoshop whatever
// year is in its name — while a display name (`open -a`) needs
// the exact name: "Affinity Photo" does NOT match the installed
// "Affinity Photo 2", which is why the first version of this
// file silently fell through to Preview for Affinity users.
// Both forms are listed so either one can hit; a miss fails
// fast with no dialog, so a long list costs nothing. The unified
// Canva-era Affinity app is just "Affinity".
//
// The targets are a hardcoded allowlist — nothing the renderer
// sends reaches the command — and the file is already gated by
// isBoardLocal in main before this runs. execFile takes an argv
// array, so a file name with spaces or quotes cannot escape it.
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OpenTarget =
  | { via: "bundle"; id: string }
  | { via: "name"; name: string };

const bundle = (id: string): OpenTarget => ({ via: "bundle", id });
const named = (name: string): OpenTarget => ({ via: "name", name });

// Editors to try, in order. Adobe first, then Affinity newest
// to oldest (v2, v1, the unified app), then the smaller editors.
export function editorCandidates(ext: string): OpenTarget[] {
  if (ext === ".psd") {
    return [
      bundle("com.adobe.Photoshop"),
      named("Adobe Photoshop"),
      bundle("com.seriflabs.affinityphoto2"),
      named("Affinity Photo 2"),
      bundle("com.seriflabs.affinityphoto"),
      named("Affinity Photo"),
      named("Affinity"),
      bundle("com.pixelmatorteam.pixelmator"),
      named("Pixelmator Pro"),
      named("GIMP"),
    ];
  }
  if (ext === ".ai") {
    return [
      bundle("com.adobe.Illustrator"),
      named("Adobe Illustrator"),
      bundle("com.seriflabs.affinitydesigner2"),
      named("Affinity Designer 2"),
      bundle("com.seriflabs.affinitydesigner"),
      named("Affinity Designer"),
      named("Affinity"),
      named("Inkscape"),
    ];
  }
  return [];
}

export interface OpenBoardFileDeps {
  platform?: NodeJS.Platform;
  // Ask the OS to open the file with the named app or bundle.
  // Defaults to `open -b` / `open -a` on macOS; injected in tests.
  runOpen?: (target: OpenTarget, file: string) => Promise<void>;
  // Open with the system default app. main passes shell.openPath;
  // this module never imports electron, so it stays unit-testable.
  openDefault: (file: string) => Promise<string>;
}

async function defaultRunOpen(target: OpenTarget, file: string): Promise<void> {
  if (target.via === "bundle") await execFileAsync("open", ["-b", target.id, file]);
  else await execFileAsync("open", ["-a", target.name, file]);
}

export async function openBoardFile(local: string, deps: OpenBoardFileDeps): Promise<string> {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") {
    const runOpen = deps.runOpen ?? defaultRunOpen;
    for (const target of editorCandidates(path.extname(local).toLowerCase())) {
      try {
        await runOpen(target, local);
        return "";
      } catch {
        // Not installed, or it would not open the file — try
        // the next editor, and the default after the last one.
      }
    }
  }
  return deps.openDefault(local);
}
