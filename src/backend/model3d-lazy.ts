// Lazy loader for the 3D viewer (model3d.ts / three.js).
// three.js is ~694 KB: it loads on the first Model3D card
// mount, not at module load, so boards without a 3D card
// never fetch it and first paint does not wait for it.
// The welcome board has a 3D card, so a fresh install still
// loads it — just after first paint, on first mount.
//
// The import is cached (import once, reuse the module),
// following the pdf.js pattern in media.ts / ai-import.ts.
import type * as Model3D from "./model3d";

let mod: typeof Model3D | null = null;
let loading: Promise<typeof Model3D> | null = null;

export function loadModel3d(): Promise<typeof Model3D> {
  if (mod) return Promise.resolve(mod);
  if (!loading) {
    loading = import("./model3d").then((m) => {
      mod = m;
      return m;
    });
  }
  return loading;
}

// The loaded module, or null before the first 3D mount:
// lets call sites run the sync path when three.js is
// already in, and skip it (no views exist yet) when not.
export function getLoadedModel3d(): typeof Model3D | null {
  return mod;
}

// Dispose every viewer, but only when the module loaded:
// a board with no 3D card must not fetch three.js just to
// tear it down.
export function disposeModel3DViewersIfLoaded(): void {
  mod?.disposeAllModel3DViewers();
}
