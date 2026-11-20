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
    /// A pencil stroke gets graphite grain: each point
    /// nudged by a small deterministic noise, a fraction
    /// of the stroke width, so the smoothed path reads as
    /// graphite instead of a clean vector line. The nudge
    /// is seeded by the point index, so it is stable
    /// across renders — and it is geometry, not a filter,
    /// so it scales with the zoom and cannot break the
    /// layer's rendering.
    public static func path(for points: [Pt], pencil: Bool = false, width: Double = 0) -> CGPath? {
        guard points.count >= 2 else { return nil }
        let minX = points.map(\.x).min() ?? 0
        let minY = points.map(\.y).min() ?? 0
        var local = points.map { Pt(x: $0.x - minX, y: $0.y - minY) }
        if pencil {
            local = pencilled(local, width: width)
        }
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

    /// A pencil stroke's points with graphite grain: each
    /// point nudged by a small deterministic noise, a
    /// fraction of the stroke width. The nudge is seeded
    /// by the point index (a hash in [-1, 1] per axis), so
    /// it is the same every render and every zoom.
    private static func pencilled(_ points: [Pt], width: Double) -> [Pt] {
        let magnitude = width * 0.35
        guard magnitude > 0 else { return points }
        return points.enumerated().map { index, point in
            Pt(
                x: point.x + hashNoise(index: index, salt: 0) * magnitude,
                y: point.y + hashNoise(index: index, salt: 1) * magnitude
            )
        }
    }

    /// A deterministic hash in [-1, 1] for a point index
    /// and a salt (so x and y differ).
    private static func hashNoise(index: Int, salt: Int) -> Double {
        var h = UInt64(index &* 2654435761) ^ UInt64(salt &* 40503) ^ 0x9E3779B97F4A7C15
        h = (h ^ (h >> 30)) &* 0xBF58476D1CE4E5B9
        h = (h ^ (h >> 27)) &* 0x94D049BB133111EB
        h = h ^ (h >> 31)
        return Double(h % 2000) / 1000.0 - 1.0
    }

    /// Half the widest the stroke reaches past its points
    /// (the pad the card needs so the stroke is not clipped).
    public static func pad(for width: Double) -> Double {
        ceil(width / 2) + 1
    }
}
