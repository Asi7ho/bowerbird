/// Group and ungroup, the Electron app's Ctrl+G / Ctrl+U.
/// Grouping needs at least two items: they get a fresh id
/// from `nextGroup` (which bumps, so a later group can
/// never collide with it), and the group gets its label.
/// Ungrouping clears the group of every item in the groups
/// the given ids belong to — the whole group, not just the
/// selection. Both sync the labels, so a group that drops
/// below two members loses its entry.
public enum BoardGroup {
    public static func group(_ board: inout Board, ids: [Int]) -> Int? {
        guard ids.count >= 2 else { return nil }
        // next_group is the last allocated group, like
        // next_id (the Electron app's createGroup bumps
        // first) — taking it as-is would reuse the last
        // group's id.
        board.nextGroup += 1
        let id = board.nextGroup
        for index in board.items.indices where ids.contains(board.items[index].id) {
            board.items[index].group = id
        }
        syncGroupLabels(&board)
        return id
    }

    public static func ungroup(_ board: inout Board, ids: [Int]) -> Bool {
        let groups = Set(board.items.filter { ids.contains($0.id) }.compactMap { $0.group })
        guard !groups.isEmpty else { return false }
        for index in board.items.indices {
            if let group = board.items[index].group, groups.contains(group) {
                board.items[index].group = nil
            }
        }
        syncGroupLabels(&board)
        return true
    }
}
