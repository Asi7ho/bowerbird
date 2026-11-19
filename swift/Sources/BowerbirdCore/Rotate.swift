/// Rotating an item: setting its rotation in degrees.
/// The rotation is stored on the item (nil means 0), and
/// the card draws rotated around its centre.
public enum BoardRotate {
    /// Sets the item's rotation. Returns false when the
    /// item does not exist (nothing changes).
    @discardableResult
    public static func setRotation(_ board: inout Board, id: Int, rotation: Double) -> Bool {
        guard let index = board.items.firstIndex(where: { $0.id == id }) else { return false }
        board.items[index].rotation = rotation
        return true
    }
}
