// Build the bundled plugins' TypeScript into JavaScript, in place.
// The runtime plugin loader serves .js over the plugin: scheme, so
// the .js is a build artifact (gitignored) and the .ts is the source.
// This only transpiles — it does not type-check and does not bundle.
// Type-checking is tsc -p tsconfig.plugins.json (noEmit), which runs
// as its own step in npm run build / npm run dev. Bundling is
// deliberately off: a plugin stays multi-file, so its relative
// imports resolve against its own folder at runtime, exactly like
// a first-party plugin's imports resolve against src/. The import
// type statements (PluginContext and friends, from ../../src/...) are
// erased here, so no src/ file is ever emitted or bundled.
import { build } from "esbuild";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function tsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

const entries = tsFiles(join(root, "plugins"));
if (entries.length === 0) {
  console.log("No plugin TypeScript files to build.");
  process.exit(0);
}

// One call for all plugins. outbase is the repo root, so each
// plugin's structure is preserved: plugins/hide/main.ts becomes
// plugins/hide/main.js, and plugins/hide/src/foo.ts becomes
// plugins/hide/src/foo.js, with relative imports intact.
await build({
  entryPoints: entries,
  outdir: root,
  outbase: root,
  format: "esm",
  target: "es2022",
  logLevel: "info",
});
