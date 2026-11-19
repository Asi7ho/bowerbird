import XCTest
@testable import BowerbirdCore

final class BoardHealingTests: XCTestCase {
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

    func testHealDuplicateIds() {
        var board = Board(
            items: [textItem(id: 1, text: "first"), textItem(id: 1, text: "second"), textItem(id: 2, text: "third")],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 1,
            nextGroup: 0,
            groups: nil,
            bg: "#FFFFFF",
            grid: .dots
        )
        healDuplicateIds(&board)
        XCTAssertEqual(board.items[0].id, 1)
        XCTAssertEqual(board.items[1].id, 3)
        XCTAssertEqual(board.items[2].id, 2)
        XCTAssertEqual(board.nextId, 3)
    }

    func testHealRaisesStaleNextId() {
        var board = Board(
            items: [textItem(id: 9, text: "only")],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 1,
            nextGroup: 0,
            groups: nil,
            bg: "#FFFFFF",
            grid: .dots
        )
        healDuplicateIds(&board)
        XCTAssertEqual(board.nextId, 9)
        XCTAssertEqual(allocId(&board), 10)
    }

    func testSyncGroupLabelsNamesUnlabelledGroups() {
        var a = textItem(id: 1, text: "a")
        a.group = 1
        var b = textItem(id: 2, text: "b")
        b.group = 1
        var c = textItem(id: 3, text: "c")
        c.group = 3
        var board = Board(
            items: [a, b, c],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 3,
            nextGroup: 0,
            groups: nil,
            bg: "#FFFFFF",
            grid: .dots
        )
        syncGroupLabels(&board)
        // Group 1 has two members and no entry: it is
        // named "Group 1". Group 3 has one member: it
        // gets no entry.
        XCTAssertEqual(board.groups?[1]?.label, "Group 1")
        XCTAssertNil(board.groups?[3])
    }

    func testSyncGroupLabelsRenamesSectionToGroup() {
        var a = textItem(id: 1, text: "a")
        a.group = 1
        var b = textItem(id: 2, text: "b")
        b.group = 1
        var board = Board(
            items: [a, b],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 2,
            nextGroup: 0,
            groups: [1: GroupEntry(label: "Section 1", source: nil)],
            bg: "#FFFFFF",
            grid: .dots
        )
        syncGroupLabels(&board)
        // An old default label from the Electron app is
        // renamed to "Group 1"; a custom label is left
        // alone (see the test below).
        XCTAssertEqual(board.groups?[1]?.label, "Group 1")
    }

    func testSyncGroupLabelsKeepsExistingLabelAndDropsSmallGroups() {
        var a = textItem(id: 1, text: "a")
        a.group = 1
        var b = textItem(id: 2, text: "b")
        b.group = 1
        var board = Board(
            items: [a, b],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 2,
            nextGroup: 0,
            groups: [1: GroupEntry(label: "Mine", source: nil), 9: GroupEntry(label: "Gone", source: nil)],
            bg: "#FFFFFF",
            grid: .dots
        )
        syncGroupLabels(&board)
        XCTAssertEqual(board.groups?[1]?.label, "Mine")
        XCTAssertNil(board.groups?[9])
    }

    func testHealCleanBoardUnchanged() {
        var board = Board(
            items: [textItem(id: 1, text: "a"), textItem(id: 2, text: "b")],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 2,
            nextGroup: 0,
            groups: nil,
            bg: "#FFFFFF",
            grid: .dots
        )
        healDuplicateIds(&board)
        XCTAssertEqual(board.items.map(\.id), [1, 2])
        XCTAssertEqual(board.nextId, 2)
    }
}
