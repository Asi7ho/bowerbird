import CryptoKit
import Foundation

/// The board store: one board on disk, held in memory. All
/// board mutation goes through here, so save, undo-adjacent
/// behaviour and the live-follow guard stay in one place.
///
/// Save order (mirrors the Electron app):
/// 1. the recovery journal is written first (the edit
///    survives a kill before the save lands);
/// 2. the live-follow guard refuses the save when the file
///    on disk changed since the app last read or wrote it
///    (an external writer changed it — overwriting would
///    lose that edit);
/// 3. the board is written via tmp + rename;
/// 4. a backup is made when the newest is over an hour old;
/// 5. the journal is cleared (the save landed).
///
/// `lastSavedJson` stays the RAW on-disk content, like the
/// Electron app's — the store never compares against its
/// own re-encoded board.
public final class BoardStore {
    public let boardURL: URL
    public let boardDir: URL
    public private(set) var board: Board

    /// The undo history for this board. Every content
    /// change recorded through `update` pushes the previous
    /// content as one step; a board switch, a reset or an
    /// external reload clears it.
    public let undoStore = UndoStore()

    private var lastSavedJson: String?
    private var lastSavedContentKey: String?
    private let journal: RecoveryJournal
    private let backups: Backups

    public static func emptyBoard() -> Board {
        Board(
            items: [],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 0,
            nextGroup: 0,
            groups: nil,
            bg: "#FFFFFF",
            grid: .dots
        )
    }

    /// Load the board at `boardURL` when it exists (decoded
    /// and healed), or start empty. The welcome board is
    /// seeded by the app (M2), not by the store.
    public init(boardURL: URL) throws {
        self.boardURL = boardURL
        self.boardDir = boardURL.deletingLastPathComponent()
        self.journal = RecoveryJournal(boardDir: boardDir)
        self.backups = Backups(boardDir: boardDir)
        if let raw = try? String(contentsOf: boardURL, encoding: .utf8),
           let data = raw.data(using: .utf8),
           let decoded = try? Board.decode(from: data) {
            var healed = decoded
            healDuplicateIds(&healed)
            syncGroupLabels(&healed)
            self.board = healed
            self.lastSavedJson = raw
            self.lastSavedContentKey = Self.contentKey(for: healed)
        } else {
            self.board = Self.emptyBoard()
            self.lastSavedJson = nil
            self.lastSavedContentKey = nil
        }
    }

    /// Reload the board from disk (an external change, or a
    /// restore the app performed on disk). Decodes and heals.
    /// The undo history is dropped: its snapshots belong to
    /// the board they were taken from.
    public func load() throws {
        let raw = try String(contentsOf: boardURL, encoding: .utf8)
        guard let data = raw.data(using: .utf8) else { throw BoardStoreError.unreadable }
        var decoded = try Board.decode(from: data)
        healDuplicateIds(&decoded)
        syncGroupLabels(&decoded)
        board = decoded
        lastSavedJson = raw
        lastSavedContentKey = Self.contentKey(for: decoded)
        undoStore.reset()
    }

    /// Apply a mutation to the board. The single entry point
    /// for board changes: when the undoable content changes
    /// (items, ids, groups, background, grid — not the
    /// camera), the content before the mutation becomes one
    /// undo step, so every edit is undoable without hunting
    /// for it.
    public func update(_ mutate: (inout Board) -> Void) {
        let before = BoardSnapshot(board: board)
        mutate(&board)
        if BoardSnapshot(board: board) != before {
            undoStore.recordChange(from: before)
        }
    }

    /// Undo one step: restore the top undo snapshot and
    /// save. False when there is nothing to undo.
    @discardableResult
    public func undo() -> Bool {
        guard let snapshot = undoStore.undo(current: BoardSnapshot(board: board)) else { return false }
        snapshot.apply(to: &board)
        return save()
    }

    /// Redo one step. False when there is nothing to redo.
    @discardableResult
    public func redo() -> Bool {
        guard let snapshot = undoStore.redo(current: BoardSnapshot(board: board)) else { return false }
        snapshot.apply(to: &board)
        return save()
    }

    /// Replace the whole board (a restore, a reset, a board
    /// switch). The caller saves. The undo history is
    /// dropped: it belongs to the board being replaced.
    public func replace(with board: Board) {
        self.board = board
        undoStore.reset()
    }

    /// A hash of the board's canonical encoding: items,
    /// next ids, groups, background and grid. Two boards
    /// with the same content have the same key.
    public static func contentKey(for board: Board) -> String? {
        guard let data = try? board.encode() else { return nil }
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    public var contentKey: String? {
        Self.contentKey(for: board)
    }

    /// Save the board to disk. A no-change save is a no-op.
    /// False when the save was refused (the file on disk
    /// changed since the app last read or wrote it) or the
    /// board is too large to write.
    @discardableResult
    public func save() -> Bool {
        guard let jsonData = try? board.encode(),
              let json = String(data: jsonData, encoding: .utf8) else { return false }
        if json.utf8.count > 50_000_000 { return false }
        if contentKey == lastSavedContentKey { return true }
        journal.write(boardJson: json)
        if let onDisk = try? String(contentsOf: boardURL, encoding: .utf8),
           let last = lastSavedJson, onDisk != last {
            lastSavedJson = onDisk
            return false
        }
        do {
            try FileManager.default.createDirectory(at: boardDir, withIntermediateDirectories: true)
            let tmp = boardURL.appendingPathExtension("tmp")
            try json.write(to: tmp, atomically: true, encoding: .utf8)
            try? FileManager.default.removeItem(at: boardURL)
            try FileManager.default.moveItem(at: tmp, to: boardURL)
        } catch {
            return false
        }
        lastSavedJson = json
        lastSavedContentKey = contentKey
        backups.maybeBackup(boardJson: json)
        journal.clear()
        return true
    }

    /// Synchronous flush for quit: write the board only if
    /// it changed since the last save. A board that did not
    /// change is not written, so the quit flush can never
    /// overwrite a restore with the stale board it replaced.
    @discardableResult
    public func saveSync() -> Bool {
        save()
    }

    /// Whether the recovery journal holds edits board.json
    /// does not. The comparison is against the file on disk,
    /// not the board in memory — after a refused save the
    /// journal and the memory hold the same edits, and the
    /// file is what lags behind.
    public func hasRecovery() -> Bool {
        let onDisk = lastSavedJson ?? (try? String(contentsOf: boardURL, encoding: .utf8))
        guard let onDisk else {
            // No board on disk: any valid journal holds edits.
            return journal.read() != nil
        }
        return journal.hasRecovery(comparedTo: onDisk)
    }

    /// Restore the journal's board into memory. The caller
    /// saves it, so the restore is one undo step.
    @discardableResult
    public func restoreRecovery() -> Bool {
        guard let entry = journal.read(),
              let data = entry.json.data(using: .utf8),
              var restored = try? Board.decode(from: data) else { return false }
        healDuplicateIds(&restored)
        undoStore.recordChange(from: BoardSnapshot(board: board))
        board = restored
        return true
    }

    /// Drop the recovery journal without restoring it.
    public func discardRecovery() {
        journal.clear()
    }

    public enum BoardStoreError: Error {
        case unreadable
    }
}
