import XCTest
@testable import BowerbirdCore

final class BoardStoreTests: XCTestCase {
    private func makeBoardURL() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bowerbird-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("board.json")
    }

    private func textItem(id: Int, text: String) -> Item {
        Item(
            id: id,
            pos: Pt(x: 0, y: 0),
            size: Size(w: 100, h: 50),
            group: nil,
            kind: .text(TextPayload(text: text, bold: false, size: 16, color: "#1A1A1A", bg: nil)),
            rotation: nil
        )
    }

    func testSaveLoadRoundTrip() throws {
        let url = try makeBoardURL()
        let store = BoardStore(boardURL: url)
        XCTAssertTrue(store.board.items.isEmpty)
        store.update { $0.items.append(textItem(id: 1, text: "hello")) }
        XCTAssertTrue(store.save())
        let reloaded = BoardStore(boardURL: url)
        XCTAssertEqual(reloaded.board.items.count, 1)
        guard case .text(let text) = reloaded.board.items[0].kind else { return XCTFail("not Text") }
        XCTAssertEqual(text.text, "hello")
    }

    func testNoChangeSaveIsNoOp() throws {
        let url = try makeBoardURL()
        let store = BoardStore(boardURL: url)
        store.update { $0.items.append(textItem(id: 1, text: "a")) }
        XCTAssertTrue(store.save())
        let firstMtime = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date)
        Thread.sleep(forTimeInterval: 0.05)
        XCTAssertTrue(store.save())
        let secondMtime = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date)
        XCTAssertEqual(firstMtime, secondMtime)
    }

    func testLiveFollowGuardRefusesExternalChange() throws {
        let url = try makeBoardURL()
        let store = BoardStore(boardURL: url)
        store.update { $0.items.append(textItem(id: 1, text: "mine")) }
        XCTAssertTrue(store.save())
        // An external writer changes the file on disk.
        var external = try Board.decode(from: Data(contentsOf: url))
        external.items.append(textItem(id: 2, text: "theirs"))
        try String(data: external.encode(), encoding: .utf8)!.write(to: url, atomically: true, encoding: .utf8)
        store.update { $0.items.append(textItem(id: 3, text: "more mine")) }
        XCTAssertFalse(store.save())
        // The journal holds the refused edits.
        XCTAssertTrue(store.hasRecovery())
        XCTAssertTrue(store.restoreRecovery())
        XCTAssertEqual(store.board.items.count, 2)
    }

    func testLoadHealsDuplicates() throws {
        let url = try makeBoardURL()
        var board = BoardStore.emptyBoard()
        board.items = [textItem(id: 1, text: "a"), textItem(id: 1, text: "b")]
        board.nextId = 1
        try String(data: board.encode(), encoding: .utf8)!.write(to: url, atomically: true, encoding: .utf8)
        let store = BoardStore(boardURL: url)
        XCTAssertEqual(store.board.items.map(\.id), [1, 2])
    }
}
