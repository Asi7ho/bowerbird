// Bundle Sucrase into electron-dist/sucrase.cjs so the main process
// can transpile plugin TypeScript at runtime. The packaged app ships
// no node_modules, so the transpiler must be a file inside
// electron-dist. Sucrase is pure JavaScript (no native binary), and
// bundling it to a single CommonJS file keeps the main process a
// plain tsc compile — no bundler change, no ESM/CJS interop.
import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

await build({
  entryPoints: [resolve(root, "node_modules/sucrase/dist/esm/index.js")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: resolve(root, "electron-dist/sucrase.cjs"),
  logLevel: "info",
});
