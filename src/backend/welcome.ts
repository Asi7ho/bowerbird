// Welcome board: the first board a new user sees. It lives in
// its own file, not in src/main.ts, because it is content, not
// app logic: the layout, wording and welcome assets, with no
// interaction state, no DOM and no plugin wiring. It
// takes the board folder as a parameter, instead of
// reading the core's boardDir global, so it is a pure
// function of (boardDir, pdfSize, videoSize, modelSize) — same
// inputs, same board, every time.

import type { Board, Item } from "./model";
import { estimateTextHeight } from "./model";

export function welcomeBoard(boardDir: string, pdfSize: number, videoSize: number, modelSize: number): Board {
  const b: Board = {
    items: [], camera: { x: 0, y: 0, zoom: 1 }, next_id: 0, next_group: 0,
    bg: "#FFFFFF", grid: "Dots",
  };
  const add = (item: Item) => { b.items.push(item); return item.id; };
  const next = () => { b.next_id += 1; return b.next_id; };
  const note = (text: string, _w: number) => ({ Text: { text, bold: false, size: 16, color: "#1A1A1A" } });
  const WIKI_ICON = "https://en.wikipedia.org/static/favicon/wikipedia.ico";
  // V3: fewer items, more space. Every capability is shown once,
  // with at least 30px between cards, and nothing overlapping.
  // Tab order is board order: title, photo, link, colours, PDF,
  // audio, video, the grouped pair, then the how-to note.
  const titleText = "# Welcome to Bowerbird\n\nAn infinite board for notes, photos, links, audio and video.";
  add({ id: next(), pos: { x: 120, y: 40 }, size: { w: 320, h: estimateTextHeight(titleText, 16, 320) }, group: null, kind: note(titleText, 320) });
  add({ id: next(), pos: { x: 480, y: 40 }, size: { w: 360, h: 225 }, group: null, kind: { Image: { path: `${boardDir}/welcome-bower.jpg` } } });
  add({ id: next(), pos: { x: 880, y: 40 }, size: { w: 320, h: 300 }, group: null, kind: { UrlCard: { url: "https://en.wikipedia.org/wiki/Japanese_garden", title: "Japanese garden", description: "Type of traditional garden", image: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Saihouji-kokedera01.jpg/330px-Saihouji-kokedera01.jpg", icon: WIKI_ICON } } });
  add({ id: next(), pos: { x: 120, y: 240 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex: "#2A6D09" } } });
  add({ id: next(), pos: { x: 260, y: 240 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex: "#007AFF" } } });
  add({ id: next(), pos: { x: 120, y: 400 }, size: { w: 260, h: 96 }, group: null, kind: { PdfCard: { path: `${boardDir}/sample.pdf`, size_bytes: pdfSize } } });
  add({ id: next(), pos: { x: 420, y: 400 }, size: { w: 300, h: 104 }, group: null, kind: { Audio: { path: `${boardDir}/welcome-birdsong.mp3` } } });
  add({ id: next(), pos: { x: 760, y: 400 }, size: { w: 360, h: 280 }, group: null, kind: { Video: { source: `${boardDir}/welcome-video.mp4`, remote: false, size_bytes: videoSize } } });
  const groupText = "Grouped — these two move together.\n\nDrag either one, and both move. Ctrl + G groups, Ctrl + U ungroups.";
  add({ id: next(), pos: { x: 120, y: 530 }, size: { w: 300, h: estimateTextHeight(groupText, 16, 300) }, group: 1, kind: note(groupText, 300) });
  add({ id: next(), pos: { x: 450, y: 530 }, size: { w: 120, h: 120 }, group: 1, kind: { Swatch: { hex: "#FF6B35" } } });
  const tryText = "## Try this\n\n- Double-click a note to edit it\n- Tab jumps to the next element\n- Space + drag to pan, Ctrl + scroll to zoom\n- Drag a file onto the board";
  add({ id: next(), pos: { x: 600, y: 710 }, size: { w: 420, h: estimateTextHeight(tryText, 16, 420) }, group: null, kind: note(tryText, 420) });
  // Pen annotation: a red circle drawn around the bowerbird photo.
  const circle: Array<{ x: number; y: number }> = [];
  for (let k = 0; k < 36; k += 1) {
    const a = (2 * Math.PI * k) / 36;
    circle.push({ x: 660 + 190 * Math.cos(a), y: 152 + 110 * Math.sin(a) });
  }
  add({ id: next(), pos: { x: 470, y: 42 }, size: { w: 380, h: 220 }, group: null, kind: { Stroke: { points: circle, color: "#E63946", width: 4, marker: false } } });
  // Connector: the photo points to the article. Short, between
  // neighbours, crossing nothing.
  add({ id: next(), pos: { x: 1, y: 1 }, size: { w: 1, h: 1 }, group: null, kind: { Connector: { from: { Item: 2 }, to: { Item: 3 }, color: "#333333" } } });
  // Formats, one screen to the right: what dropping a file
  // onto the board produces. These cards are not hand-drawn —
  // they are the literal output of dropping the sample files
  // (sample.svg, sample.psd, sample-vector.ai, cube.glb)
  // through the real importers, translated to this section,
  // so the board shows exactly what a drop gives you. The
  // raster layers and the AI's embedded images live in
  // assets/ as welcome-*.png and are installed with the
  // other welcome files. If an importer changes, these
  // snapshots do not follow on their own — regenerate them
  // by dropping the samples again and re-translating.
  const formatsText = "## Formats";
  add({ id: next(), pos: { x: 1300, y: 40 }, size: { w: 320, h: estimateTextHeight(formatsText, 16, 320) }, group: null, kind: note(formatsText, 320) });
  const svgText = "SVG — shapes, strokes and text";
  add({ id: next(), pos: { x: 1300, y: 88 }, size: { w: 320, h: estimateTextHeight(svgText, 16, 320) }, group: null, kind: note(svgText, 320) });
  // SVG: dropped from the sample file — the cards the importer produces.
  add({ id: next(), pos: { x: 1300, y: 120 }, size: { w: 100, h: 50 }, group: null, kind: { Shape: { shape: "rect", fill: "#ff0000" } } });
  add({ id: next(), pos: { x: 1465, y: 125 }, size: { w: 50, h: 50 }, group: null, kind: { Shape: { shape: "ellipse", fill: "#0000ff" } } });
  add({ id: next(), pos: { x: 1560, y: 135 }, size: { w: 60, h: 30 }, group: null, kind: { Shape: { shape: "ellipse", fill: "#00ff00", outline: true } } });
  add({ id: next(), pos: { x: 1300, y: 200 }, size: { w: 100, h: 1 }, group: null, kind: { Stroke: { points: [{ x: 1300, y: 200 }, { x: 1400, y: 200 }], color: "#000000", width: 2, marker: false } } });
  add({ id: next(), pos: { x: 1440, y: 200 }, size: { w: 40, h: 20 }, group: null, kind: { Stroke: { points: [{ x: 1440, y: 200 }, { x: 1460, y: 220 }, { x: 1480, y: 200 }], color: "#000000", width: 1, marker: false } } });
  add({ id: next(), pos: { x: 1500, y: 200 }, size: { w: 50, h: 50 }, group: null, kind: { Stroke: { points: [{ x: 1500, y: 200 }, { x: 1550, y: 200 }, { x: 1550, y: 250 }, { x: 1500, y: 200 }], color: "#0000ff", width: 2, marker: false } } });
  add({ id: next(), pos: { x: 1300, y: 260 }, size: { w: 136, h: 51 }, group: null, kind: { Text: { text: "Hello SVG", bold: false, size: 20, color: "#333333" } } });
  add({ id: next(), pos: { x: 1610, y: 200 }, size: { w: 40, h: 40 }, group: null, kind: { Shape: { shape: "rect", fill: "#ffd700" } } });
  const psdText = "PSD — layers as cards";
  add({ id: next(), pos: { x: 1300, y: 348 }, size: { w: 320, h: estimateTextHeight(psdText, 16, 320) }, group: null, kind: note(psdText, 320) });
  // PSD: dropped from the sample file — the cards the importer produces.
  // One nudge: the green layer sits 7px under the text card in
  // the PSD's own layout, so it is moved down 17px to clear it.
  add({ id: next(), pos: { x: 1410, y: 457 }, size: { w: 40, h: 30 }, group: null, kind: { Image: { path: `${boardDir}/welcome-psd-green.png` } } });
  add({ id: next(), pos: { x: 1390, y: 390 }, size: { w: 120, h: 57 }, group: null, kind: { Text: { text: "Hello PSD", bold: false, size: 24, color: "#000000" } } });
  add({ id: next(), pos: { x: 1300, y: 380 }, size: { w: 80, h: 60 }, group: null, kind: { Image: { path: `${boardDir}/welcome-psd-red.png` } } });
  const glbText = "3D — drag to rotate";
  add({ id: next(), pos: { x: 1300, y: 508 }, size: { w: 320, h: estimateTextHeight(glbText, 16, 320) }, group: null, kind: note(glbText, 320) });
  // GLB: dropped from the sample file — the cards the importer produces.
  add({ id: next(), pos: { x: 1300, y: 540 }, size: { w: 360, h: 300 }, group: null, kind: { Model3D: { path: `${boardDir}/welcome-cube.glb`, size_bytes: modelSize } } });
  const aiText = ".ai — editable artwork";
  add({ id: next(), pos: { x: 1700, y: 88 }, size: { w: 320, h: estimateTextHeight(aiText, 16, 320) }, group: null, kind: note(aiText, 320) });
  // AI: dropped from the sample file — the cards the importer produces.
  add({ id: next(), pos: { x: 1720, y: 125 }, size: { w: 80, h: 40 }, group: null, kind: { Shape: { shape: "rect", fill: "#ff0000" } } });
  add({ id: next(), pos: { x: 1875, y: 120 }, size: { w: 50, h: 50 }, group: null, kind: { Shape: { shape: "ellipse", fill: "#0000ff" } } });
  add({ id: next(), pos: { x: 1720, y: 225 }, size: { w: 80, h: 60 }, group: null, kind: { Stroke: { points: [{ x: 1720, y: 285 }, { x: 1760, y: 225 }, { x: 1800, y: 275 }], color: "#008000", width: 2, marker: false } } });
  add({ id: next(), pos: { x: 1720, y: 181 }, size: { w: 120, h: 48 }, group: null, kind: { Text: { text: "Hello AI", bold: false, size: 14, color: "#000000" } } });
  add({ id: next(), pos: { x: 1850, y: 255 }, size: { w: 40, h: 30 }, group: null, kind: { Shape: { shape: "rect", fill: "#ff8000" } } });
  add({ id: next(), pos: { x: 1750, y: 369 }, size: { w: 100, h: 60 }, group: null, kind: { Image: { path: `${boardDir}/welcome-ai-image.png` } } });
  add({ id: next(), pos: { x: 1700, y: 553 }, size: { w: 300, h: 200 }, group: null, kind: { Image: { path: `${boardDir}/welcome-ai-page.png` } } });
  b.next_group = 2;
  return b;
}
