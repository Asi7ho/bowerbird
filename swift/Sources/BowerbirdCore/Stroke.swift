/// Committing a drawn stroke as a board item, ported from
/// the Electron app's pointerup (`board.ts`): a stroke that
/// drew at least two points becomes one Stroke item. Its
/// position is the points' bbox min and its size the bbox
/// (at least 1×1, so a straight line still has a size);
/// the points stay absolute world coordinates, and `pos`
/// is their bbox min — the stroke contract from the SVG
/// importer. A click that never moved is a single point
/// and commits nothing.
public enum BoardStroke {
    /// Adds the stroke to the board and returns the new
    /// item's id, or nil when the stroke has fewer than
    /// two points (nothing is added).
    @discardableResult
    public static func add(
        _ board: inout Board,
        points: [Pt],
        color: String,
        width: Double,
        marker: Bool,
        pencil: Bool?,
        pressures: [Double]?
    ) -> Int? {
        guard points.count >= 2 else { return nil }
        let xs = points.map(\.x), ys = points.map(\.y)
        let pos = Pt(x: xs.min() ?? 0, y: ys.min() ?? 0)
        let size = Size(
            w: max(1, (xs.max() ?? 0) - pos.x),
            h: max(1, (ys.max() ?? 0) - pos.y)
        )
        // next_id is the last allocated id (the Electron
        // app's allocId bumps first), so a fresh id comes
        // from allocId — taking next_id as-is would hand
        // out an id already in use on any board the
        // Electron app wrote (the welcome board's
        // next_id 48 is the 3D cube's id).
        let id = allocId(&board)
        let stroke = StrokePayload(
            points: points,
            color: color,
            width: width,
            marker: marker,
            pressures: pressures,
            pencil: pencil
        )
        board.items.append(Item(id: id, pos: pos, size: size, group: nil, kind: .stroke(stroke), rotation: nil))
        return id
    }
}
