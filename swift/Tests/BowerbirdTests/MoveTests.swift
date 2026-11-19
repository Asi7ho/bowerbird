import XCTest
@testable import BowerbirdCore

final class MoveTests: XCTestCase {
    private func board() -> Board {
        Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "Note", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
                Item(id: 2, pos: Pt(x: 100, y: 300), size: Size(w: 200, h: 100), group: nil, kind: .stroke(StrokePayload(points: [Pt(x: 100, y: 350), Pt(x: 300, y: 350)], color: "#E63946", width: 3, marker: false, pressures: nil, pencil: nil)), rotation: nil),
                Item(id: 3, pos: Pt(x: 400, y: 100), size: Size(w: 100, h: 100), group: nil, kind: .connector(ConnectorPayload(from: .point(Pt(x: 350, y: 150)), to: .item(1), color: "#1A1A1A")), rotation: nil),
                Item(id: 4, pos: Pt(x: 700, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .swatch(SwatchPayload(hex: "#2A9D8F")), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 5, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
    }

    func testMoveShiftsACardPosition() {
        var b = board()
        BoardMove.move(&b, ids: [1], by: Pt(x: 50, y: -20))
        XCTAssertEqual(b.items[0].pos, Pt(x: 150, y: 80))
    }

    func testMoveShiftsAStrokePositionAndPoints() {
        // The points are absolute world coords, so they move
        // with the stroke; the position is their bbox min.
        var b = board()
        BoardMove.move(&b, ids: [2], by: Pt(x: 10, y: 40))
        XCTAssertEqual(b.items[1].pos, Pt(x: 110, y: 340))
        guard case .stroke(let payload) = b.items[1].kind else { return XCTFail("item 2 is not a stroke") }
        XCTAssertEqual(payload.points, [Pt(x: 110, y: 390), Pt(x: 310, y: 390)])
    }

    func testMoveShiftsAConnectorPointAnchorButNotAnItemAnchor() {
        // The Point end moves with the connector; the Item
        // end follows its card (which did not move here).
        var b = board()
        BoardMove.move(&b, ids: [3], by: Pt(x: 20, y: 30))
        guard case .connector(let payload) = b.items[2].kind else { return XCTFail("item 3 is not a connector") }
        XCTAssertEqual(payload.from, .point(Pt(x: 370, y: 180)))
        XCTAssertEqual(payload.to, .item(1))
    }

    func testMoveOnlyMovesTheGivenIds() {
        var b = board()
        BoardMove.move(&b, ids: [1, 2], by: Pt(x: 5, y: 5))
        XCTAssertEqual(b.items[0].pos, Pt(x: 105, y: 105))
        XCTAssertEqual(b.items[1].pos, Pt(x: 105, y: 305))
        XCTAssertEqual(b.items[3].pos, Pt(x: 700, y: 100))
    }

    func testMoveByZeroChangesNothing() {
        var b = board()
        let before = b
        BoardMove.move(&b, ids: [1, 2, 3, 4], by: Pt(x: 0, y: 0))
        XCTAssertEqual(b, before)
    }
}
