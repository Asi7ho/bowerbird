import XCTest
@testable import BowerbirdCore

final class RecoveryJournalTests: XCTestCase {
    private func makeBoardDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bowerbird-recovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func emptyBoardJson() throws -> String {
        let board = Board(
            items: [],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 0,
            nextGroup: 0,
            groups: nil,
            bg: "#FFFFFF",
            grid: .dots
        )
        return String(data: try board.encode(), encoding: .utf8)!
    }

    func testWriteReadClear() throws {
        let dir = try makeBoardDir()
        let journal = RecoveryJournal(boardDir: dir)
        XCTAssertNil(journal.read())
        XCTAssertTrue(journal.write(boardJson: try emptyBoardJson()))
        let entry = try XCTUnwrap(journal.read())
        XCTAssertFalse(entry.json.isEmpty)
        XCTAssertTrue(entry.savedAt > 0)
        journal.clear()
        XCTAssertNil(journal.read())
    }

    func testInvalidContentIsNotABoard() throws {
        let dir = try makeBoardDir()
        let journal = RecoveryJournal(boardDir: dir)
        XCTAssertFalse(journal.write(boardJson: "not json"))
        XCTAssertFalse(journal.write(boardJson: "{\"items\": \"nope\"}"))
        XCTAssertNil(journal.read())
    }

    func testHasRecoveryComparesCanonically() throws {
        let dir = try makeBoardDir()
        let journal = RecoveryJournal(boardDir: dir)
        let json = try emptyBoardJson()
        XCTAssertFalse(journal.hasRecovery(comparedTo: json))
        XCTAssertTrue(journal.write(boardJson: json))
        // Same board: the journal is stale, never an offer.
        XCTAssertFalse(journal.hasRecovery(comparedTo: json))
        // A different board: the journal holds edits.
        var other = try Board.decode(from: Data(json.utf8))
        other.bg = "#000000"
        let otherJson = String(data: try other.encode(), encoding: .utf8)!
        XCTAssertTrue(journal.hasRecovery(comparedTo: otherJson))
    }
}
