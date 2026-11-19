import Foundation

/// The shape geometry, mirroring the Electron app's
/// `SHAPE_POLYGONS` (model.ts) — the same fractions, so a
/// shape drawn or hit-tested in the Swift app is the same
/// shape as in the Electron app. Fractions of the width
/// and height, in order, y down.
public enum ShapeGeometry {
    public static func polygonFractions(for shape: ShapeKind) -> [(Double, Double)]? {
        switch shape {
        case .triangle: return [(0.5, 0), (1, 1), (0, 1)]
        case .diamond: return [(0.5, 0), (1, 0.5), (0.5, 1), (0, 0.5)]
        case .hexagon: return [(0.25, 0), (0.75, 0), (1, 0.5), (0.75, 1), (0.25, 1), (0, 0.5)]
        case .star: return [(0.5, 0), (0.61, 0.35), (0.98, 0.35), (0.68, 0.57), (0.79, 0.91), (0.5, 0.7), (0.21, 0.91), (0.32, 0.57), (0.02, 0.35), (0.39, 0.35)]
        case .arrow: return [(0, 0.4), (0.6, 0.4), (0.6, 0.15), (1, 0.5), (0.6, 0.85), (0.6, 0.6), (0, 0.6)]
        case .rect, .ellipse: return nil
        }
    }

    /// The polygon's points, scaled to a rect.
    public static func polygonPoints(for shape: ShapeKind, in rect: WorldRect) -> [Pt]? {
        guard let fractions = polygonFractions(for: shape) else { return nil }
        return fractions.map { Pt(x: rect.x + $0.0 * rect.w, y: rect.y + $0.1 * rect.h) }
    }
}
