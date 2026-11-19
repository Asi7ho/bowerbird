import AppKit
import BowerbirdCore

/// The smooth stroke path, ported from `smoothStrokePath`
/// (model.ts): a Catmull-Rom spline through the points,
/// drawn as cubic Bezier segments. The same control points,
/// so a stroke drawn in the Swift app is the same curve as
/// in the Electron app.
///
/// The points are absolute world coordinates; the path is
/// rebased by the points' own bounding box (never by
/// `item.pos`), and returned in the card's local space —
/// the caller places the layer at the item's position.
public enum StrokePath {
    /// The smoothed path for a stroke's points, in local
    /// coordinates (each point minus the points' bbox min).
    public static func path(for points: [Pt]) -> CGPath? {
        guard points.count >= 2 else { return nil }
        let minX = points.map(\.x).min() ?? 0
        let minY = points.map(\.y).min() ?? 0
        let local = points.map { Pt(x: $0.x - minX, y: $0.y - minY) }
        let path = CGMutablePath()
        path.move(to: CGPoint(x: local[0].x, y: local[0].y))
        if local.count == 2 {
            path.addLine(to: CGPoint(x: local[1].x, y: local[1].y))
            return path
        }
        let n = local.count
        for i in 0..<(n - 1) {
            let p0 = local[max(i - 1, 0)]
            let p1 = local[i]
            let p2 = local[i + 1]
            let p3 = local[min(i + 2, n - 1)]
            let c1 = Pt(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6)
            let c2 = Pt(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6)
            path.addCurve(
                to: CGPoint(x: p2.x, y: p2.y),
                control1: CGPoint(x: c1.x, y: c1.y),
                control2: CGPoint(x: c2.x, y: c2.y)
            )
        }
        return path
    }

    /// Half the widest the stroke reaches past its points
    /// (the pad the card needs so the stroke is not clipped).
    public static func pad(for width: Double) -> Double {
        ceil(width / 2) + 1
    }
}
