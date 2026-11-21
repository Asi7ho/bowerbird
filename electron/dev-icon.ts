// Dev-only macOS icon: brand the Electron.app bundle in node_modules
// with the Bowerbird icon, so Mission Control (and the app switcher)
// show Bowerbird instead of Electron when running from source.
// Mission Control reads the icon from the bundle's CFBundleIconFile,
// not from app.dock.setIcon, which only changes the Dock tile.
// Runs on every `npm run dev` and is idempotent, so it survives `npm ci`.
// Failures are logged, never silent, and never block the launch.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ICNS_NAME = "Bowerbird";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function newestSourceMtime(root: string): number {
  const iconPng = path.join(root, "assets", "icon.png");
  let newest = fs.existsSync(iconPng) ? fs.statSync(iconPng).mtimeMs : 0;
  const iconset = path.join(root, "assets", "icon.iconset");
  if (fs.existsSync(iconset)) {
    for (const name of fs.readdirSync(iconset)) {
      const stat = fs.statSync(path.join(iconset, name));
      if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// Run a helper and, on failure, throw with the helper's own stderr
// attached — the plain execFileSync message only says the command
// failed, not why.
function run(cmd: string, args: string[], label: string): void {
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`${label} failed: ${stderr || errorText(error)}`);
  }
}

function buildIcns(root: string, out: string): void {
  // On a Mac, iconutil is the native builder; fall back to the
  // repo's own generator (the same one package-mac.sh uses on Linux).
  const iconset = path.join(root, "assets", "icon.iconset");
  try {
    run("iconutil", ["-c", "icns", iconset, "-o", out], "iconutil");
    return;
  } catch (error) {
    console.warn(`Dev icon: iconutil did not build the .icns (${errorText(error)}), trying make-icns.py`);
  }
  run("python3", [path.join(root, "scripts", "make-icns.py"), path.join(root, "assets", "icon.png"), out], "make-icns.py");
}

function setPlistIcon(infoPlist: string): void {
  try {
    run("plutil", ["-replace", "CFBundleIconFile", "-string", ICNS_NAME, infoPlist], "plutil -replace");
  } catch {
    run("plutil", ["-insert", "CFBundleIconFile", "-string", ICNS_NAME, infoPlist], "plutil -insert");
  }
}

function registerWithLaunchServices(appBundle: string): void {
  // Bumping the bundle mtime alone often does not invalidate the
  // Launch Services icon cache; re-registering the bundle does.
  // Best-effort: a stale cache must never stop the dev app launching.
  try {
    run(LSREGISTER, ["-f", appBundle], "lsregister");
  } catch (error) {
    console.warn(`Dev icon: lsregister did not refresh the icon cache (${errorText(error)}); Mission Control may keep the old icon until the next launch`);
  }
}

export function brandDevAppIcon(root: string): void {
  if (process.platform !== "darwin") return;
  try {
    const appBundle = path.join(root, "node_modules", "electron", "dist", "Electron.app");
    const resources = path.join(appBundle, "Contents", "Resources");
    const infoPlist = path.join(appBundle, "Contents", "Info.plist");
    if (!fs.existsSync(resources) || !fs.existsSync(infoPlist)) {
      console.warn(`Dev icon: Electron.app bundle not found at ${appBundle}, skipping (Mission Control will show the Electron icon)`);
      return;
    }
    const target = path.join(resources, `${ICNS_NAME}.icns`);
    const plist = fs.readFileSync(infoPlist, "utf8");
    const plistBranded = new RegExp(`<key>CFBundleIconFile<\\/key>\\s*<string>${ICNS_NAME}<\\/string>`).test(plist);
    const targetStat = fs.existsSync(target) ? fs.statSync(target) : null;
    const targetFresh =
      targetStat !== null && targetStat.size > 0 && targetStat.mtimeMs >= newestSourceMtime(root);
    if (plistBranded && targetFresh) {
      console.log("Dev icon: Electron.app already branded, skipping");
      return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-icon-"));
    try {
      const icns = path.join(tmp, `${ICNS_NAME}.icns`);
      buildIcns(root, icns);
      fs.copyFileSync(icns, target);
      setPlistIcon(infoPlist);
      // Bump the bundle mtime so macOS icon services re-read the icon.
      const now = new Date();
      fs.utimesSync(appBundle, now, now);
      fs.utimesSync(infoPlist, now, now);
      registerWithLaunchServices(appBundle);
      console.log("Dev icon: Bowerbird icon applied to Electron.app (Mission Control)");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (error) {
    // Best-effort: a missing icon must never stop the dev app launching.
    // But a silent failure is worse than a noisy one: say what failed.
    console.error(`Dev icon: failed to brand Electron.app (${errorText(error)}); Mission Control will show the Electron icon`);
  }
}
