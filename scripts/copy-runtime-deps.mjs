// Copy the pruned runtime node_modules the packaged app needs.
//
// The package scripts (package-mac.sh, package-linux.sh,
// package-win.sh) ship no node_modules, but the compiled main
// process needs two libraries at runtime:
//   - jszip (electron/export.ts: board export and import)
//   - @xenova/transformers (electron/context.ts: Whisper
//     transcription and CLIP/AST context search, via a dynamic
//     import). The main process is compiled with tsc, which
//     keeps these as runtime requires — they are NOT bundled.
// Without them the packaged app fails with MODULE_NOT_FOUND
// the first time export or transcription is used.
//
// This copies only what the packaged app actually loads:
// jszip + @xenova/transformers + their transitive runtime
// dependencies, pruned to the target platform. It does NOT
// copy all of node_modules (that would add ~hundreds of MB
// of dev tools and test code).
//
// Pruning, verified against what Node actually loads in the
// Electron main process:
//   - Type-only packages (@types/*, undici-types) are never
//     required at runtime, so they are skipped.
//   - Source maps (*.map) and TypeScript declarations
//     (*.d.ts, *.d.cts, *.d.mts) are never required, so they
//     are skipped. README/LICENSE/*.md are skipped too.
//   - @xenova/transformers/dist/ (the .wasm ONNX files and
//     the browser bundles, ~44 MB) is not loaded in Node:
//     the Node backend is onnxruntime-node, and nothing in
//     src/ imports dist/. Only src/ + package.json ship.
//   - onnxruntime-web ships only its Node entry,
//     dist/ort-web.node.js: the browser bundles and .wasm
//     files (~63 MB) are for the browser backend, which the
//     Node backend never uses. (The static import in
//     transformers' backends/onnx.js means the package must
//     resolve, but only the Node entry is read.)
//   - onnxruntime-node ships only the target platform's
//     native binary (bin/napi-v3/<platform>/<arch>/): the
//     binding loader requires exactly that one path
//     (binding.js), so the other five platform binaries
//     (~76 MB) are dead weight.
//   - sharp ships only the target platform's binding and
//     libvips binary (@img/sharp-<platform>-<arch> and
//     @img/sharp-libvips-<platform>-<arch>). sharp is
//     statically imported by transformers' image code, so
//     it must resolve even for audio-only transcription.
//     The musl libvips variant is skipped on glibc targets
//     (and vice versa): the loader picks by libc, so only
//     the matching one can ever load.
//
// Native binaries and the target platform: the release
// workflow runs each package script on its native runner
// (macOS on macOS, Windows on Windows, Linux on Linux),
// so `npm ci` on that runner installs the right platform
// binaries and the copy is correct. If the target
// platform's sharp binaries are NOT installed (for
// example building the Mac app on Linux), this prints a
// loud warning and copies nothing, so the package script
// still produces the app — but that app will not be able
// to export or transcribe, exactly as today. Build on the
// target platform for a working app.
//
// Usage (from the repo root):
//   node scripts/copy-runtime-deps.mjs \
//     --app-dir <resources/app dir> [--target <platform>-<arch>]
// --target defaults to the host platform and arch, e.g.
// darwin-arm64, linux-x64, win32-x64.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");

const ROOTS = ["jszip", "@xenova/transformers"];

// Packages that are never required at runtime (type-only).
const TYPE_ONLY = new Set(["undici-types"]);
function isTypeOnly(name) {
  return name.startsWith("@types/") || TYPE_ONLY.has(name);
}

// File names that are never required at runtime.
function isSkippableFile(name) {
  return (
    name.endsWith(".map") ||
    name.endsWith(".d.ts") ||
    name.endsWith(".d.cts") ||
    name.endsWith(".d.mts") ||
    name.endsWith(".md") ||
    name === "LICENSE" ||
    name === "LICENCE" ||
    name === "LICENSE.md" ||
    name === "LICENSE-MIT" ||
    name === "NOTICE"
  );
}

// Resolve a dependency the way Node does: the requiring
// package's own node_modules first, then up the tree.
function resolveDep(name, fromDir) {
  let dir = fromDir;
  while (true) {
    const cand = path.join(dir, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(cand, "package.json"))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

// The runtime closure: every package reachable from the
// roots through dependencies + installed optional
// dependencies, keyed by name@version so a nested copy
// (e.g. protobufjs/node_modules/long) is kept distinct.
function computeClosure() {
  const seen = new Map(); // name@version -> { name, dir }
  const visit = (name, fromDir) => {
    const dir = resolveDep(name, fromDir);
    if (!dir) return;
    const pkg = readPkg(dir);
    if (!pkg) return;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return;
    seen.set(key, { name: pkg.name, dir });
    const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
    for (const dep of Object.keys(deps)) visit(dep, dir);
  };
  for (const root of ROOTS) visit(root, NODE_MODULES);
  return [...seen.values()];
}

// Should this path inside a package be copied? rel is the
// path relative to the package root. platform/arch are the
// target (e.g. darwin/arm64).
function keepFile(pkgName, rel, platform, arch) {
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];
  if (isSkippableFile(base)) return false;

  // Type-only packages never ship.
  if (isTypeOnly(pkgName)) return false;

  // @xenova/transformers: only src/ is loaded in Node.
  // dist/ holds the .wasm ONNX files and the browser
  // bundles; nothing in src/ imports it.
  if (pkgName === "@xenova/transformers") {
    return parts[0] === "src" || rel === "package.json";
  }

  // onnxruntime-web: only the Node entry is read in Node.
  if (pkgName === "onnxruntime-web") {
    return rel === "package.json" || rel === path.join("dist", "ort-web.node.js");
  }

  // onnxruntime-node: the JS wrapper plus only the target
  // platform's native binary. lib/ is TypeScript source.
  if (pkgName === "onnxruntime-node") {
    if (parts[0] === "lib") return false;
    if (parts[0] === "bin") {
      return (
        parts[1] === "napi-v3" &&
        parts[2] === platform &&
        parts[3] === arch
      );
    }
    return true;
  }

  // onnxruntime-common: the JS wrapper only; lib/ is
  // TypeScript source.
  if (pkgName === "onnxruntime-common") {
    if (parts[0] === "lib") return false;
    return true;
  }

  // sharp: the JS wrapper only; lib/ is types, src/ is
  // C++ source, install/ is install scripts.
  if (pkgName === "sharp") {
    return parts[0] === "dist" || rel === "package.json";
  }

  // sharp's platform packages: only the target platform's
  // binding and libvips binary can ever load. The name
  // must match exactly, so the musl variant is excluded
  // on a glibc target (and vice versa).
  if (pkgName.startsWith("@img/sharp-") || pkgName.startsWith("@img/sharp-libvips-")) {
    return (
      pkgName === `@img/sharp-${platform}-${arch}` ||
      pkgName === `@img/sharp-libvips-${platform}-${arch}`
    );
  }

  return true;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function parseArgs(argv) {
  const args = { appDir: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app-dir") args.appDir = argv[++i];
    else if (argv[i] === "--target") args.target = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!args.appDir) {
    console.error("usage: node scripts/copy-runtime-deps.mjs --app-dir <dir> [--target <platform>-<arch>]");
    process.exit(2);
  }
  return args;
}

function main() {
  const { appDir, target } = parseArgs(process.argv.slice(2));
  const [platform, arch] = (target || `${process.platform}-${process.arch}`).split("-");
  const destRoot = path.resolve(appDir, "node_modules");

  // Native-binary precondition: the target platform's
  // sharp binaries must be installed, or the copy cannot
  // produce a working app. onnxruntime-node ships every
  // platform's binary in one package, so its check is
  // about the path existing, not the host. sharp's
  // platform binaries are optional dependencies, so npm
  // only installs the host platform's — a cross-platform
  // build (Mac app on Linux) has no darwin binaries.
  const ortBin = path.join(
    NODE_MODULES, "onnxruntime-node", "bin", "napi-v3", platform, arch,
    "onnxruntime_binding.node",
  );
  const sharpBin = path.join(NODE_MODULES, `@img/sharp-${platform}-${arch}`, "package.json");
  const libvipsBin = path.join(NODE_MODULES, `@img/sharp-libvips-${platform}-${arch}`, "package.json");
  const missing = [];
  if (!fs.existsSync(ortBin)) missing.push(`onnxruntime-node has no ${platform}/${arch} binary`);
  if (!fs.existsSync(sharpBin)) missing.push(`@img/sharp-${platform}-${arch} is not installed`);
  if (!fs.existsSync(libvipsBin)) missing.push(`@img/sharp-libvips-${platform}-${arch} is not installed`);
  if (missing.length > 0) {
    console.error("!! copy-runtime-deps: skipping the runtime node_modules —");
    for (const m of missing) console.error(`!!   ${m}`);
    console.error(`!!   (building a ${platform}/${arch} app on ${process.platform}/${process.arch})`);
    console.error("!!   Board export and transcription will NOT work in this build,");
    console.error("!!   exactly as in today's packaged app. Build on the target");
    console.error("!!   platform (where `npm ci` installs its native binaries) for");
    console.error("!!   a working app.");
    return;
  }

  const closure = computeClosure();
  let files = 0;
  let bytes = 0;
  const pkgs = [];
  for (const { name, dir } of closure) {
    // A package whose files are all excluded still counts
    // as skipped, not copied.
    let copied = false;
    for (const file of walkFiles(dir)) {
      const rel = path.relative(dir, file);
      if (!keepFile(name, rel, platform, arch)) continue;
      // Preserve nested node_modules paths (e.g.
      // protobufjs/node_modules/long) exactly.
      const dest = path.join(destRoot, path.relative(NODE_MODULES, file));
      copyFile(file, dest);
      files += 1;
      bytes += fs.statSync(file).size;
      copied = true;
    }
    if (copied) pkgs.push(name);
  }

  console.log(
    `-- runtime node_modules: ${pkgs.length} packages, ${files} files, ${(bytes / 1048576).toFixed(1)} MB ` +
    `(target ${platform}/${arch})`,
  );
}

main();
