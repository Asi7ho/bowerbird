// Pure board geometry helpers.

import type { Camera } from "bowerbird-plugin-api";
import { centre, itemRotation, rotatePoint, smoothStrokePath } from "../backend/model";
import type { Item, Pt, Size } from "../backend/model";

export function svgEl2(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// A stroke's SVG path string is rebuilt from its
// points on every render — and renderSvgOnly runs on
// every mousemove while dragging, so a few long strokes
// meant rebuilding thousands of coordinates per frame
// for strokes that had not moved. Cache it per item id:
// the key is the point count plus the first and last
// points, which is exactly what changes when a stroke
// is drawn (points appended) or moved (all points
// translated). There is no operation that rewrites
// middle points alone.
const strokePathCache = new Map<number, { key: string; d: string }>();
export function strokePath(item: Item, points: Pt[], color: string, width: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  const key = `${points.length}:${first.x},${first.y}:${last.x},${last.y}:${color}:${width}`;
  const hit = strokePathCache.get(item.id);
  if (hit && hit.key === key) return hit.d;
  const d = smoothStrokePath(points);
  strokePathCache.set(item.id, { key, d });
  return d;
}

const GROUP_PAD = 24;

// The bounding box of a set of items, or null when empty.
export function membersBounds(members: Item[], itemBounds: (item: Item) => [Pt, Size]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of members) {
    const [p, s] = itemBounds(it);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function groupBounds(members: Item[], itemBounds: (item: Item) => [Pt, Size]): { x: number; y: number; w: number; h: number } | null {
  const b = membersBounds(members, itemBounds);
  if (!b) return null;
  return { x: b.x - GROUP_PAD, y: b.y - GROUP_PAD, w: b.w + GROUP_PAD * 2, h: b.h + GROUP_PAD * 2 };
}

export function isRotatable(it: Item | undefined, isFrame: (it: Item | undefined) => boolean): boolean {
  if (!it || "Connector" in it.kind) return false;
  return !isFrame(it);
}

export function rotateHandleWorld(it: Item, cam: Camera): Pt {
  const c = centre(it);
  const top = { x: c.x, y: it.pos.y - 28 / cam.zoom };
  return rotatePoint(top, c, itemRotation(it));
}

export function normAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function rotateAngleFor(world: Pt, it: Item, shiftKey: boolean): number {
  const c = centre(it);
  let deg = Math.atan2(world.y - c.y, world.x - c.x) * 180 / Math.PI + 90;
  if (shiftKey) deg = Math.round(deg / 15) * 15;
  return normAngle(deg);
}
