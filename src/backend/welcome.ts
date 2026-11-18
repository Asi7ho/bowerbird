// Welcome board: the first board a new user sees. It lives in
// its own file, not in src/main.ts, because it is content, not
// app logic: the layout, wording and welcome assets, with no
// interaction state, no DOM and no plugin wiring. It
// takes the board folder as a parameter, instead of
// reading the core's boardDir global, so it is a pure
// function of (boardDir, pdfSize, videoSize, modelSize, psdSize, aiSize) — same
// inputs, same board, every time.

import type { Board, Item } from "./model";
import { estimateTextHeight } from "./model";

export function welcomeBoard(boardDir: string, pdfSize: number, videoSize: number, modelSize: number, psdSize: number, aiSize: number): Board {
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
  // The new formats, woven in as content, not a section: no
  // heading, no labels, no grid. A bird drawn in SVG (editable
  // shapes, the literal output of dropping welcome-bird.svg
  // through the importer), a garden PSD and a heron AI as
  // FileCards (exactly what a drop gives you), and the cube —
  // placed like the rest of the board, in its loose rows, a
  // little staggered, so they read as more of the same board.
  // The SVG source lives in assets/welcome-bird.svg; if the
  // importer changes, regenerate the items by dropping it again.
  // Bird at (1240, 60), AI at (1660, 40), PSD at (1260, 400),
  // cube at (1680, 420).
  add({ id: next(), pos: { x: 1524, y: 60 }, size: { w: 40, h: 40 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#ffd700"}} });
  add({ id: next(), pos: { x: 1240, y: 216 }, size: { w: 340, h: 46 }, group: null, kind: {"Stroke":{"points":[{"x":1240,"y":262},{"x":1277.74,"y":255.18},{"x":1317.31,"y":250.59},{"x":1358.48,"y":247.27},{"x":1401,"y":244.25},{"x":1444.65,"y":240.57},{"x":1489.19,"y":235.28},{"x":1534.38,"y":227.41},{"x":1580,"y":216}],"color":"#7a5230","width":6,"marker":false}} });
  add({ id: next(), pos: { x: 1300.82, y: 236.13 }, size: { w: 30.36, h: 23.74 }, group: null, rotation: -28, kind: {"Shape":{"shape":"ellipse","fill":"#2a6d09"}} });
  add({ id: next(), pos: { x: 1388.83, y: 233.97 }, size: { w: 30.34, h: 20.07 }, group: null, rotation: 18, kind: {"Shape":{"shape":"ellipse","fill":"#2a6d09"}} });
  add({ id: next(), pos: { x: 1474.77, y: 225.19 }, size: { w: 30.46, h: 21.62 }, group: null, rotation: -22, kind: {"Shape":{"shape":"ellipse","fill":"#2a6d09"}} });
  add({ id: next(), pos: { x: 1537.15, y: 214.25 }, size: { w: 25.71, h: 15.51 }, group: null, rotation: 14, kind: {"Shape":{"shape":"ellipse","fill":"#2a6d09"}} });
  add({ id: next(), pos: { x: 1290, y: 231 }, size: { w: 2, h: 20 }, group: null, kind: {"Stroke":{"points":[{"x":1292,"y":231},{"x":1290,"y":251}],"color":"#2a6d09","width":2,"marker":false}} });
  add({ id: next(), pos: { x: 1286.5, y: 212.5 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1278.9, y: 218 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1281.8, y: 227 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1291.2, y: 227 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1294.1, y: 218 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1289, y: 223 }, size: { w: 6, h: 6 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#ffd700"}} });
  add({ id: next(), pos: { x: 1528, y: 208 }, size: { w: 1, h: 20 }, group: null, kind: {"Stroke":{"points":[{"x":1528,"y":208},{"x":1528,"y":228}],"color":"#2a6d09","width":2,"marker":false}} });
  add({ id: next(), pos: { x: 1522.5, y: 188.5 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1514.9, y: 194 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1517.8, y: 203 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1527.2, y: 203 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1530.1, y: 194 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1525, y: 199 }, size: { w: 6, h: 6 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#ffd700"}} });
  add({ id: next(), pos: { x: 1364, y: 238 }, size: { w: 8, h: 8 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1464, y: 230 }, size: { w: 8, h: 8 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1554.5, y: 190.5 }, size: { w: 7, h: 7 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1343.12, y: 202.79 }, size: { w: 55.49, h: 27.38 }, group: null, rotation: 16, kind: {"Shape":{"shape":"rect","fill":"#2a9d8f"}} });
  add({ id: next(), pos: { x: 1380, y: 162 }, size: { w: 104, h: 76 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#2a9d8f"}} });
  add({ id: next(), pos: { x: 1392.67, y: 180.9 }, size: { w: 62.65, h: 46.2 }, group: null, rotation: -16, kind: {"Shape":{"shape":"ellipse","fill":"#2e86ab"}} });
  add({ id: next(), pos: { x: 1451, y: 140 }, size: { w: 48, h: 48 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#2a9d8f"}} });
  add({ id: next(), pos: { x: 1478, y: 155 }, size: { w: 8, h: 8 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#1a1a1a"}} });
  add({ id: next(), pos: { x: 1482, y: 156 }, size: { w: 3, h: 3 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#ffffff"}} });
  add({ id: next(), pos: { x: 1495.58, y: 160.02 }, size: { w: 17.74, h: 9.73 }, group: null, rotation: 6, kind: {"Shape":{"shape":"rect","fill":"#ff6b35"}} });
  add({ id: next(), pos: { x: 1428, y: 234 }, size: { w: 2, h: 12 }, group: null, kind: {"Stroke":{"points":[{"x":1430,"y":234},{"x":1428,"y":246}],"color":"#1a1a1a","width":3,"marker":false}} });
  add({ id: next(), pos: { x: 1444, y: 234 }, size: { w: 2, h: 12 }, group: null, kind: {"Stroke":{"points":[{"x":1444,"y":234},{"x":1446,"y":246}],"color":"#1a1a1a","width":3,"marker":false}} });
  // AI: dropped from the sample file — one FileCard.
  add({ id: next(), pos: { x: 1660, y: 40 }, size: { w: 360, h: 294 }, group: null, kind: { FileCard: { path: `${boardDir}/welcome-heron.ai`, size_bytes: aiSize, format: "ai", preview: `${boardDir}/welcome-heron-preview.png` } } });
  // PSD: dropped from the sample file — one FileCard.
  add({ id: next(), pos: { x: 1260, y: 400 }, size: { w: 360, h: 294 }, group: null, kind: { FileCard: { path: `${boardDir}/welcome-garden.psd`, size_bytes: psdSize, format: "psd", preview: `${boardDir}/welcome-garden-preview.png` } } });
  // Cube: dropped from the sample file — the model itself.
  add({ id: next(), pos: { x: 1680, y: 420 }, size: { w: 360, h: 300 }, group: null, kind: { Model3D: { path: `${boardDir}/welcome-cube.glb`, size_bytes: modelSize } } });
  b.next_group = 2;
  return b;
}
