import Foundation

/// Freehand (lasso) selection: every item whose bounds
/// touch the loop (the Electron app's `lassoSelect` in
/// src/backend/model.ts). An item counts when its centre or
/// any corner is inside the loop, or when a loop edge
/// crosses its bounds — the same intersection semantics as
/// the rectangular marquee, so a long stroke crossing the
/// loop is selected, not just one whose centre happens to
/// fall inside it.
///
/// The interaction (drawing the loop) needs the select
/// tool's mode, which lands with the M3 toolbar; this is
/// the geometry it will call.
public enum LassoSelection {
    /// Whether a point is inside a polygon (ray casting).
    /// The loop is closed implicitly: the last point
    /// connects back to the first.
    public static func pointInPolygon(_ p: Pt, _ poly: [Pt]) -> Bool {
        var inside = false
        var j = poly.count - 1
        for i in 0..<poly.count {
            let a = poly[i], b = poly[j]
            if (a.y > p.y) != (b.y > p.y)
                && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
                inside.toggle()
            }
            j = i
        }
        return inside
    }

    public static func select(board: Board, points: [Pt]) -> [Int] {
        guard points.count >= 3 else { return [] }
        return board.items.filter { item in
            let bounds = CameraMath.itemBounds(board: board, item: item)
            let centre = Pt(x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2)
            if pointInPolygon(centre, points) { return true }
            let corners = [
                Pt(x: bounds.x, y: bounds.y),
                Pt(x: bounds.x + bounds.w, y: bounds.y),
                Pt(x: bounds.x, y: bounds.y + bounds.h),
                Pt(x: bounds.x + bounds.w, y: bounds.y + bounds.h),
            ]
            if corners.contains(where: { pointInPolygon($0, points) }) { return true }
            for i in 0..<points.count {
                let a = points[i], b = points[(i + 1) % points.count]
                if ConnectorGeometry.rectCrossing(from: a, to: b, pos: Pt(x: bounds.x, y: bounds.y), w: bounds.w, h: bounds.h, entry: true) != nil {
                    return true
                }
            }
            return false
        }.map { $0.id }
    }
}
