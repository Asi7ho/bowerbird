import Foundation

/// The eraser, ported from the Electron app's `eraseAt`
/// (`board.ts`) and `strokesWithin` (`model.ts`): the
/// eraser removes every stroke its circle touches. A
/// stroke is touched when the eraser's centre is within
/// the eraser radius plus the stroke's half-width of the
/// stroke's path — the circle overlapping the visible
/// stroke. The board is not saved here: the drag saves
/// once, on mouseup, so a whole sweep is one undo step.
public enum BoardErase {
    /// The eraser's radius, in world pixels (the Electron
    /// app's ERASER_RADIUS).
    public static let radius: Double = 12

    /// The stroke ids whose path the eraser touches at
    /// this point.
    public static func strokesWithin(board: Board, at world: Pt, radius: Double = BoardErase.radius) -> [Int] {
        var out: [Int] = []
        for item in board.items {
            guard case .stroke(let stroke) = item.kind else { continue }
            let tolerance = radius + stroke.width / 2
            if distanceToPolyline(stroke.points, world) <= tolerance {
                out.append(item.id)
            }
        }
        return out
    }

    /// Removes every stroke the eraser touches at this
    /// point. Returns true when at least one stroke went.
    @discardableResult
    public static func erase(_ board: inout Board, at world: Pt, radius: Double = BoardErase.radius) -> Bool {
        let ids = Set(strokesWithin(board: board, at: world, radius: radius))
        guard !ids.isEmpty else { return false }
        board.items.removeAll { ids.contains($0.id) }
        return true
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
