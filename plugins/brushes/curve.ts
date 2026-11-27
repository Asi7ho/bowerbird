// The pressure curve: raw stylus pressure (0..1) to the
// pressure the stroke stores, as control points on a
// graph. The curve is baked in when the stroke is drawn:
// stored pressures are post-curve, so changing the curve
// restrokes nothing already on the board.
// A handle is an offset from its point, not an absolute
// position: dragging the point carries its handles with
// it, and a point with no handles is a plain point.
export interface CurveHandle {
  dx: number;
  dy: number;
}

export interface CurvePoint {
  x: number;
  y: number;
  // The control point after this point (out) and before
  // it (in), shaping the segment on that side. Absent
  // means a third of the way along the chord — the
  // straight line — so a stored curve without handles
  // draws exactly as it always did.
  out?: CurveHandle;
  in?: CurveHandle;
}

// A straight diagonal: pressure in, pressure out.
export const LINEAR_CURVE: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

export function copyCurve(curve: CurvePoint[]): CurvePoint[] {
  return curve.map((p) => {
    const q: CurvePoint = { x: p.x, y: p.y };
    if (p.out) q.out = { ...p.out };
    if (p.in) q.in = { ...p.in };
    return q;
  });
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// The old single exponent, clamped to the range the
// slider used to offer; NaN is linear.
export function clampExponent(exponent: number): number {
  if (!isFinite(exponent)) return 1;
  return Math.min(4, Math.max(0.25, exponent));
}

// The old single exponent, as points: the power curve
// sampled at five pressures. 1 is the diagonal.
export function curveFromExponent(exponent: number): CurvePoint[] {
  const e = clampExponent(exponent);
  if (e === 1) return copyCurve(LINEAR_CURVE);
  return [0, 0.25, 0.5, 0.75, 1].map((x) => ({ x, y: Math.pow(x, e) }));
}

// A handle from storage: finite offsets, no longer
// than the graph. A bad handle is dropped, not a reason
// to reject the whole curve — the point still draws.
function parseHandle(value: unknown): CurveHandle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { dx, dy } = value as Record<string, unknown>;
  if (typeof dx !== "number" || typeof dy !== "number" || !isFinite(dx) || !isFinite(dy)) return undefined;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return undefined;
  return { dx, dy };
}

// Points from storage: 2..8 points, x strictly rising
// 0..1, y 0..1. Null when the shape is wrong.
export function parseCurvePoints(value: unknown): CurvePoint[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) return null;
  const points: CurvePoint[] = [];
  for (const p of value) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const { x, y, out, in: inn } = p as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) return null;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    const point: CurvePoint = { x, y };
    const outHandle = parseHandle(out);
    if (outHandle) point.out = outHandle;
    const inHandle = parseHandle(inn);
    if (inHandle) point.in = inHandle;
    points.push(point);
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i].x <= points[i - 1].x) return null;
  }
  return points;
}

// The segment's control points: the stored handles, or a
// third along the chord when a handle is missing. Each
// control point's x is clamped between the anchors, so
// x(t) never runs backwards and the curve stays a
// function of pressure.
export function curveSegmentControls(a: CurvePoint, b: CurvePoint): [{ x: number; y: number }, { x: number; y: number }] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const c1 = { x: a.x + (a.out?.dx ?? dx / 3), y: a.y + (a.out?.dy ?? dy / 3) };
  const c2 = { x: b.x + (b.in?.dx ?? -dx / 3), y: b.y + (b.in?.dy ?? -dy / 3) };
  c1.x = Math.min(b.x, Math.max(a.x, c1.x));
  c2.x = Math.min(b.x, Math.max(a.x, c2.x));
  return [c1, c2];
}

function cubicCoord(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// The segment's height at pressure p, through the cubic:
// binary search on t, since x(t) only rises. The ends
// are exact: the search never lands on t = 1.
function cubicAt(a: CurvePoint, b: CurvePoint, p: number): number {
  if (p <= a.x) return a.y;
  if (p >= b.x) return b.y;
  const [c1, c2] = curveSegmentControls(a, b);
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const t = (lo + hi) / 2;
    if (cubicCoord(a.x, c1.x, c2.x, b.x, t) < p) lo = t; else hi = t;
  }
  const t = (lo + hi) / 2;
  return clamp01(cubicCoord(a.y, c1.y, c2.y, b.y, t));
}

// Between the points, straight where no handle bends it,
// cubic where one does: input pressure to stored
// pressure, clamped to 0..1.
export function applyCurve(pressure: number, curve: CurvePoint[]): number {
  const p = clamp01(pressure);
  if (curve.length === 0) return p;
  if (p <= curve[0].x) return curve[0].y;
  for (let i = 1; i < curve.length; i++) {
    if (p <= curve[i].x) {
      const a = curve[i - 1], b = curve[i];
      // No handles on either side: the straight line,
      // exactly as before — an untouched curve is untouched.
      if (!a.out && !b.in) {
        const t = (p - a.x) / (b.x - a.x);
        return a.y + t * (b.y - a.y);
      }
      return cubicAt(a, b, p);
    }
  }
  return curve[curve.length - 1].y;
}
