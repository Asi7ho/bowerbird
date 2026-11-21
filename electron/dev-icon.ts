// Dev-only macOS icon: brand the Electron.app bundle in node_modules
// with the Bowerbird icon, so Mission Control (and the app switcher)
// show Bowerbird instead of Electron when running from source.
// Mission Control reads the icon from the bundle's CFBundleIconFile,
// not from app.dock.setIcon, which only changes the Dock tile.
// Runs on every `npm run dev` and is idempotent, so it survives `npm ci`.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ICNS_NAME = "Bowerbird";

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

function buildIcns(root: string, out: string): void {
  // On a Mac, iconutil is the native builder; fall back to the
  // repo's own generator (the same one package-mac.sh uses on Linux).
  const iconset = path.join(root, "assets", "icon.iconset");
  try {
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", out], { stdio: "ignore" });
    return;
  } catch {
    // iconutil missing or failed; try the Python generator.
  }
  execFileSync("python3", [path.join(root, "scripts", "make-icns.py"), path.join(root, "assets", "icon.png"), out], { stdio: "ignore" });
}

function setPlistIcon(infoPlist: string): void {
  try {
    execFileSync("plutil", ["-replace", "CFBundleIconFile", "-string", ICNS_NAME, infoPlist], { stdio: "ignore" });
  } catch {
    execFileSync("plutil", ["-insert", "CFBundleIconFile", "-string", ICNS_NAME, infoPlist], { stdio: "ignore" });
  }
}

export function brandDevAppIcon(root: string): void {
  if (process.platform !== "darwin") return;
  try {
    const appBundle = path.join(root, "node_modules", "electron", "dist", "Electron.app");
    const resources = path.join(appBundle, "Contents", "Resources");
    const infoPlist = path.join(appBundle, "Contents", "Info.plist");
    if (!fs.existsSync(resources) || !fs.existsSync(infoPlist)) return;
    const target = path.join(resources, `${ICNS_NAME}.icns`);
    const plist = fs.readFileSync(infoPlist, "utf8");
    const plistBranded = new RegExp(`<key>CFBundleIconFile<\\/key>\\s*<string>${ICNS_NAME}<\\/string>`).test(plist);
    const targetMtime = fs.existsSync(target) ? fs.statSync(target).mtimeMs : 0;
    if (plistBranded && targetMtime >= newestSourceMtime(root)) return;
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
      console.log("Dev icon: Bowerbird icon applied to Electron.app (Mission Control)");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch {
    // Best-effort: a missing icon must never stop the dev app launching.
  }
}
