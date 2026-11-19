/// Committing a drawn shape as a board item, ported from
/// the Electron app's pointerup (`board.ts`): a drag that
/// spans at least 10×10 world pixels becomes one Shape
/// item, at the drag's min corner, in the pen colour. A
/// smaller drag is a click, not a shape, and commits
/// nothing. The item is appended, so it lands on top of
/// the items it overlaps — the Electron app's rule for a
/// drawn shape (PR #53).
public enum BoardShape {
    /// The smallest drag that makes a shape, in world
    /// pixels, on both axes.
    public static let minimumSize: Double = 10

    /// Adds the shape to the board and returns the new
    /// item's id, or nil when the drag is smaller than
    /// the minimum (nothing is added).
    @discardableResult
    public static func add(
        _ board: inout Board,
        shape: ShapeKind,
        from: Pt,
        to: Pt,
        fill: String,
        outline: Bool
    ) -> Int? {
        let w = abs(to.x - from.x)
        let h = abs(to.y - from.y)
        guard w >= minimumSize, h >= minimumSize else { return nil }
        let pos = Pt(x: min(from.x, to.x), y: min(from.y, to.y))
        let id = board.nextId
        board.nextId += 1
        let payload = ShapePayload(shape: shape, fill: fill, outline: outline ? true : nil)
        board.items.append(Item(id: id, pos: pos, size: Size(w: w, h: h), group: nil, kind: .shape(payload), rotation: nil))
        return id
    }
}
