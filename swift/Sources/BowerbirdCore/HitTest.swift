import Foundation

/// Geometric hit-testing: which item, if any, is under a
/// world point. Mirrors the Electron app's `itemHit`
/// (model.ts): a card is hit inside its bounds, a stroke
/// near its path, a connector near its line. The topmost
/// item wins, so the board is walked in reverse order.
/// Rotation is not handled yet — a rotated card is hit by
/// its unrotated box, which is generous but never misses
/// the card itself.
public enum HitTest {
    public static func hit(board: Board, at world: Pt) -> Item? {
        for item in board.items.reversed() {
            if hits(item: item, board: board, at: world) { return item }
        }
        return nil
    }

    private static func hits(item: Item, board: Board, at world: Pt) -> Bool {
        switch item.kind {
        case .shape(let shape):
            return hitsShape(shape, item: item, at: world)
        case .stroke(let stroke):
            // Near the path, within half the width (at
            // least 4 world units, so a thin stroke is
            // still clickable).
            return distanceToPolyline(stroke.points, world) <= max(stroke.width / 2, 4)
        case .connector(let payload):
            guard let (a, b) = ConnectorGeometry.clippedEnds(board: board, from: payload.from, to: payload.to) else { return false }
            return distanceToSegment(world, a, b) <= 4
        default:
            let b = CameraMath.itemBounds(board: board, item: item)
            return world.x >= b.x && world.x <= b.x + b.w
                && world.y >= b.y && world.y <= b.y + b.h
        }
    }

    /// A shape is hit inside the shape itself, not its
    /// bounding box: an ellipse's corners are empty, and
    /// the bird's parts overlap, so a box hit picks the
    /// wrong part. An outline shape is hit on its edge
    /// only (the Electron app's `itemHit` honours the
    /// `outline` flag).
    private static func hitsShape(_ shape: ShapePayload, item: Item, at world: Pt) -> Bool {
        let rect = WorldRect(x: item.pos.x, y: item.pos.y, w: item.size.w, h: item.size.h)
        if shape.outline == true {
            return distanceToShapeEdge(shape.shape, rect: rect, world) <= 4
        }
        switch shape.shape {
        case .rect:
            return world.x >= rect.x && world.x <= rect.x + rect.w
                && world.y >= rect.y && world.y <= rect.y + rect.h
        case .ellipse:
            let cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
            let rx = rect.w / 2, ry = rect.h / 2
            guard rx > 0, ry > 0 else { return false }
            let dx = (world.x - cx) / rx, dy = (world.y - cy) / ry
            return dx * dx + dy * dy <= 1
        default:
            guard let points = ShapeGeometry.polygonPoints(for: shape.shape, in: rect) else { return false }
            return pointInPolygon(world, points)
        }
    }

    /// The distance from a point to a shape's edge (its
    /// outline). Polygons and rects use their edges; an
    /// ellipse is sampled as a 32-gon.
    private static func distanceToShapeEdge(_ shape: ShapeKind, rect: WorldRect, _ p: Pt) -> Double {
        let points: [Pt]
        switch shape {
        case .rect:
            points = [
                Pt(x: rect.x, y: rect.y), Pt(x: rect.x + rect.w, y: rect.y),
                Pt(x: rect.x + rect.w, y: rect.y + rect.h), Pt(x: rect.x, y: rect.y + rect.h),
            ]
        case .ellipse:
            let cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
            let rx = rect.w / 2, ry = rect.h / 2
            points = (0..<32).map { i in
                let a = Double(i) / 32 * 2 * .pi
                return Pt(x: cx + rx * cos(a), y: cy + ry * sin(a))
            }
        default:
            guard let poly = ShapeGeometry.polygonPoints(for: shape, in: rect) else { return .infinity }
            points = poly
        }
        return distanceToPolyline(points + [points[0]], p)
    }

    /// Ray casting (even-odd): a point is inside a polygon
    /// when a ray from it crosses the boundary an odd
    /// number of times.
    private static func pointInPolygon(_ p: Pt, _ polygon: [Pt]) -> Bool {
        var inside = false
        var j = polygon.count - 1
        for i in 0..<polygon.count {
            let a = polygon[i], b = polygon[j]
            if (a.y > p.y) != (b.y > p.y) {
                let x = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)
                if p.x < x { inside.toggle() }
            }
            j = i
        }
        return inside
    }

    private static func distanceToPolyline(_ points: [Pt], _ p: Pt) -> Double {
        guard points.count >= 2 else {
            return points.first.map { hypot(p.x - $0.x, p.y - $0.y) } ?? .infinity
        }
        var best = Double.infinity
        for i in 0..<(points.count - 1) {
            best = min(best, distanceToSegment(p, points[i], points[i + 1]))
        }
        return best
    }

    private static func distanceToSegment(_ p: Pt, _ a: Pt, _ b: Pt) -> Double {
        let dx = b.x - a.x, dy = b.y - a.y
        let len2 = dx * dx + dy * dy
        var t: Double = 0
        if len2 > 0 {
            t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
        }
        return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    }
}
