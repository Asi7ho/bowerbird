import Foundation

/// Where a board's files live on disk. Mirrors the Electron
/// app's layout (see electron/main.ts), with the macOS data
/// root in place of the XDG one:
///
///   <dataRoot>/board.json            — Main, the default board
///   <dataRoot>/boards/<sanitised>/   — every other board:
///     board.json, display-name.txt, assets/, backups/,
///     library/, recovery.json, context-index.json
///
/// The data root prefers `~/Library/Application Support/
/// Bowerbird`, and falls back to the Electron app's
/// `~/.local/share/bowerbird` (then `quickboard`) when that
/// one holds a board — so the Swift app opens the user's
/// real board from the Electron data dir.
public struct BoardPaths {
    public let dataRoot: URL

    public init(dataRoot: URL) {
        self.dataRoot = dataRoot
    }

    public static func `default`() -> BoardPaths {
        let fileManager = FileManager.default
        let applicationSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let home = fileManager.homeDirectoryForCurrentUser
        let candidates = [
            applicationSupport.appendingPathComponent("Bowerbird"),
            home.appendingPathComponent(".local/share/bowerbird"),
            home.appendingPathComponent(".local/share/quickboard"),
        ]
        for candidate in candidates {
            if fileManager.fileExists(atPath: candidate.appendingPathComponent("board.json").path) {
                return BoardPaths(dataRoot: candidate)
            }
        }
        return BoardPaths(dataRoot: candidates[0])
    }

    /// The board.json for a board name, or Main when the name
    /// is nil or "Main".
    public func boardPath(for name: String?) -> URL {
        boardDir(for: name).appendingPathComponent("board.json")
    }

    public func boardDir(for name: String?) -> URL {
        guard let name, name != "Main" else { return dataRoot }
        return dataRoot
            .appendingPathComponent("boards")
            .appendingPathComponent(Self.sanitise(name))
    }

    public func assetsDir(for name: String?) -> URL {
        boardDir(for: name).appendingPathComponent("assets")
    }

    public func backupsDir(for name: String?) -> URL {
        boardDir(for: name).appendingPathComponent("backups")
    }

    public func libraryDir(for name: String?) -> URL {
        boardDir(for: name).appendingPathComponent("library")
    }

    public func recoveryPath(for name: String?) -> URL {
        boardDir(for: name).appendingPathComponent("recovery.json")
    }

    /// `[^A-Za-z0-9._-]` → `_`, strip leading dots, cap 64,
    /// fallback "file". ASCII only, like the Electron app's.
    public static func sanitise(_ name: String) -> String {
        var out = ""
        for scalar in name.unicodeScalars {
            let value = scalar.value
            let isASCIIAlphanumeric =
                (value >= 48 && value <= 57)
                || (value >= 65 && value <= 90)
                || (value >= 97 && value <= 122)
            let isAllowed = isASCIIAlphanumeric || value == 46 || value == 95 || value == 45
            out.append(isAllowed ? Character(scalar) : "_")
        }
        while out.hasPrefix(".") { out.removeFirst() }
        if out.count > 64 { out = String(out.prefix(64)) }
        return out.isEmpty ? "file" : out
    }
}
