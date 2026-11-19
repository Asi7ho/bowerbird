import Foundation

/// Connector geometry, ported from `src/backend/model.ts`
/// (`rectCrossing`, `clippedEnds`): a connector is drawn
/// from the edge of its source card to the edge of its
/// target card, not from centre to centre.
public enum ConnectorGeometry {
    /// The point where the segment from `from` to `to`
    /// crosses the rect at `pos` sized `w`×`h`. `entry`
    /// returns the entry point, otherwise the exit point.
    /// Nil when the segment never meets the rect.
    public static func rectCrossing(from: Pt, to: Pt, pos: Pt, w: Double, h: Double, entry: Bool) -> Pt? {
        let dx = to.x - from.x
        let dy = to.y - from.y
        var t0 = 0.0
        var t1 = 1.0
        for (origin, delta, lo, hi) in [(from.x, dx, pos.x, pos.x + w), (from.y, dy, pos.y, pos.y + h)] {
            if abs(delta) < 1e-9 {
                if origin < lo || origin > hi { return nil }
            } else {
                var ta = (lo - origin) / delta
                var tb = (hi - origin) / delta
                if ta > tb { swap(&ta, &tb) }
                t0 = max(t0, ta)
                t1 = min(t1, tb)
                if t0 > t1 { return nil }
            }
        }
        let t = entry ? t0 : t1
        guard t >= 0, t <= 1 else { return nil }
        return Pt(x: from.x + dx * t, y: from.y + dy * t)
    }

    /// The connector's drawn ends: the raw anchor points,
    /// clipped to the edge of the card each anchor points
    /// at (a point anchor is used as-is). Nil when either
    /// anchor cannot be resolved.
    public static func clippedEnds(board: Board, from: Anchor, to: Anchor) -> (Pt, Pt)? {
        guard let aRaw = CameraMath.anchorPoint(board: board, anchor: from),
              let bRaw = CameraMath.anchorPoint(board: board, anchor: to) else { return nil }
        var a = aRaw
        var b = bRaw
        if case .item(let id) = from,
           let item = board.items.first(where: { $0.id == id }),
           let p = rectCrossing(from: aRaw, to: bRaw, pos: item.pos, w: item.size.w, h: item.size.h, entry: false) {
            a = p
        }
        if case .item(let id) = to,
           let item = board.items.first(where: { $0.id == id }),
           let p = rectCrossing(from: aRaw, to: bRaw, pos: item.pos, w: item.size.w, h: item.size.h, entry: true) {
            b = p
        }
        return (a, b)
    }
}
