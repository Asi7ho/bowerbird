import XCTest
@testable import BowerbirdCore

final class UndoTests: XCTestCase {
    private func board(with items: [Item] = [], camera: Camera = Camera(x: 0, y: 0, zoom: 1)) -> Board {
        Board(items: items, camera: camera, nextId: items.count + 1, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots)
    }

    private func note(id: Int) -> Item {
        Item(id: id, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "Note", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil)
    }

    func testUndoReturnsThePreviousContent() {
        let store = UndoStore()
        let before = BoardSnapshot(board: board())
        let after = BoardSnapshot(board: board(with: [note(id: 1)]))
        store.recordChange(from: before)
        XCTAssertTrue(store.canUndo)
        XCTAssertFalse(store.canRedo)
        XCTAssertEqual(store.undo(current: after), before)
    }

    func testRedoReturnsToTheCurrentContent() {
        let store = UndoStore()
        let before = BoardSnapshot(board: board())
        let after = BoardSnapshot(board: board(with: [note(id: 1)]))
        store.recordChange(from: before)
        let restored = store.undo(current: after)
        XCTAssertEqual(restored, before)
        XCTAssertTrue(store.canRedo)
        XCTAssertEqual(store.redo(current: before), after)
    }

    func testANewChangeAfterUndoClearsRedo() {
        let store = UndoStore()
        let first = BoardSnapshot(board: board())
        let second = BoardSnapshot(board: board(with: [note(id: 1)]))
        let third = BoardSnapshot(board: board(with: [note(id: 1), note(id: 2)]))
        store.recordChange(from: first)
        _ = store.undo(current: second)
        XCTAssertTrue(store.canRedo)
        store.recordChange(from: second)
        XCTAssertFalse(store.canRedo)
        XCTAssertEqual(store.undo(current: third), second)
    }

    func testUndoWithAnEmptyStackIsNil() {
        let store = UndoStore()
        XCTAssertNil(store.undo(current: BoardSnapshot(board: board())))
        XCTAssertNil(store.redo(current: BoardSnapshot(board: board())))
        XCTAssertFalse(store.canUndo)
        XCTAssertFalse(store.canRedo)
    }

    func testSnapshotIgnoresTheCamera() {
        // Two boards differing only in camera have equal
        // snapshots, so a pan or zoom never becomes an undo
        // step.
        let a = BoardSnapshot(board: board(camera: Camera(x: 0, y: 0, zoom: 1)))
        let b = BoardSnapshot(board: board(camera: Camera(x: 50, y: 20, zoom: 0.5)))
        XCTAssertEqual(a, b)
    }

    func testSnapshotApplyKeepsTheCamera() {
        var target = board(camera: Camera(x: 50, y: 20, zoom: 0.5))
        let snapshot = BoardSnapshot(board: board(with: [note(id: 1)]))
        snapshot.apply(to: &target)
        XCTAssertEqual(target.items.count, 1)
        XCTAssertEqual(target.camera, Camera(x: 50, y: 20, zoom: 0.5))
    }
}
