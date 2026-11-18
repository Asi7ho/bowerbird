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
  // Formats, one screen to the right: what dropping a file
  // onto the board produces. One format per column, in a
  // two-by-two grid — a one-word label above each card, the
  // card tops aligned, nothing overlapping its label. The
  // PSD and AI cards are single FileCards, exactly what a
  // drop gives you; the SVG stays exploded editable cards,
  // and the 3D card is the model itself. The FileCard
  // previews are the real importer output (renderPsdPreview
  // / renderAiPreview over the sample files), installed with
  // the other welcome files. If an importer changes,
  // regenerate the previews by dropping the samples again.
  const formatsText = "## Formats";
  add({ id: next(), pos: { x: 1300, y: 40 }, size: { w: 320, h: estimateTextHeight(formatsText, 16, 320) }, group: null, kind: note(formatsText, 320) });
  // Row 1: SVG (left), PSD (right). Labels at y 120, cards at 180.
  const svgLabel = "SVG";
  add({ id: next(), pos: { x: 1300, y: 120 }, size: { w: 360, h: estimateTextHeight(svgLabel, 16, 360) }, group: null, kind: note(svgLabel, 360) });
  // SVG: dropped from the sample file — the cards the importer produces.
  add({ id: next(), pos: { x: 1300, y: 180 }, size: { w: 100, h: 50 }, group: null, kind: { Shape: { shape: "rect", fill: "#ff0000" } } });
  add({ id: next(), pos: { x: 1465, y: 185 }, size: { w: 50, h: 50 }, group: null, kind: { Shape: { shape: "ellipse", fill: "#0000ff" } } });
  add({ id: next(), pos: { x: 1560, y: 195 }, size: { w: 60, h: 30 }, group: null, kind: { Shape: { shape: "ellipse", fill: "#00ff00", outline: true } } });
  add({ id: next(), pos: { x: 1300, y: 260 }, size: { w: 100, h: 1 }, group: null, kind: { Stroke: { points: [{ x: 1300, y: 260 }, { x: 1400, y: 260 }], color: "#000000", width: 2, marker: false } } });
  add({ id: next(), pos: { x: 1440, y: 260 }, size: { w: 40, h: 20 }, group: null, kind: { Stroke: { points: [{ x: 1440, y: 260 }, { x: 1460, y: 280 }, { x: 1480, y: 260 }], color: "#000000", width: 1, marker: false } } });
  add({ id: next(), pos: { x: 1500, y: 260 }, size: { w: 50, h: 50 }, group: null, kind: { Stroke: { points: [{ x: 1500, y: 260 }, { x: 1550, y: 260 }, { x: 1550, y: 310 }, { x: 1500, y: 260 }], color: "#0000ff", width: 2, marker: false } } });
  add({ id: next(), pos: { x: 1300, y: 320 }, size: { w: 136, h: 51 }, group: null, kind: { Text: { text: "Hello SVG", bold: false, size: 20, color: "#333333" } } });
  add({ id: next(), pos: { x: 1610, y: 260 }, size: { w: 40, h: 40 }, group: null, kind: { Shape: { shape: "rect", fill: "#ffd700" } } });
  const psdLabel = "PSD";
  add({ id: next(), pos: { x: 1700, y: 120 }, size: { w: 360, h: estimateTextHeight(psdLabel, 16, 360) }, group: null, kind: note(psdLabel, 360) });
  // PSD: dropped from the sample file — one FileCard.
  add({ id: next(), pos: { x: 1700, y: 180 }, size: { w: 360, h: 272 }, group: null, kind: { FileCard: { path: `${boardDir}/sample.psd`, size_bytes: psdSize, format: "psd", preview: `${boardDir}/welcome-psd-preview.png` } } });
  // Row 2: AI (left), 3D (right). Labels at y 492, cards at 552.
  const aiLabel = "AI";
  add({ id: next(), pos: { x: 1300, y: 492 }, size: { w: 360, h: estimateTextHeight(aiLabel, 16, 360) }, group: null, kind: note(aiLabel, 360) });
  // AI: dropped from the sample file — one FileCard.
  add({ id: next(), pos: { x: 1300, y: 552 }, size: { w: 360, h: 294 }, group: null, kind: { FileCard: { path: `${boardDir}/sample.ai`, size_bytes: aiSize, format: "ai", preview: `${boardDir}/welcome-ai-preview.png` } } });
  const glbLabel = "3D";
  add({ id: next(), pos: { x: 1700, y: 492 }, size: { w: 360, h: estimateTextHeight(glbLabel, 16, 360) }, group: null, kind: note(glbLabel, 360) });
  // GLB: dropped from the sample file — the cards the importer produces.
  add({ id: next(), pos: { x: 1700, y: 552 }, size: { w: 360, h: 300 }, group: null, kind: { Model3D: { path: `${boardDir}/welcome-cube.glb`, size_bytes: modelSize } } });
  b.next_group = 2;
  return b;
}
