import XCTest
@testable import BowerbirdCore

final class EraseTests: XCTestCase {
    private func board() -> Board {
        Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 1), group: nil, kind: .stroke(StrokePayload(points: [Pt(x: 100, y: 100), Pt(x: 300, y: 100)], color: "#1A1A1A", width: 3, marker: false, pressures: nil, pencil: nil)), rotation: nil),
                Item(id: 2, pos: Pt(x: 100, y: 300), size: Size(w: 200, h: 1), group: nil, kind: .stroke(StrokePayload(points: [Pt(x: 100, y: 300), Pt(x: 300, y: 300)], color: "#E63946", width: 3, marker: false, pressures: nil, pencil: nil)), rotation: nil),
                Item(id: 3, pos: Pt(x: 100, y: 500), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "Note", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 4, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
    }

    func testStrokesWithinFindsAStrokeTheEraserTouches() {
        // The eraser (radius 12) at 10px from the stroke's
        // centreline touches it: 12 + 3/2 = 13.5.
        let ids = BoardErase.strokesWithin(board: board(), at: Pt(x: 200, y: 110))
        XCTAssertEqual(ids, [1])
    }

    func testStrokesWithinMissesAStrokeTooFarAway() {
        // 20px from the centreline is beyond the eraser's
        // reach (13.5).
        let ids = BoardErase.strokesWithin(board: board(), at: Pt(x: 200, y: 120))
        XCTAssertEqual(ids, [])
    }

    func testStrokesWithinIgnoresNonStrokes() {
        // A text card at the point is not a stroke, so the
        // eraser leaves it alone.
        let ids = BoardErase.strokesWithin(board: board(), at: Pt(x: 200, y: 550))
        XCTAssertEqual(ids, [])
    }

    func testEraseRemovesOnlyTheTouchedStrokes() {
        var b = board()
        let erased = BoardErase.erase(&b, at: Pt(x: 200, y: 110))
        XCTAssertTrue(erased)
        XCTAssertEqual(b.items.map(\.id), [2, 3])
    }

    func testEraseReturnsFalseWhenNothingIsTouched() {
        var b = board()
        let erased = BoardErase.erase(&b, at: Pt(x: 200, y: 200))
        XCTAssertFalse(erased)
        XCTAssertEqual(b.items.count, 3)
    }
}
