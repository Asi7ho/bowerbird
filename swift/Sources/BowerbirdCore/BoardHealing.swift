import Foundation

/// Allocate the next item id: bump `next_id` first, so the
/// new id is always fresh.
public func allocId(_ board: inout Board) -> Int {
    board.nextId += 1
    return board.nextId
}

/// Give every group of two or more members a label when it
/// has none, and drop the label of a group with fewer than
/// two members. Mirrors the Electron app's `syncGroupLabels`
/// (main.ts), except the name: the Electron app calls a
/// group "Section N" and this app calls it "Group N" — a
/// group is a group. A group with no label entry is named
/// "Group N", and an existing default label ("Section N",
/// from the Electron app) is renamed to "Group N" so an old
/// board does not keep the old name. A custom label
/// (anything that is not "Section N") is left alone. The
/// label is data, not display — the renderer still hides it
/// for a live-import group (one with a source), which the
/// Electron app treats as a single imported piece, not a
/// named group.
public func syncGroupLabels(_ board: inout Board) {
    var counts: [Int: Int] = [:]
    for item in board.items {
        guard let group = item.group else { continue }
        counts[group, default: 0] += 1
    }
    var groups = board.groups ?? [:]
    for key in groups.keys where (counts[key] ?? 0) < 2 {
        groups.removeValue(forKey: key)
    }
    for key in groups.keys {
        guard let entry = groups[key] else { continue }
        // Rename a default "Section N" label to "Group N".
        // A custom label is left alone.
        let label = entry.label
        if label.hasPrefix("Section "),
           let number = Int(label.dropFirst("Section ".count)) {
            groups[key] = GroupEntry(label: "Group \(number)", source: entry.source)
        }
    }
    for (group, count) in counts where count >= 2 && groups[group] == nil {
        groups[group] = GroupEntry(label: "Group \(group)", source: nil)
    }
    board.groups = groups.isEmpty ? nil : groups
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
