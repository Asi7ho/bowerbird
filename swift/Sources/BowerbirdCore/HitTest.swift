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
