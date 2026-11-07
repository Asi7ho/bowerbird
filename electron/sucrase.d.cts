// Types for the bundled Sucrase transpiler (see scripts/bundle-sucrase.mjs).
// The real file is electron-dist/sucrase.cjs, generated at build time by
// bundling the sucrase package into a single CommonJS file, so the main
// process can transpile plugin TypeScript at runtime without node_modules
// (the packaged app ships no node_modules). This declaration exists only
// so tsc can type-check the import; the .cjs itself is never type-checked.
export function transform(
  code: string,
  options: { transforms: Array<"typescript" | "jsx" | "flow" | "imports" | "react-hot-loader"> }
): { code: string };
