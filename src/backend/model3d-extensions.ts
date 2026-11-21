// The 3D formats a card can load, by file extension.
// .gltf is deliberately out: its geometry lives in a
// separate .bin that would not be embedded with it, so
// it would land as a broken card. The rest are
// self-contained — an .obj without its .mtl still shows
// its geometry, a .dae without its textures still shows
// its shape — so they load, just with default materials.
//
// This lives apart from model3d.ts on purpose: drops.ts
// needs the set to classify a dropped file, and importing
// model3d.ts would pull three.js (~694 KB) into the main
// chunk for every board, even one with no 3D card.
export const MODEL3D_EXTENSIONS = new Set(["glb", "obj", "fbx", "stl", "usdz", "dae"]);
