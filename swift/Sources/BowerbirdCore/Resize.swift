/// Resizing an item, ported from the Electron app's
/// `resizeItem` (`model.ts`): the size is clamped to at
/// least 48×48, and a stroke's points (or a connector's
/// point anchors) scale with the item, relative to its
/// position — so the content stretches with the frame.
/// A connector has no resize handle, but the scaling rule
/// is the same if one is resized.
public enum BoardResize {
    /// The smallest size an item can be resized to, in
    /// world pixels, on either axis.
    public static let minimumSize: Double = 48

    /// Resizes the item. Returns false when the item does
    /// not exist (nothing changes).
    @discardableResult
    public static func resize(_ board: inout Board, id: Int, newW: Double, newH: Double) -> Bool {
        let w = max(minimumSize, newW)
        let h = max(minimumSize, newH)
        guard let index = board.items.firstIndex(where: { $0.id == id }) else { return false }
        var item = board.items[index]
        let ox = item.pos.x, oy = item.pos.y
        let ow = item.size.w, oh = item.size.h
        if case .stroke(var stroke) = item.kind, ow > 0, oh > 0 {
            let sx = w / ow, sy = h / oh
            stroke.points = stroke.points.map { Pt(x: ox + ($0.x - ox) * sx, y: oy + ($0.y - oy) * sy) }
            item.kind = .stroke(stroke)
        }
        if case .connector(var connector) = item.kind, ow > 0, oh > 0 {
            let sx = w / ow, sy = h / oh
            if case .point(let pt) = connector.from {
                connector.from = .point(Pt(x: ox + (pt.x - ox) * sx, y: oy + (pt.y - oy) * sy))
            }
            if case .point(let pt) = connector.to {
                connector.to = .point(Pt(x: ox + (pt.x - ox) * sx, y: oy + (pt.y - oy) * sy))
            }
            item.kind = .connector(connector)
        }
        item.size = Size(w: w, h: h)
        board.items[index] = item
        return true
    }
}
