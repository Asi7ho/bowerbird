import XCTest
@testable import BowerbirdCore

final class GroupTests: XCTestCase {
    private func board() -> Board {
        Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "A", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
                Item(id: 2, pos: Pt(x: 400, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .swatch(SwatchPayload(hex: "#2A9D8F")), rotation: nil),
                Item(id: 3, pos: Pt(x: 100, y: 300), size: Size(w: 200, h: 100), group: 1, kind: .text(TextPayload(text: "B", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
                Item(id: 4, pos: Pt(x: 400, y: 300), size: Size(w: 200, h: 100), group: 1, kind: .swatch(SwatchPayload(hex: "#E63946")), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 5, nextGroup: 2, groups: [1: GroupEntry(label: "Group 1", source: nil)], bg: "#FFFFFF", grid: .dots
        )
    }

    func testGroupAssignsAFreshIdAndBumpsNextGroup() {
        var b = board()
        let id = BoardGroup.group(&b, ids: [1, 2])
        XCTAssertEqual(id, 2)
        XCTAssertEqual(b.nextGroup, 3)
        XCTAssertEqual(b.items[0].group, 2)
        XCTAssertEqual(b.items[1].group, 2)
        XCTAssertEqual(b.groups?[2]?.label, "Group 2")
    }

    func testGroupNeedsTwoItems() {
        var b = board()
        XCTAssertNil(BoardGroup.group(&b, ids: [1]))
        XCTAssertEqual(b.items[0].group, nil)
        XCTAssertEqual(b.nextGroup, 2)
    }

    func testUngroupClearsTheWholeGroup() {
        // Only item 3 is in the selection, but the whole
        // group (3 and 4) is ungrouped.
        var b = board()
        XCTAssertTrue(BoardGroup.ungroup(&b, ids: [3]))
        XCTAssertEqual(b.items[2].group, nil)
        XCTAssertEqual(b.items[3].group, nil)
        XCTAssertNil(b.groups?[1])
    }

    func testUngroupWithNoGroupReturnsFalse() {
        var b = board()
        XCTAssertFalse(BoardGroup.ungroup(&b, ids: [1, 2]))
        XCTAssertEqual(b.items[0].group, nil)
    }
}
