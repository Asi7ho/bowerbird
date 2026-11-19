import Foundation

/// Marquee selection: every item whose bounds intersect the
/// rectangle between two world points (the Electron app's
/// `marquee` in src/backend/model.ts). The rect is
/// normalised first, so the drag direction does not matter;
/// the rule is intersection, not containment, so a long
/// stroke crossing the rect is selected.
public enum MarqueeSelection {
    public static func select(board: Board, from a: Pt, to b: Pt) -> [Int] {
        let x0 = min(a.x, b.x), x1 = max(a.x, b.x)
        let y0 = min(a.y, b.y), y1 = max(a.y, b.y)
        return board.items.filter { item in
            let bounds = CameraMath.itemBounds(board: board, item: item)
            return bounds.x < x1 && bounds.x + bounds.w > x0
                && bounds.y < y1 && bounds.y + bounds.h > y0
        }.map { $0.id }
    }
}
