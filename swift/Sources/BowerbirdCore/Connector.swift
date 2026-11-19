import Foundation

/// Committing a drawn connector as a board item, ported
/// from the Electron app's pointerup (`board.ts`): a drag
/// from one anchor to another becomes one Connector item.
/// Its position and size are the bbox of the two anchor
/// points (at least 1×1, the `rectFromPoints` rule). A
/// connector from a card to itself is a click, not a
/// connection, and a point target less than 4 world pixels
/// from the source anchor is a click too — both commit
/// nothing, so they never leave a 1×1 invisible item that
/// can only be removed by undo.
public enum BoardConnector {
    /// The smallest gap between the source anchor and a
    /// point target that still makes a connector, in world
    /// pixels.
    public static let minimumLength: Double = 4

    /// Adds the connector to the board and returns the new
    /// item's id, or nil when it is degenerate or a
    /// self-connector (nothing is added).
    @discardableResult
    public static func add(
        _ board: inout Board,
        from: Anchor,
        to: Anchor,
        color: String
    ) -> Int? {
        guard let a = CameraMath.anchorPoint(board: board, anchor: from),
              let b = CameraMath.anchorPoint(board: board, anchor: to) else { return nil }
        if case .point = to, hypot(a.x - b.x, a.y - b.y) < minimumLength { return nil }
        if case .item(let fromId) = from, case .item(let toId) = to, fromId == toId { return nil }
        let pos = Pt(x: min(a.x, b.x), y: min(a.y, b.y))
        let size = Size(w: max(1, abs(b.x - a.x)), h: max(1, abs(b.y - a.y)))
        let id = board.nextId
        board.nextId += 1
        board.items.append(Item(id: id, pos: pos, size: size, group: nil, kind: .connector(ConnectorPayload(from: from, to: to, color: color)), rotation: nil))
        return id
    }
}
