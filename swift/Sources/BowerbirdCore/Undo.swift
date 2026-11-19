import Foundation

/// A snapshot of the board content that undo restores:
/// items, next ids, groups, background and grid (the
/// Electron app's UndoState, minus the selection, which
/// the viewport owns). The camera is not undoable — a pan
/// or zoom is saved, not undone — so it is not in the
/// snapshot, and a camera-only change never becomes an
/// undo step.
public struct BoardSnapshot: Equatable {
    public var items: [Item]
    public var nextId: Int
    public var nextGroup: Int
    public var groups: [Int: GroupEntry]?
    public var bg: String
    public var grid: Grid

    public init(board: Board) {
        items = board.items
        nextId = board.nextId
        nextGroup = board.nextGroup
        groups = board.groups
        bg = board.bg
        grid = board.grid
    }

    /// Write the snapshot back into a board, keeping the
    /// board's camera (which undo never touches).
    public func apply(to board: inout Board) {
        board.items = items
        board.nextId = nextId
        board.nextGroup = nextGroup
        board.groups = groups
        board.bg = bg
        board.grid = grid
    }
}

/// Undo and redo as snapshots, not operations (the
/// Electron app's undo.ts): every content change pushes
/// the previous content as one undo step, so every
/// mutation is undoable without hunting for it.
public final class UndoStore {
    private var undoStack: [BoardSnapshot] = []
    private var redoStack: [BoardSnapshot] = []

    public init() {}

    public var canUndo: Bool { !undoStack.isEmpty }
    public var canRedo: Bool { !redoStack.isEmpty }

    /// Record a change: the content before the mutation
    /// becomes one undo step, and the redo stack is
    /// cleared — a new edit forks the history.
    public func recordChange(from old: BoardSnapshot) {
        undoStack.append(old)
        redoStack.removeAll()
    }

    /// Undo: the current content becomes a redo step, and
    /// the top undo snapshot is returned to restore. Nil
    /// when there is nothing to undo.
    public func undo(current: BoardSnapshot) -> BoardSnapshot? {
        guard let snapshot = undoStack.popLast() else { return nil }
        redoStack.append(current)
        return snapshot
    }

    /// Redo: the current content becomes an undo step, and
    /// the top redo snapshot is returned to restore. Nil
    /// when there is nothing to redo.
    public func redo(current: BoardSnapshot) -> BoardSnapshot? {
        guard let snapshot = redoStack.popLast() else { return nil }
        undoStack.append(current)
        return snapshot
    }

    /// Drop the whole history (a board switch, a reset, an
    /// external reload — the snapshots belong to the board
    /// they were taken from).
    public func reset() {
        undoStack.removeAll()
        redoStack.removeAll()
    }
}
