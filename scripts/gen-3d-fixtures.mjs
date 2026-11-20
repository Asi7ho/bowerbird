// Generate 3D fixtures (a blue cube, matching tests/e2e/fixtures/cube.glb)
// as .obj, .stl and .usdz, using three.js exporters. Run once:
//   node scripts/gen-3d-fixtures.mjs
// Output lands in tests/e2e/fixtures/.
import { BoxGeometry, Mesh, MeshStandardMaterial } from "three";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "tests/e2e/fixtures");

const cube = new Mesh(
  new BoxGeometry(2, 2, 2),
  new MeshStandardMaterial({ color: 0x3366ff }),
);

writeFileSync(join(out, "cube.obj"), new OBJExporter().parse(cube));
writeFileSync(join(out, "cube.stl"), new STLExporter().parse(cube, { binary: false }));
const usdz = await new USDZExporter().parseAsync(cube);
writeFileSync(join(out, "cube.usdz"), Buffer.from(usdz));
console.log("wrote cube.obj, cube.stl, cube.usdz");
