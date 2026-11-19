import Foundation

/// The recovery journal: a write-ahead copy of the board, so
/// an edit that reached the app but never landed in
/// board.json — the app was killed or crashed, or the save
/// was refused by the live-follow guard — survives to the
/// next launch, where the app offers to restore it.
///
/// One file next to the board, `recovery.json`:
/// `{"savedAt": <epoch ms>, "board": <the board>}`. It is
/// written (tmp + rename) before every save, and cleared
/// once that save lands — so it only ever holds edits
/// board.json does not. A journal whose content equals
/// board.json is stale, never an offer: a kill between the
/// save and the clear leaves exactly that.
///
/// Per board folder, like backups. Never exported, never
/// backed up.
public struct RecoveryJournal {
    private static let maxBytes = 50_000_000
    public let path: URL

    public init(boardDir: URL) {
        self.path = boardDir.appendingPathComponent("recovery.json")
    }

    public struct Entry {
        /// The canonical board JSON (decoded and re-encoded,
        /// so two writes of the same board compare equal).
        public let json: String
        public let savedAt: Int
    }

    private struct JournalFile: Codable {
        var savedAt: Int
        var board: Board
    }

    /// Write the journal for a board JSON string. Returns
    /// false (never throws) when the content is not a board,
    /// is too large, or the write fails — a journal that
    /// cannot be written must never break the save it
    /// precedes.
    @discardableResult
    public func write(boardJson: String) -> Bool {
        guard boardJson.utf8.count <= Self.maxBytes else { return false }
        guard let boardData = boardJson.data(using: .utf8),
              let board = try? Board.decode(from: boardData) else { return false }
        let file = JournalFile(savedAt: Int(Date().timeIntervalSince1970 * 1000), board: board)
        guard let data = try? JSONEncoder().encode(file) else { return false }
        do {
            try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
            let tmp = path.appendingPathExtension("tmp")
            try data.write(to: tmp, options: .atomic)
            try? FileManager.default.removeItem(at: path)
            try FileManager.default.moveItem(at: tmp, to: path)
            return true
        } catch {
            return false
        }
    }

    /// Read the journal, or nil when there is none or it is
    /// not a valid board. The returned json is the canonical
    /// board JSON, so it compares equal to a save of the
    /// same board.
    public func read() -> Entry? {
        guard let data = try? Data(contentsOf: path),
              let file = try? JSONDecoder().decode(JournalFile.self, from: data),
              let jsonData = try? file.board.encode(),
              let json = String(data: jsonData, encoding: .utf8) else { return nil }
        return Entry(json: json, savedAt: file.savedAt)
    }

    /// Whether the journal holds edits board.json does not:
    /// a journal exists, is valid, and its content differs
    /// from the board's canonical JSON.
    public func hasRecovery(comparedTo boardJson: String) -> Bool {
        guard let entry = read(),
              let boardData = boardJson.data(using: .utf8),
              let board = try? Board.decode(from: boardData),
              let canonicalData = try? board.encode(),
              let canonical = String(data: canonicalData, encoding: .utf8) else { return false }
        return entry.json != canonical
    }

    /// Drop the journal (once its save has landed). Ignores
    /// errors: a missing journal is already clear.
    public func clear() {
        try? FileManager.default.removeItem(at: path)
    }
}
