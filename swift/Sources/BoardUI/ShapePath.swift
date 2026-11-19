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
    /// The fill path for a shape in a rect, or nil for rect
    /// (the card itself is the rect). The fractions live in
    /// the core (`ShapeGeometry`), shared with hit-testing.
    public static func path(for shape: ShapeKind, in rect: CGRect) -> CGPath? {
        switch shape {
        case .rect:
            return nil
        case .ellipse:
            return CGPath(ellipseIn: rect, transform: nil)
        default:
            guard let fractions = ShapeGeometry.polygonFractions(for: shape) else { return nil }
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
