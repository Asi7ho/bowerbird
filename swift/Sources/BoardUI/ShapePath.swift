import AppKit
import BowerbirdCore

/// The shape's fill as a `CGPath` in a rect, mirroring the
/// Electron app's `SHAPE_POLYGONS` (model.ts) — the same
/// fractions, so a shape drawn in the Swift app is the same
/// shape as in the Electron app.
///
/// - rect: the card itself is the rect (no path needed);
///   the fill is the card's background.
/// - ellipse: a full ellipse in the rect.
/// - triangle / diamond / hexagon / star / arrow: the
///   polygon from the fractions, scaled to the rect.
public enum ShapePath {
    /// The polygon fractions for the polygonal shapes
    /// (fractions of the width/height, in order).
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

    /// The fill path for a shape in a rect, or nil for rect
    /// (the card itself is the rect).
    public static func path(for shape: ShapeKind, in rect: CGRect) -> CGPath? {
        switch shape {
        case .rect:
            return nil
        case .ellipse:
            return CGPath(ellipseIn: rect, transform: nil)
        default:
            guard let fractions = polygonFractions(for: shape) else { return nil }
            let path = CGMutablePath()
            for (index, fraction) in fractions.enumerated() {
                let point = CGPoint(x: rect.minX + CGFloat(fraction.0) * rect.width, y: rect.minY + CGFloat(fraction.1) * rect.height)
                if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            path.closeSubpath()
            return path
        }
    }
}
