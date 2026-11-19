import Foundation

/// Backups: a full snapshot of one board at a moment — its
/// board.json plus its assets (copied, not linked, so a later
/// asset delete cannot break the snapshot). Backups live in
/// the board's own folder, under `backups/`, so switching
/// boards switches backup lists, and deleting a board
/// deletes its backups with it. They are made at most once
/// an hour on save, plus unconditionally before a reset or a
/// restore (so restoring never loses the current board).
/// Only the newest 10 are kept; older ones are pruned.
public struct Backups {
    public let boardDir: URL
    private static let maxKept = 10
    private static let hourlyInterval: TimeInterval = 3600

    public init(boardDir: URL) {
        self.boardDir = boardDir
    }

    public struct Entry {
        public let name: String
        public let items: Int
        public let size: Int
        public let mtimeMs: Int
    }

    private var backupsDir: URL {
        boardDir.appendingPathComponent("backups")
    }

    private func stamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return formatter.string(from: Date())
    }

    /// The backups, newest first.
    public func list() -> [Entry] {
        let fileManager = FileManager.default
        guard let names = try? fileManager.contentsOfDirectory(atPath: backupsDir.path) else { return [] }
        var entries: [Entry] = []
        for name in names.sorted().reversed() {
            let dir = backupsDir.appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { continue }
            let boardURL = dir.appendingPathComponent("board.json")
            let items = (try? Data(contentsOf: boardURL)).flatMap { try? Board.decode(from: $0) }?.items.count ?? 0
            let attributes = try? fileManager.attributesOfItem(atPath: dir.path)
            let mtime = (attributes?[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)
            entries.append(Entry(name: name, items: items, size: dirSize(dir), mtimeMs: Int(mtime.timeIntervalSince1970 * 1000)))
        }
        return entries
    }

    /// Make a backup when the newest one is over an hour old
    /// (or there is none). The hourly gate for saves.
    public func maybeBackup(boardJson: String) {
        if let newest = list().first,
           Date().timeIntervalSince1970 * 1000 - Double(newest.mtimeMs) < Self.hourlyInterval * 1000 {
            return
        }
        _ = makeBackup(boardJson: boardJson)
    }

    /// Make a backup unconditionally (before a reset or a
    /// restore). Returns the backup's name, or nil when the
    /// write failed.
    @discardableResult
    public func makeBackup(boardJson: String) -> String? {
        let fileManager = FileManager.default
        let name = stamp()
        let dest = backupsDir.appendingPathComponent(name)
        do {
            try fileManager.createDirectory(at: dest, withIntermediateDirectories: true)
            try boardJson.write(to: dest.appendingPathComponent("board.json"), atomically: true, encoding: .utf8)
            let assets = boardDir.appendingPathComponent("assets")
            if fileManager.fileExists(atPath: assets.path) {
                try copyDirectory(assets, to: dest.appendingPathComponent("assets"))
            }
            prune()
            return name
        } catch {
            try? fileManager.removeItem(at: dest)
            return nil
        }
    }

    /// Restore a backup: replace the board's assets with the
    /// backup's, and return the backup's board. The caller
    /// saves it, so the restore is one undo step.
    public func restore(name: String) -> Board? {
        let fileManager = FileManager.default
        let source = backupsDir.appendingPathComponent(name)
        let boardURL = source.appendingPathComponent("board.json")
        guard let data = try? Data(contentsOf: boardURL),
              let board = try? Board.decode(from: data) else { return nil }
        let assets = boardDir.appendingPathComponent("assets")
        let backupAssets = source.appendingPathComponent("assets")
        do {
            try? fileManager.removeItem(at: assets)
            if fileManager.fileExists(atPath: backupAssets.path) {
                try copyDirectory(backupAssets, to: assets)
            }
            return board
        } catch {
            return nil
        }
    }

    private func prune() {
        let fileManager = FileManager.default
        for entry in list().dropFirst(Self.maxKept) {
            try? fileManager.removeItem(at: backupsDir.appendingPathComponent(entry.name))
        }
    }

    private func copyDirectory(_ source: URL, to dest: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: dest, withIntermediateDirectories: true)
        for name in try fileManager.contentsOfDirectory(atPath: source.path) {
            let from = source.appendingPathComponent(name)
            let to = dest.appendingPathComponent(name)
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: from.path, isDirectory: &isDir), isDir.boolValue {
                try copyDirectory(from, to: to)
            } else {
                try fileManager.copyItem(at: from, to: to)
            }
        }
    }

    private func dirSize(_ url: URL) -> Int {
        let fileManager = FileManager.default
        var total = 0
        guard let enumerator = fileManager.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        for case let file as URL in enumerator {
            total += (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        }
        return total
    }
}
