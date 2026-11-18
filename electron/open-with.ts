// Opening a board-local file from a card double-click.
//
// A .psd or .ai double-click should land in an editor, not in the
// Mac's default viewer: Preview renders both formats as a flat
// image, so the card opens looking like a PNG. On macOS, try the
// format's editors first with `open -a` and fall back to the
// system default when none of them is installed; on other
// platforms, and for every other extension, the default is the
// only option, so it is used directly.
//
// The app names are a hardcoded allowlist — nothing the renderer
// sends reaches the command — and the file is already gated by
// isBoardLocal in main before this runs. execFile takes an argv
// array, so a file name with spaces or quotes cannot escape it.
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Editors to try, in order. "Adobe Photoshop" also matches a
// versioned install ("Adobe Photoshop 2025") through Launch
// Services; the bare product name covers an install renamed
// without the vendor prefix.
export function editorCandidates(ext: string): string[] {
  if (ext === ".psd") return ["Adobe Photoshop", "Photoshop", "Affinity Photo", "Pixelmator Pro", "GIMP"];
  if (ext === ".ai") return ["Adobe Illustrator", "Illustrator", "Affinity Designer", "Inkscape"];
  return [];
}

export interface OpenBoardFileDeps {
  platform?: NodeJS.Platform;
  // Ask the OS to open the file with the named app. Defaults to
  // `open -a` on macOS; injected in tests.
  runOpen?: (app: string, file: string) => Promise<void>;
  // Open with the system default app. main passes shell.openPath;
  // this module never imports electron, so it stays unit-testable.
  openDefault: (file: string) => Promise<string>;
}

async function defaultRunOpen(app: string, file: string): Promise<void> {
  await execFileAsync("open", ["-a", app, file]);
}

export async function openBoardFile(local: string, deps: OpenBoardFileDeps): Promise<string> {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") {
    const runOpen = deps.runOpen ?? defaultRunOpen;
    for (const app of editorCandidates(path.extname(local).toLowerCase())) {
      try {
        await runOpen(app, local);
        return "";
      } catch {
        // Not installed, or it would not open the file — try
        // the next editor, and the default after the last one.
      }
    }
  }
  return deps.openDefault(local);
}
