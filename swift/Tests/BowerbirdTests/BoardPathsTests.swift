import XCTest
@testable import BowerbirdCore

final class BoardPathsTests: XCTestCase {
    private func makeRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("bowerbird-paths-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    func testSanitise() {
        XCTAssertEqual(BoardPaths.sanitise("My Board!"), "My_Board_")
        XCTAssertEqual(BoardPaths.sanitise("...hidden"), "hidden")
        XCTAssertEqual(BoardPaths.sanitise(""), "file")
        XCTAssertEqual(BoardPaths.sanitise("..."), "file")
        XCTAssertEqual(BoardPaths.sanitise("café"), "caf_")
        XCTAssertEqual(BoardPaths.sanitise(String(repeating: "a", count: 100)).count, 64)
    }

    func testBoardPaths() throws {
        let root = try makeRoot()
        let paths = BoardPaths(dataRoot: root)
        XCTAssertEqual(paths.boardPath(for: nil), root.appendingPathComponent("board.json"))
        XCTAssertEqual(paths.boardPath(for: "Main"), root.appendingPathComponent("board.json"))
        XCTAssertEqual(
            paths.boardPath(for: "My Board"),
            root.appendingPathComponent("boards/My_Board/board.json")
        )
        XCTAssertEqual(paths.assetsDir(for: nil), root.appendingPathComponent("assets"))
        XCTAssertEqual(paths.backupsDir(for: "My Board"), root.appendingPathComponent("boards/My_Board/backups"))
        XCTAssertEqual(paths.recoveryPath(for: nil), root.appendingPathComponent("recovery.json"))
    }

    func testDefaultPrefersApplicationSupport() {
        // The default root is Application Support unless an
        // Electron board exists in ~/.local/share.
        let paths = BoardPaths.default()
        XCTAssertTrue(paths.dataRoot.lastPathComponent == "Bowerbird" || paths.dataRoot.lastPathComponent == "quickboard")
    }
}
