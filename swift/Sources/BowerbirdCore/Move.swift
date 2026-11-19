/// Move items by a world delta: the item's position shifts,
/// and for a stroke its points shift too (the points are
/// absolute world coords, the position is their bbox min);
/// for a connector, a Point anchor shifts (an Item anchor
/// follows its item). The Electron app's moveSelection.
/// A drag moves every selected item by the same delta: the
/// live drag applies this to a copy for the display, and
/// the commit applies it to the board (one undo step).
public enum BoardMove {
    public static func move(_ board: inout Board, ids: Set<Int>, by delta: Pt) {
        for index in board.items.indices where ids.contains(board.items[index].id) {
            var item = board.items[index]
            item.pos = Pt(x: item.pos.x + delta.x, y: item.pos.y + delta.y)
            switch item.kind {
            case .stroke(var payload):
                payload.points = payload.points.map { Pt(x: $0.x + delta.x, y: $0.y + delta.y) }
                item.kind = .stroke(payload)
            case .connector(var payload):
                payload.from = shiftAnchor(payload.from, by: delta)
                payload.to = shiftAnchor(payload.to, by: delta)
                item.kind = .connector(payload)
            default:
                break
            }
            board.items[index] = item
        }
    }

    private static func shiftAnchor(_ anchor: Anchor, by delta: Pt) -> Anchor {
        if case .point(let pt) = anchor {
            return .point(Pt(x: pt.x + delta.x, y: pt.y + delta.y))
        }
        return anchor
    }
}
