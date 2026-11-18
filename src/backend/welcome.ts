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
  add({ id: next(), pos: { x: 110, y: 70 }, size: { w: 320, h: estimateTextHeight(titleText, 16, 320) }, group: null, kind: note(titleText, 320) });
  add({ id: next(), pos: { x: 490, y: 30 }, size: { w: 360, h: 225 }, group: null, kind: { Image: { path: `${boardDir}/welcome-bower.jpg` } } });
  add({ id: next(), pos: { x: 900, y: 95 }, size: { w: 320, h: 300 }, group: null, kind: { UrlCard: { url: "https://en.wikipedia.org/wiki/Japanese_garden", title: "Japanese garden", description: "Type of traditional garden", image: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Saihouji-kokedera01.jpg/330px-Saihouji-kokedera01.jpg", icon: WIKI_ICON } } });
  add({ id: next(), pos: { x: 140, y: 260 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex: "#2A6D09" } } });
  add({ id: next(), pos: { x: 300, y: 290 }, size: { w: 120, h: 120 }, group: null, kind: { Swatch: { hex: "#007AFF" } } });
  add({ id: next(), pos: { x: 130, y: 430 }, size: { w: 260, h: 96 }, group: null, kind: { PdfCard: { path: `${boardDir}/sample.pdf`, size_bytes: pdfSize } } });
  add({ id: next(), pos: { x: 450, y: 405 }, size: { w: 300, h: 104 }, group: null, kind: { Audio: { path: `${boardDir}/welcome-birdsong.mp3` } } });
  add({ id: next(), pos: { x: 790, y: 420 }, size: { w: 360, h: 280 }, group: null, kind: { Video: { source: `${boardDir}/welcome-video.mp4`, remote: false, size_bytes: videoSize } } });
  const groupText = "Grouped — these two move together.\n\nDrag either one, and both move. Ctrl + G groups, Ctrl + U ungroups.";
  add({ id: next(), pos: { x: 110, y: 580 }, size: { w: 300, h: estimateTextHeight(groupText, 16, 300) }, group: 1, kind: note(groupText, 300) });
  add({ id: next(), pos: { x: 450, y: 610 }, size: { w: 120, h: 120 }, group: 1, kind: { Swatch: { hex: "#FF6B35" } } });
  const tryText = "## Try this\n\n- Double-click a note to edit it\n- Tab jumps to the next element\n- Space + drag to pan, Ctrl + scroll to zoom\n- Drag a file onto the board";
  add({ id: next(), pos: { x: 620, y: 720 }, size: { w: 420, h: estimateTextHeight(tryText, 16, 420) }, group: null, kind: note(tryText, 420) });
  // Pen annotation: a red circle drawn around the bowerbird photo.
  const circle: Array<{ x: number; y: number }> = [];
  for (let k = 0; k < 36; k += 1) {
    const a = (2 * Math.PI * k) / 36;
    circle.push({ x: 670 + 190 * Math.cos(a), y: 142 + 110 * Math.sin(a) });
  }
  add({ id: next(), pos: { x: 480, y: 32 }, size: { w: 380, h: 220 }, group: null, kind: { Stroke: { points: circle, color: "#E63946", width: 4, marker: false } } });
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
  // Bird at (1280, 40), AI at (1700, 110), PSD at (1240, 360),
  // cube at (1690, 445). The whole board is laid out the same
  // loose way: no two cards share a top edge, gaps vary, nothing
  // sits on a grid — it reads as a board someone placed by hand.
  add({ id: next(), pos: { x: 1564, y: 40 }, size: { w: 40, h: 40 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#ffd700"}} });
  add({ id: next(), pos: { x: 1280, y: 196 }, size: { w: 340, h: 46 }, group: null, kind: {"Stroke":{"points":[{"x":1280,"y":242},{"x":1317.74,"y":235.18},{"x":1357.31,"y":230.59},{"x":1398.48,"y":227.27},{"x":1441,"y":224.25},{"x":1484.65,"y":220.57},{"x":1529.19,"y":215.28},{"x":1574.38,"y":207.41},{"x":1620,"y":196}],"color":"#7a5230","width":6,"marker":false}} });
  add({ id: next(), pos: { x: 1340.82, y: 216.13 }, size: { w: 30.36, h: 23.74 }, group: null, rotation: -28, kind: {"Shape":{"shape":"ellipse","fill":"#2a6d09"}} });
  add({ id: next(), pos: { x: 1428.83, y: 213.97 }, size: { w: 30.34, h: 20.07 }, group: null, rotation: 18, kind: {"Shape":{"shape":"ellipse","fill":"#2a6d09"}} });
  add({ id: next(), pos: { x: 1514.77, y: 205.19 }, size: { w: 30.46, h: 21.62 }, group: null, rotation: -22, kind: {"Shape":{"shape":"ellipse","fill":"#2a6d09"}} });
  add({ id: next(), pos: { x: 1577.15, y: 194.25 }, size: { w: 25.71, h: 15.51 }, group: null, rotation: 14, kind: {"Shape":{"shape":"ellipse","fill":"#2a6d09"}} });
  add({ id: next(), pos: { x: 1330, y: 211 }, size: { w: 2, h: 20 }, group: null, kind: {"Stroke":{"points":[{"x":1332,"y":211},{"x":1330,"y":231}],"color":"#2a6d09","width":2,"marker":false}} });
  add({ id: next(), pos: { x: 1326.5, y: 192.5 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1318.9, y: 198 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1321.8, y: 207 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1331.2, y: 207 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1334.1, y: 198 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1329, y: 203 }, size: { w: 6, h: 6 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#ffd700"}} });
  add({ id: next(), pos: { x: 1568, y: 188 }, size: { w: 1, h: 20 }, group: null, kind: {"Stroke":{"points":[{"x":1568,"y":188},{"x":1568,"y":208}],"color":"#2a6d09","width":2,"marker":false}} });
  add({ id: next(), pos: { x: 1562.5, y: 168.5 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1554.9, y: 174 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1557.8, y: 183 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1567.2, y: 183 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1570.1, y: 174 }, size: { w: 11, h: 11 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1565, y: 179 }, size: { w: 6, h: 6 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#ffd700"}} });
  add({ id: next(), pos: { x: 1404, y: 218 }, size: { w: 8, h: 8 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1504, y: 210 }, size: { w: 8, h: 8 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1594.5, y: 170.5 }, size: { w: 7, h: 7 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#f4a7b9"}} });
  add({ id: next(), pos: { x: 1383.12, y: 182.79 }, size: { w: 55.49, h: 27.38 }, group: null, rotation: 16, kind: {"Shape":{"shape":"rect","fill":"#2a9d8f"}} });
  add({ id: next(), pos: { x: 1420, y: 142 }, size: { w: 104, h: 76 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#2a9d8f"}} });
  add({ id: next(), pos: { x: 1432.67, y: 160.9 }, size: { w: 62.65, h: 46.2 }, group: null, rotation: -16, kind: {"Shape":{"shape":"ellipse","fill":"#2e86ab"}} });
  add({ id: next(), pos: { x: 1491, y: 120 }, size: { w: 48, h: 48 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#2a9d8f"}} });
  add({ id: next(), pos: { x: 1518, y: 135 }, size: { w: 8, h: 8 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#1a1a1a"}} });
  add({ id: next(), pos: { x: 1522, y: 136 }, size: { w: 3, h: 3 }, group: null, kind: {"Shape":{"shape":"ellipse","fill":"#ffffff"}} });
  add({ id: next(), pos: { x: 1535.58, y: 140.02 }, size: { w: 17.74, h: 9.73 }, group: null, rotation: 6, kind: {"Shape":{"shape":"rect","fill":"#ff6b35"}} });
  add({ id: next(), pos: { x: 1468, y: 214 }, size: { w: 2, h: 12 }, group: null, kind: {"Stroke":{"points":[{"x":1470,"y":214},{"x":1468,"y":226}],"color":"#1a1a1a","width":3,"marker":false}} });
  add({ id: next(), pos: { x: 1484, y: 214 }, size: { w: 2, h: 12 }, group: null, kind: {"Stroke":{"points":[{"x":1484,"y":214},{"x":1486,"y":226}],"color":"#1a1a1a","width":3,"marker":false}} });
  // AI: dropped from the sample file — one FileCard.
  add({ id: next(), pos: { x: 1700, y: 110 }, size: { w: 360, h: 294 }, group: null, kind: { FileCard: { path: `${boardDir}/welcome-heron.ai`, size_bytes: aiSize, format: "ai", preview: `${boardDir}/welcome-heron-preview.png` } } });
  // PSD: dropped from the sample file — one FileCard.
  add({ id: next(), pos: { x: 1240, y: 360 }, size: { w: 360, h: 294 }, group: null, kind: { FileCard: { path: `${boardDir}/welcome-garden.psd`, size_bytes: psdSize, format: "psd", preview: `${boardDir}/welcome-garden-preview.png` } } });
  // Cube: dropped from the sample file — the model itself.
  add({ id: next(), pos: { x: 1690, y: 445 }, size: { w: 360, h: 300 }, group: null, kind: { Model3D: { path: `${boardDir}/welcome-cube.glb`, size_bytes: modelSize } } });
  b.next_group = 2;
  return b;
}
