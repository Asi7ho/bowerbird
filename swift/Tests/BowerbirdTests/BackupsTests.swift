import XCTest
@testable import BowerbirdCore

final class BackupsTests: XCTestCase {
    private func makeBoardDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bowerbird-backups-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func boardJson(items: Int) throws -> String {
        let items = (0..<items).map { i in
            Item(
                id: i + 1,
                pos: Pt(x: 0, y: 0),
                size: Size(w: 100, h: 50),
                group: nil,
                kind: .text(TextPayload(text: "n\(i)", bold: false, size: 16, color: "#1A1A1A", bg: nil)),
                rotation: nil
            )
        }
        let board = Board(
            items: items,
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: items,
            nextGroup: 0,
            groups: nil,
            bg: "#FFFFFF",
            grid: .dots
        )
        return String(data: try board.encode(), encoding: .utf8)!
    }

    func testMakeListRestore() throws {
        let dir = try makeBoardDir()
        let backups = Backups(boardDir: dir)
        XCTAssertTrue(backups.list().isEmpty)
        let name = try XCTUnwrap(backups.makeBackup(boardJson: boardJson(items: 3)))
        let entries = backups.list()
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].name, name)
        XCTAssertEqual(entries[0].items, 3)
        let restored = try XCTUnwrap(backups.restore(name: name))
        XCTAssertEqual(restored.items.count, 3)
    }

    func testMaybeBackupIsHourly() throws {
        let dir = try makeBoardDir()
        let backups = Backups(boardDir: dir)
        backups.maybeBackup(boardJson: boardJson(items: 1))
        XCTAssertEqual(backups.list().count, 1)
        // A second call within the hour makes no new backup.
        backups.maybeBackup(boardJson: boardJson(items: 2))
        XCTAssertEqual(backups.list().count, 1)
        XCTAssertEqual(backups.list()[0].items, 1)
    }

    func testPruneKeepsNewestTen() throws {
        let dir = try makeBoardDir()
        let backups = Backups(boardDir: dir)
        for i in 0..<12 {
            // Distinct stamps: a second apart is enough for
            // the YYYY-MM-DD-HHMMSS name to differ.
            _ = backups.makeBackup(boardJson: boardJson(items: i + 1))
            Thread.sleep(forTimeInterval: 1.05)
        }
        XCTAssertEqual(backups.list().count, 10)
        XCTAssertEqual(backups.list().first?.items, 12)
    }
}
