import Foundation

/// Named boards: the files under the data root. Main lives
/// at `<dataRoot>/board.json`; every other board has a
/// folder, `<dataRoot>/boards/<sanitised>/`, holding its
/// board.json, a display-name.txt with the name the user
/// typed, and its assets, backups and journal. Switching
/// boards is the store's job (load the other board.json);
/// this owns the folders.
public struct Boards {
    public let paths: BoardPaths

    public init(paths: BoardPaths) {
        self.paths = paths
    }

    public struct Info {
        public let name: String
        public let displayName: String
        public let current: Bool
        public let items: Int
    }

    /// Every board that has a board.json: Main first, then
    /// the named boards in folder order.
    public func list(current: String?) -> [Info] {
        var result: [Info] = []
        let fileManager = FileManager.default
        let mainURL = paths.boardPath(for: nil)
        if fileManager.fileExists(atPath: mainURL.path) {
            result.append(Info(name: "Main", displayName: "Main", current: current == nil || current == "Main", items: itemCount(at: mainURL)))
        }
        let boardsDir = paths.dataRoot.appendingPathComponent("boards")
        guard let folders = try? fileManager.contentsOfDirectory(atPath: boardsDir.path) else { return result }
        for folder in folders.sorted() {
            let dir = boardsDir.appendingPathComponent(folder)
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { continue }
            let boardURL = dir.appendingPathComponent("board.json")
            guard fileManager.fileExists(atPath: boardURL.path) else { continue }
            let displayName = (try? String(contentsOf: dir.appendingPathComponent("display-name.txt"), encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? folder
            result.append(Info(name: folder, displayName: displayName, current: current == folder, items: itemCount(at: boardURL)))
        }
        return result
    }

    /// Create a named board: its folder, display-name.txt
    /// and an empty board.json. False when a board with
    /// that (sanitised) name already exists.
    @discardableResult
    public func create(name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let dir = paths.boardDir(for: trimmed)
        guard !FileManager.default.fileExists(atPath: dir.path) else { return false }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try trimmed.write(to: dir.appendingPathComponent("display-name.txt"), atomically: true, encoding: .utf8)
            let json = String(data: try BoardStore.emptyBoard().encode(), encoding: .utf8)!
            try json.write(to: dir.appendingPathComponent("board.json"), atomically: true, encoding: .utf8)
            return true
        } catch {
            try? FileManager.default.removeItem(at: dir)
            return false
        }
    }

    /// Rename a named board: its folder moves, and
    /// display-name.txt takes the new name. False when the
    /// old board does not exist or the new name is taken.
    /// Main cannot be renamed.
    @discardableResult
    public func rename(oldName: String, newName: String) -> Bool {
        guard oldName != "Main" else { return false }
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let from = paths.boardDir(for: oldName)
        let to = paths.boardDir(for: trimmed)
        guard FileManager.default.fileExists(atPath: from.path),
              !FileManager.default.fileExists(atPath: to.path) else { return false }
        do {
            try FileManager.default.moveItem(at: from, to: to)
            try trimmed.write(to: to.appendingPathComponent("display-name.txt"), atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    /// Delete a named board: its folder goes with it (board,
    /// assets, backups, journal). Main cannot be deleted —
    /// reset it instead.
    @discardableResult
    public func delete(name: String) -> Bool {
        guard name != "Main" else { return false }
        let dir = paths.boardDir(for: name)
        guard FileManager.default.fileExists(atPath: dir.path) else { return false }
        do {
            try FileManager.default.removeItem(at: dir)
            return true
        } catch {
            return false
        }
    }

    private func itemCount(at url: URL) -> Int {
        (try? Data(contentsOf: url)).flatMap { try? Board.decode(from: $0) }?.items.count ?? 0
    }
}
