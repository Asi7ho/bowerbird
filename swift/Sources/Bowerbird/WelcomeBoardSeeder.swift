import Foundation
import BowerbirdCore

/// Seeds a fresh board with the welcome board, the first
/// time the app runs: the showcase assets are copied into
/// the board folder, and the welcome board.json is written
/// there. An existing board.json is never re-seeded — the
/// welcome board only appears on a fresh board, exactly
/// like the Electron app (its `welcomeBoard` runs only
/// when no board JSON exists). A failure to seed (a missing
/// asset, an unwritable folder) leaves no board.json, so
/// the store starts empty instead of half-seeded.
public enum WelcomeBoardSeeder {
    public static func seedIfNeeded(boardURL: URL) {
        let fm = FileManager.default
        guard !fm.fileExists(atPath: boardURL.path) else { return }
        let boardDir = boardURL.deletingLastPathComponent()
        try? fm.createDirectory(at: boardDir, withIntermediateDirectories: true)
        for name in WelcomeBoard.assetNames {
            guard let src = WelcomeBoard.assetURL(named: name) else { continue }
            let dst = boardDir.appendingPathComponent(name)
            guard !fm.fileExists(atPath: dst.path) else { continue }
            try? fm.copyItem(at: src, to: dst)
        }
        guard let data = WelcomeBoard.jsonData(for: boardDir) else { return }
        try? data.write(to: boardURL, options: .atomic)
    }
}
