import Foundation

/// The welcome board: the first board a new user sees. It
/// is content, not app logic — the layout, wording and
/// welcome assets, with no interaction state. The board is
/// a literal JSON fixture (`welcome-board.json`, generated
/// by running the Electron app's own `welcomeBoard` on its
/// 48 items, so the heights and the bird's coordinates are
/// exact), and the asset paths in it carry the placeholder
/// `__BOARD_DIR__`, which is replaced with the board's
/// folder when the board is seeded. The showcase assets
/// ride alongside it as resources, and the app copies them
/// into the board folder on seeding.
public enum WelcomeBoard {
    /// The placeholder in the fixture's asset paths.
    public static let boardDirPlaceholder = "__BOARD_DIR__"

    /// The showcase asset files the welcome board
    /// references (the app copies each into the board
    /// folder when it seeds the board).
    public static let assetNames: [String] = [
        "welcome-bower.jpg",
        "sample.pdf",
        "welcome-birdsong.mp3",
        "welcome-video.mp4",
        "welcome-heron.ai",
        "welcome-heron-preview.png",
        "welcome-garden.psd",
        "welcome-garden-preview.png",
        "welcome-cube.glb",
    ]

    /// The URL of a showcase asset in the bundle, for the
    /// app to copy into the board folder on seeding.
    public static func assetURL(named name: String) -> URL? {
        Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Resources")
    }

    /// The welcome board as JSON data, with its asset paths
    /// pointing into this board folder — the exact bytes the
    /// app writes to board.json when it seeds a fresh board.
    /// Returns nil when the fixture cannot be read.
    public static func jsonData(for boardDir: URL) -> Data? {
        guard let url = Bundle.module.url(forResource: "welcome-board", withExtension: "json", subdirectory: "Resources"),
              let data = try? Data(contentsOf: url),
              var text = String(data: data, encoding: .utf8) else { return nil }
        text = text.replacingOccurrences(of: boardDirPlaceholder, with: boardDir.path)
        return text.data(using: .utf8)
    }

    /// The welcome board, with its asset paths pointing
    /// into this board folder. Returns nil when the
    /// fixture cannot be read or decoded (the app then
    /// falls back to an empty board).
    public static func board(for boardDir: URL) -> Board? {
        guard let json = jsonData(for: boardDir) else { return nil }
        return try? JSONDecoder().decode(Board.self, from: json)
    }
}
