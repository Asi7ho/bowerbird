import XCTest
@testable import BowerbirdCore

final class ShapeTests: XCTestCase {
    private func board() -> Board {
        Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "Note", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 1, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
    }

    func testAddCommitsAShapeAtTheDragMinCorner() {
        var b = board()
        let id = BoardShape.add(&b, shape: .ellipse, from: Pt(x: 300, y: 200), to: Pt(x: 100, y: 100), fill: "#E63946", outline: false)
        XCTAssertEqual(id, 2)
        XCTAssertEqual(b.nextId, 2)
        XCTAssertEqual(b.items.count, 2)
        XCTAssertEqual(b.items[1].pos, Pt(x: 100, y: 100))
        XCTAssertEqual(b.items[1].size, Size(w: 200, h: 100))
        guard case .shape(let payload) = b.items[1].kind else { return XCTFail("item is not a shape") }
        XCTAssertEqual(payload.shape, .ellipse)
        XCTAssertEqual(payload.fill, "#E63946")
        XCTAssertNil(payload.outline)
    }

    func testAddLandsOnTopOfTheItemsItOverlaps() {
        // A drawn shape is appended, so it is last in
        // board order — and the host renders later items
        // above earlier ones.
        var b = board()
        BoardShape.add(&b, shape: .rect, from: Pt(x: 150, y: 120), to: Pt(x: 250, y: 180), fill: "#2A9D8F", outline: false)
        XCTAssertEqual(b.items.last?.id, 2)
    }

    func testAddKeepsTheOutlineFlag() {
        var b = board()
        BoardShape.add(&b, shape: .triangle, from: Pt(x: 0, y: 0), to: Pt(x: 50, y: 50), fill: "#1A1A1A", outline: true)
        guard case .shape(let payload) = b.items[1].kind else { return XCTFail("item is not a shape") }
        XCTAssertEqual(payload.outline, true)
    }

    func testAddRefusesATinyDrag() {
        // A drag under 10 world pixels on either axis is a
        // click, not a shape — no item, no id spent.
        var b = board()
        let narrow = BoardShape.add(&b, shape: .rect, from: Pt(x: 0, y: 0), to: Pt(x: 5, y: 50), fill: "#1A1A1A", outline: false)
        XCTAssertNil(narrow)
        let short = BoardShape.add(&b, shape: .rect, from: Pt(x: 0, y: 0), to: Pt(x: 50, y: 5), fill: "#1A1A1A", outline: false)
        XCTAssertNil(short)
        XCTAssertEqual(b.items.count, 1)
        XCTAssertEqual(b.nextId, 1)
    }
}
