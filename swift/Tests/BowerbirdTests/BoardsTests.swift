import XCTest
@testable import BowerbirdCore

final class BoardsTests: XCTestCase {
    private func makeRoot() throws -> BoardPaths {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("bowerbird-boards-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return BoardPaths(dataRoot: root)
    }

    func testCreateListRenameDelete() throws {
        let paths = try makeRoot()
        let boards = Boards(paths: paths)
        XCTAssertTrue(boards.list(current: nil).isEmpty)
        XCTAssertTrue(boards.create(name: "My Board"))
        XCTAssertFalse(boards.create(name: "My Board"))
        XCTAssertFalse(boards.create(name: "  "))
        var list = boards.list(current: nil)
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0].name, "My_Board")
        XCTAssertEqual(list[0].displayName, "My Board")
        XCTAssertEqual(list[0].items, 0)
        XCTAssertTrue(boards.rename(oldName: "My_Board", newName: "Renamed"))
        list = boards.list(current: "Renamed")
        XCTAssertEqual(list[0].name, "Renamed")
        XCTAssertEqual(list[0].displayName, "Renamed")
        XCTAssertTrue(list[0].current)
        XCTAssertFalse(boards.rename(oldName: "Main", newName: "Nope"))
        XCTAssertFalse(boards.delete(name: "Main"))
        XCTAssertTrue(boards.delete(name: "Renamed"))
        XCTAssertTrue(boards.list(current: nil).isEmpty)
    }

    func testMainListedWhenItExists() throws {
        let paths = try makeRoot()
        let boards = Boards(paths: paths)
        let store = BoardStore(boardURL: paths.boardPath(for: nil))
        XCTAssertTrue(store.save())
        let list = boards.list(current: "Main")
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0].name, "Main")
        XCTAssertTrue(list[0].current)
    }
}
