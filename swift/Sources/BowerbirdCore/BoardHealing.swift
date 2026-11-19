import Foundation

/// Allocate the next item id: bump `next_id` first, so the
/// new id is always fresh.
public func allocId(_ board: inout Board) -> Int {
    board.nextId += 1
    return board.nextId
}

/// Heal duplicate item ids: `next_id` can lag behind the
/// highest id on a corrupt board, so it is raised first
/// (allocating from a stale `next_id` could hand out an id
/// already in use). The first occurrence of an id keeps it;
/// later duplicates get fresh ids. References keep pointing
/// at the first — a connector's `{"Item": id}` still names
/// the original card.
public func healDuplicateIds(_ board: inout Board) {
    for item in board.items {
        if item.id > board.nextId {
            board.nextId = item.id
        }
    }
    var seen = Set<Int>()
    for index in board.items.indices {
        if seen.contains(board.items[index].id) {
            board.items[index].id = allocId(&board)
        } else {
            seen.insert(board.items[index].id)
        }
    }
}
