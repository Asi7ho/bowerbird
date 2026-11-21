// SVG import: parse an .svg file into board cards. Pure (no
// DOM/canvas), so unit-testable in Node. Hand-tokenised XML —
// a dependency would be heavier than the parser.

import type { Kind, Pt, ShapeKind } from "bowerbird-plugin-api";
import { estimateTextHeight } from "./model";
import type { ImportedItem } from "./import-types";

export type { ImportedItem };

// ---------------------------------------------------------------- XML

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (_m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const n = parseInt(body.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    }
    if (body.startsWith("#")) {
      const n = parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    }
    return ENTITIES[body] ?? _m;
  });
}

function parseXml(text: string): XmlNode | null {
  const root: XmlNode = { tag: "", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = text.length;
  const top = (): XmlNode => stack[stack.length - 1];
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      top().text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(text.slice(i, lt));
    i = lt;
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      top().text += end === -1 ? text.slice(i + 9) : text.slice(i + 9, end);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (text.startsWith("<!", i)) {
      // DOCTYPE and friends: skip to the closing >, honouring
      // an internal [...] subset, which may contain > itself.
      let depth = 0;
      let j = i + 2;
      while (j < n) {
        const c = text[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
        j++;
      }
      i = j >= n ? n : j + 1;
      continue;
    }
    if (text.startsWith("</", i)) {
      const end = text.indexOf(">", i + 2);
      if (end === -1) break;
      const name = text.slice(i + 2, end).trim().split(/\s+/)[0] ?? "";
      // Lenient close: pop up to the matching open tag, or
      // ignore a close with no match (malformed input).
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === name) { stack.length = s; break; }
      }
      i = end + 1;
      continue;
    }
    const end = text.indexOf(">", i + 1);
    if (end === -1) break;
    let inner = text.slice(i + 1, end);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const match = /^\s*([^\s/>]+)/.exec(inner);
    if (!match) { i = end + 1; continue; }
    const tag = match[1];
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(inner)) !== null) {
      attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    }
    const node: XmlNode = { tag, attrs, children: [], text: "" };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }
  return root.children.length > 0 ? root.children[0] : null;
}

// ---------------------------------------------------------------- colours

const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
  blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080",
  pink: "#ffc0cb", brown: "#a52a2a", cyan: "#00ffff", aqua: "#00ffff",
  magenta: "#ff00ff", fuchsia: "#ff00ff", lime: "#00ff00", navy: "#000080",
  teal: "#008080", olive: "#808000", maroon: "#800000", silver: "#c0c0c0",
  gray: "#808080", grey: "#808080", gold: "#ffd700", indigo: "#4b0082",
  violet: "#ee82ee", coral: "#ff7f50", salmon: "#fa8072", khaki: "#f0e68c",
  beige: "#f5f5dc", ivory: "#fffff0", crimson: "#dc143c", skyblue: "#87ceeb",
};

// A paint value to a #rrggbb hex, or null for none /
// transparent / fully transparent / unparseable.
export function parseSvgColor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "none" || v === "transparent" || v === "currentcolor") return null;
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return "#" + hex.split("").map((c) => c + c).join("");
    }
    if (/^[0-9a-f]{6}$/.test(hex)) return "#" + hex;
    if (/^[0-9a-f]{8}$/.test(hex)) {
      return hex.slice(6) === "00" ? null : "#" + hex.slice(0, 6);
    }
    return null;
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter((p) => p !== "");
    const channel = (s: string): number => {
      if (s.endsWith("%")) return Math.round((parseFloat(s) / 100) * 255);
      return Math.round(parseFloat(s));
    };
    if (parts.length >= 3) {
      const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
      if (a === 0) return null;
      const [r, g, b] = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
      if ([r, g, b].some((c) => !Number.isFinite(c))) return null;
      const hex = (c: number): string => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0");
      return "#" + hex(r) + hex(g) + hex(b);
    }
    return null;
  }
  return NAMED_COLORS[v] ?? null;
}

function parseOpacity(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

// ---------------------------------------------------------------- geometry

// 2D affine matrix [a, b, c, d, e, f]: x' = a*x + c*y + e,
// y' = b*x + d*y + f.
export type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatrix(m: Matrix, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

function parseTransform(raw: string | undefined): Matrix {
  if (!raw) return IDENTITY;
  let m: Matrix = IDENTITY;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const nums = match[2].split(/[\s,]+/).filter((s) => s !== "").map(Number).filter(Number.isFinite);
    const name = match[1];
    let t: Matrix | null = null;
    if (name === "translate" && nums.length >= 1) t = [1, 0, 0, 1, nums[0], nums[1] ?? 0];
    else if (name === "scale" && nums.length >= 1) t = [nums[0], 0, 0, nums[1] ?? nums[0], 0, 0];
    else if (name === "rotate" && nums.length >= 1) {
      const rad = (nums[0] * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
      t = nums.length >= 3
        ? multiplyMatrix(multiplyMatrix([1, 0, 0, 1, nums[1], nums[2]], rot), [1, 0, 0, 1, -nums[1], -nums[2]])
        : rot;
    } else if (name === "matrix" && nums.length >= 6) t = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
    else if (name === "skewX" && nums.length >= 1) t = [1, 0, Math.tan((nums[0] * Math.PI) / 180), 1, 0, 0];
    else if (name === "skewY" && nums.length >= 1) t = [1, Math.tan((nums[0] * Math.PI) / 180), 0, 1, 0, 0];
    if (t) m = multiplyMatrix(m, t);
  }
  return m;
}

// A length in user units. Units are stripped and treated as
// px (Illustrator/Figma/Inkscape all export px); a % has no
// meaning without a viewport here, so it reads as null.
function parseLength(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = raw.trim();
  if (v.endsWith("%")) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseLengthOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  if (v.endsWith("%")) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- paths

// Flatten an SVG path's `d` into polyline points. Curves are
// sampled (cubics 8 steps, quadratics 6, arcs every ~10°);
// a path that only moves, or has no drawable segment, gives
// an empty list. Absolute and relative commands both work.
export function flattenPathData(d: string): Pt[] {
  const tokens: string[] = [];
  const re = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) tokens.push(m[0]);
  const pts: Pt[] = [];
  let i = 0;
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let prevCubic: Pt | null = null;
  let prevQuad: Pt | null = null;
  const num = (): number => parseFloat(tokens[i++]);
  const push = (p: Pt): void => {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.001 || Math.abs(last.y - p.y) > 0.001) pts.push({ x: p.x, y: p.y });
  };
  const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt): void => {
    for (let s = 1; s <= 8; s++) {
      const t = s / 8, u = 1 - t;
      push({
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      });
    }
  };
  const quad = (p0: Pt, p1: Pt, p2: Pt): void => {
    for (let s = 1; s <= 6; s++) {
      const t = s / 6, u = 1 - t;
      push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y });
    }
  };
  const arc = (p0: Pt, rx0: number, ry0: number, rot: number, large: number, sweep: number, p1: Pt): void => {
    const rx = Math.abs(rx0), ry = Math.abs(ry0);
    if (rx === 0 || ry === 0 || (p0.x === p1.x && p0.y === p1.y)) { push(p1); return; }
    const phi = (rot * Math.PI) / 180;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
    const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    let rxs = rx, rys = ry;
    if (lambda > 1) { const s = Math.sqrt(lambda); rxs *= s; rys *= s; }
    const num2 = rxs * rxs * rys * rys - rxs * rxs * y1 * y1 - rys * rys * x1 * x1;
    const den = rxs * rxs * y1 * y1 + rys * rys * x1 * x1;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
    const cxp = (co * rxs * y1) / rys, cyp = (-co * rys * x1) / rxs;
    const cx = cos * cxp - sin * cyp + (p0.x + p1.x) / 2;
    const cy = sin * cxp + cos * cyp + (p0.y + p1.y) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number): number => {
      const dot = ux * vx + uy * vy;
      const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
      let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    const theta1 = angle(1, 0, (x1 - cxp) / rxs, (y1 - cyp) / rys);
    let dTheta = angle((x1 - cxp) / rxs, (y1 - cyp) / rys, (-x1 - cxp) / rxs, (-y1 - cyp) / rys);
    if (sweep === 0 && dTheta > 0) dTheta -= 2 * Math.PI;
    if (sweep === 1 && dTheta < 0) dTheta += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(dTheta) / (Math.PI / 18)));
    for (let s = 1; s <= steps; s++) {
      const t = theta1 + (dTheta * s) / steps;
      push({ x: cx + rxs * Math.cos(t) * cos - rys * Math.sin(t) * sin, y: cy + rxs * Math.cos(t) * sin + rys * Math.sin(t) * cos });
    }
  };
  let cmd = "";
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[A-Za-z]/.test(t)) { cmd = t; i++; } else if (cmd === "") { i++; continue; }
    const rel = cmd === cmd.toLowerCase() && cmd !== "z" && cmd !== "Z";
    const abs = (p: Pt): Pt => (rel ? { x: cur.x + p.x, y: cur.y + p.y } : p);
    switch (cmd.toUpperCase()) {
      case "M": {
        const p = abs({ x: num(), y: num() });
        cur = p; start = p; push(p);
        prevCubic = null; prevQuad = null;
        cmd = rel ? "l" : "L";
        break;
      }
      case "L": { cur = abs({ x: num(), y: num() }); push(cur); prevCubic = null; prevQuad = null; break; }
      case "H": { const x = num(); cur = { x: rel ? cur.x + x : x, y: cur.y }; push(cur); prevCubic = null; prevQuad = null; break; }
      case "V": { const y = num(); cur = { x: cur.x, y: rel ? cur.y + y : y }; push(cur); prevCubic = null; prevQuad = null; break; }
      case "C": {
        const p1 = abs({ x: num(), y: num() });
        const p2 = abs({ x: num(), y: num() });
        const p3 = abs({ x: num(), y: num() });
        cubic(cur, p1, p2, p3);
        prevCubic = p2; prevQuad = null; cur = p3;
        break;
      }
      case "S": {
        const p1 = prevCubic ? { x: 2 * cur.x - prevCubic.x, y: 2 * cur.y - prevCubic.y } : { ...cur };
        const p2 = abs({ x: num(), y: num() });
        const p3 = abs({ x: num(), y: num() });
        cubic(cur, p1, p2, p3);
        prevCubic = p2; prevQuad = null; cur = p3;
        break;
      }
      case "Q": {
        const p1 = abs({ x: num(), y: num() });
        const p2 = abs({ x: num(), y: num() });
        quad(cur, p1, p2);
        prevQuad = p1; prevCubic = null; cur = p2;
        break;
      }
      case "T": {
        const p1: Pt = prevQuad ? { x: 2 * cur.x - prevQuad.x, y: 2 * cur.y - prevQuad.y } : { ...cur };
        const p2 = abs({ x: num(), y: num() });
        quad(cur, p1, p2);
        prevQuad = p1; prevCubic = null; cur = p2;
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num();
        const large = num(), sweep = num();
        const p1 = abs({ x: num(), y: num() });
        arc(cur, rx, ry, rot, large, sweep, p1);
        prevCubic = null; prevQuad = null; cur = p1;
        break;
      }
      case "Z": { cur = start; push(cur); prevCubic = null; prevQuad = null; break; }
      default: i++;
    }
  }
  return pts;
}

// ---------------------------------------------------------------- elements

interface RawItem extends ImportedItem {
  // Text cards carry their font size separately while the
  // import is still in SVG units, so the final scale step
  // can shrink it with the card.
  fontSize?: number;
}

function shapeFill(a: XmlNode): { fill: string | null; outline: boolean } {
  const fill = parseSvgColor(a.attrs.fill ?? "#000000");
  const stroke = parseSvgColor(a.attrs.stroke);
  if (fill !== null && parseOpacity(a.attrs["fill-opacity"]) > 0) return { fill, outline: false };
  if (stroke !== null && parseOpacity(a.attrs["stroke-opacity"]) > 0) return { fill: stroke, outline: true };
  return { fill: null, outline: false };
}

function strokePaint(a: XmlNode): { color: string; width: number } | null {
  const stroke = parseSvgColor(a.attrs.stroke);
  const fill = parseSvgColor(a.attrs.fill);
  if (stroke !== null && parseOpacity(a.attrs["stroke-opacity"]) > 0) {
    return { color: stroke, width: Math.max(0.5, parseLength(a.attrs["stroke-width"], 1)) };
  }
  // A filled path with no stroke still has a visible edge:
  // draw it in its fill colour (an approximation, said so
  // in the module header).
  if (fill !== null && parseOpacity(a.attrs["fill-opacity"]) > 0) {
    return { color: fill, width: 2 };
  }
  return null;
}

function textContent(node: XmlNode): string {
  // tspans with their own x/y start a new line; inline
  // tspans (a bold word mid-sentence) just concatenate.
  const parts: string[] = [];
  const walk = (n: XmlNode): void => {
    if (n.text) parts.push(n.text);
    for (const c of n.children) {
      if (c.tag === "tspan" && (c.attrs.x !== undefined || c.attrs.y !== undefined) && parts.length > 0) parts.push("\n");
      walk(c);
    }
  };
  walk(node);
  return parts.join("").replace(/\s*\n\s*/g, "\n").trim();
}

function decodeDataUri(href: string): { name: string; data: Uint8Array } | null {
  const m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(href.trim());
  if (!m) return null;
  const ext = m[2] === "jpg" ? "jpeg" : m[2];
  try {
    const bin = atob(m[3]);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { name: `image.${ext}`, data };
  } catch {
    return null;
  }
}

function walkSvg(node: XmlNode, m: Matrix, out: RawItem[]): void {
  const tag = node.tag;
  if (tag === "defs" || tag === "title" || tag === "desc" || tag === "metadata" || tag === "style" || tag === "script" ||
    tag === "use" || tag === "clipPath" || tag === "mask" || tag === "pattern" || tag === "symbol") return;
  const local = parseTransform(node.attrs.transform);
  const mm = multiplyMatrix(m, local);
  if (parseOpacity(node.attrs.opacity) === 0) return;
  const a = node.attrs;
  if (tag === "g" || tag === "svg" || tag === "a") {
    for (const c of node.children) walkSvg(c, mm, out);
    return;
  }
  // Shape cards: rect / circle / ellipse.
  if (tag === "rect" || tag === "circle" || tag === "ellipse") {
    const { fill, outline } = shapeFill(node);
    if (fill === null) return;
    let x = 0, y = 0, w = 0, h = 0;
    if (tag === "rect") {
      x = parseLength(a.x, 0); y = parseLength(a.y, 0);
      w = parseLength(a.width, 0); h = parseLength(a.height, 0);
    } else if (tag === "circle") {
      const r = parseLength(a.r, 0);
      x = parseLength(a.cx, 0) - r; y = parseLength(a.cy, 0) - r; w = r * 2; h = r * 2;
    } else {
      const rx = parseLength(a.rx, 0), ry = parseLength(a.ry, 0);
      x = parseLength(a.cx, 0) - rx; y = parseLength(a.cy, 0) - ry; w = rx * 2; h = ry * 2;
    }
    if (w <= 0 || h <= 0) return;
    const corners = [applyMatrix(mm, { x, y }), applyMatrix(mm, { x: x + w, y }), applyMatrix(mm, { x, y: y + h }), applyMatrix(mm, { x: x + w, y: y + h })];
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const rotation = Math.abs(mm[1]) > 0.001 || Math.abs(mm[2]) > 0.001
      ? (Math.atan2(mm[1], mm[0]) * 180) / Math.PI : undefined;
    const shape: ShapeKind = tag === "rect" ? "rect" : "ellipse";
    const item: RawItem = {
      kind: { Shape: { shape, fill, ...(outline ? { outline: true } : {}) } },
      pos: { x: minX, y: minY },
      size: { w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) },
      ...(rotation !== undefined ? { rotation } : {}),
    };
    out.push(item);
    return;
  }
  // Stroke cards: line / polyline / polygon / path.
  if (tag === "line" || tag === "polyline" || tag === "polygon" || tag === "path") {
    const paint = strokePaint(node);
    if (!paint) return;
    let pts: Pt[] = [];
    if (tag === "line") {
      pts = [{ x: parseLength(a.x1, 0), y: parseLength(a.y1, 0) }, { x: parseLength(a.x2, 0), y: parseLength(a.y2, 0) }];
    } else if (tag === "polyline" || tag === "polygon") {
      const nums = (a.points ?? "").trim().split(/[\s,]+/).filter((s) => s !== "").map(Number).filter(Number.isFinite);
      for (let k = 0; k + 1 < nums.length; k += 2) pts.push({ x: nums[k], y: nums[k + 1] });
      if (tag === "polygon" && pts.length > 2) pts.push({ ...pts[0] });
    } else {
      pts = flattenPathData(a.d ?? "");
    }
    if (pts.length < 2) return;
    const moved = pts.map((p) => applyMatrix(mm, p));
    const xs = moved.map((p) => p.x), ys = moved.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    // Stroke points are absolute in SVG user units, like a
    // hand-drawn stroke's points are absolute in world
    // coords: pos is just their bounding-box min. The
    // renderer and hit-testing both read the points raw and
    // never add pos, so relative points would draw at the
    // origin.
    out.push({
      kind: { Stroke: { points: moved, color: paint.color, width: paint.width, marker: false } },
      pos: { x: minX, y: minY },
      size: { w: Math.max(1, Math.max(...xs) - minX), h: Math.max(1, Math.max(...ys) - minY) },
    });
    return;
  }
  // Text cards.
  if (tag === "text") {
    const text = textContent(node);
    if (!text) return;
    const fontSize = Math.max(8, parseLength(a["font-size"], 16));
    const color = parseSvgColor(a.fill ?? "#000000") ?? "#1A1A1A";
    const bold = (a["font-weight"] ?? "") === "bold" || parseInt(a["font-weight"] ?? "400", 10) >= 600;
    const lines = text.split("\n");
    const longest = Math.max(...lines.map((l) => l.length));
    const width = Math.min(480, Math.max(120, longest * fontSize * 0.6 + 28));
    const height = estimateTextHeight(text, fontSize, width);
    const x = parseLength(a.x, 0), y = parseLength(a.y, 0);
    const top = applyMatrix(mm, { x, y: y - fontSize });
    out.push({
      kind: { Text: { text, bold, size: fontSize, color } },
      pos: top,
      size: { w: width, h: height },
      fontSize,
    });
    return;
  }
  // Image cards: only data: URIs can be embedded (an
  // external href points at a file the board does not own).
  if (tag === "image") {
    const href = a.href ?? a["xlink:href"] ?? "";
    const decoded = decodeDataUri(href);
    if (!decoded) return;
    const w = parseLengthOrNull(a.width), h = parseLengthOrNull(a.height);
    if (w === null || h === null || w <= 0 || h <= 0) return;
    const top = applyMatrix(mm, { x: parseLength(a.x, 0), y: parseLength(a.y, 0) });
    out.push({
      kind: { Image: { path: "" } },
      pos: top,
      size: { w, h },
      embed: decoded,
    });
    return;
  }
}

// ---------------------------------------------------------------- entry

// Parse an SVG file's text into board cards placed at `origin`,
// scaled down to `maxWidth` if the artwork is wider. Returns
// an empty list for an unparseable file or one with no
// mappable elements (the caller falls back to a single
// Image card of the whole file).
export function parseSvgToItems(svgText: string, origin: Pt, maxWidth = 640): ImportedItem[] {
  const root = parseXml(svgText);
  if (!root || root.tag !== "svg") return [];
  const raw: RawItem[] = [];
  walkSvg(root, IDENTITY, raw);
  if (raw.length === 0) return [];
  // Union box of everything, in SVG user units.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of raw) {
    minX = Math.min(minX, it.pos.x); minY = Math.min(minY, it.pos.y);
    maxX = Math.max(maxX, it.pos.x + it.size.w); maxY = Math.max(maxY, it.pos.y + it.size.h);
  }
  const w = maxX - minX;
  const scale = w > maxWidth ? maxWidth / w : 1;
  const out: ImportedItem[] = raw.map((it) => {
    const kind: Kind = it.kind;
    if ("Stroke" in kind) {
      // Points are absolute in SVG units, so they translate
      // like pos does — never scale them in place as
      // relative offsets.
      kind.Stroke.points = kind.Stroke.points.map((p) => ({ x: origin.x + (p.x - minX) * scale, y: origin.y + (p.y - minY) * scale }));
      kind.Stroke.width = Math.max(1, kind.Stroke.width * scale);
    }
    if ("Text" in kind && it.fontSize !== undefined) {
      kind.Text.size = Math.max(8, Math.round(kind.Text.size * scale));
    }
    const { fontSize: _fontSize, ...rest } = it;
    void _fontSize;
    return {
      ...rest,
      kind,
      pos: { x: origin.x + (it.pos.x - minX) * scale, y: origin.y + (it.pos.y - minY) * scale },
      size: { w: Math.max(1, it.size.w * scale), h: Math.max(1, it.size.h * scale) },
    };
  });
  return out;
}
