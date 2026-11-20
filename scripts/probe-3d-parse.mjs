// Probe: parse each 3D fixture with its three.js loader's parse()
// (no browser needed) and report which ones parse. Run:
//   node scripts/probe-3d-parse.mjs
// Note: .dae needs DOMParser, which Node lacks — it is covered
// by the e2e render check instead.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { USDZLoader } from "three/addons/loaders/USDZLoader.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fix = join(root, "tests/e2e/fixtures");

// Node Buffers are Uint8Array views; the binary loaders want
// a plain ArrayBuffer.
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const cases = [
  ["obj", () => new OBJLoader().parse(readFileSync(join(fix, "cube.obj"), "utf8"))],
  ["stl", () => new STLLoader().parse(readFileSync(join(fix, "cube.stl"), "utf8"))],
  ["fbx", () => new FBXLoader().parse(toArrayBuffer(readFileSync(join(fix, "cube.fbx"))), "")],
  ["usdz", () => new USDZLoader().parse(toArrayBuffer(readFileSync(join(fix, "cube.usdz"))))],
];

for (const [ext, fn] of cases) {
  try {
    const out = await fn();
    const group = out?.scene ?? out;
    const meshes = [];
    group?.traverse?.((o) => { if (o.isMesh) meshes.push(o); });
    console.log(ext, "OK", "meshes:", meshes.length, "positions:", meshes[0]?.geometry?.attributes?.position?.count ?? 0);
  } catch (e) {
    console.log(ext, "FAIL", String(e?.message ?? e).split("\n")[0]);
  }
}
