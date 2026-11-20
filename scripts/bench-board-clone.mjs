// Micro-benchmark: the cost of the JSON deep copy that
// api.board.get() / getItem() used to do on every render
// and every drag move, against the live read that replaced
// it. Run: node scripts/bench-board-clone.mjs
// Builds a board like the 2,000-card mixed board (text,
// image, video, audio, 3D, strokes with long point arrays)
// and times a full-board clone, a single-stroke clone and
// the live read, each over many iterations.
function makeBoard(n) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 5;
    if (kind === 0) {
      // A stroke: a long points array is the expensive part.
      const points = [];
      for (let p = 0; p < 200; p++) points.push({ x: p, y: Math.sin(p / 10) * 20 });
      items.push({ id: i, kind: { Stroke: { points, color: "#1A1A1A", width: 2 } }, pos: { x: i * 10, y: i * 5 }, size: { w: 100, h: 50 }, rotation: 0, group: null });
    } else if (kind === 1) {
      items.push({ id: i, kind: { Text: { text: "A note with some text in it, long enough to matter.", fontSize: 14, bold: false, color: "#1A1A1A" } }, pos: { x: i * 10, y: i * 5 }, size: { w: 200, h: 100 }, rotation: 0, group: null });
    } else if (kind === 2) {
      items.push({ id: i, kind: { Image: { path: "media/img.png", w: 400, h: 300 } }, pos: { x: i * 10, y: i * 5 }, size: { w: 200, h: 150 }, rotation: 0, group: null });
    } else if (kind === 3) {
      items.push({ id: i, kind: { Model3D: { path: "media/model.glb" } }, pos: { x: i * 10, y: i * 5 }, size: { w: 200, h: 150 }, rotation: 0, group: null });
    } else {
      items.push({ id: i, kind: { Shape: { shape: "rect", fill: "#ff0000" } }, pos: { x: i * 10, y: i * 5 }, size: { w: 100, h: 100 }, rotation: 0, group: i % 10 === 0 ? 1 : null });
    }
  }
  return { id: 1, name: "Board", bg: "#FFFFFF", grid: "Dots", items, groups: {} };
}

function time(label, fn, iters) {
  // Warm up, then measure.
  for (let i = 0; i < 10; i++) fn();
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - start;
  console.log(`${label}: ${(ms / iters).toFixed(3)} ms per call (${iters} iterations)`);
  return ms / iters;
}

const board = makeBoard(2000);
const stroke = board.items[0];
const boardClone = time("board.get() — full-board JSON clone (2,000 items)", () => JSON.parse(JSON.stringify(board)), 50);
const strokeClone = time("board.getItem() — single-stroke JSON clone (200 points)", () => JSON.parse(JSON.stringify(stroke)), 200);
const liveBoard = time("board.getLive() — live board read", () => board, 10000);
const liveItem = time("board.getItemLive() — live item read", () => board.items.find((i) => i.id === 0), 10000);
console.log(`\nA render no longer pays the ${boardClone.toFixed(1)} ms full-board clone.`);
console.log(`A drag move no longer pays the ${strokeClone.toFixed(3)} ms stroke clone.`);
