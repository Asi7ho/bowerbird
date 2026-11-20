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

    func testEraseThroughTheMiddleSplitsTheStroke() {
        // Five points in a line; the eraser at the middle
        // point lifts only that point, and the stroke
        // breaks into the two runs either side of it.
        var b = Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 1), group: nil, kind: .stroke(StrokePayload(points: [Pt(x: 100, y: 100), Pt(x: 150, y: 100), Pt(x: 200, y: 100), Pt(x: 250, y: 100), Pt(x: 300, y: 100)], color: "#1A1A1A", width: 3, marker: false, pressures: nil, pencil: nil)), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 2, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
        XCTAssertTrue(BoardErase.erase(&b, at: Pt(x: 200, y: 100)))
        XCTAssertEqual(b.items.count, 2)
        XCTAssertEqual(b.items[0].kind, .stroke(StrokePayload(points: [Pt(x: 100, y: 100), Pt(x: 150, y: 100)], color: "#1A1A1A", width: 3, marker: false, pressures: nil, pencil: nil)))
        XCTAssertEqual(b.items[1].kind, .stroke(StrokePayload(points: [Pt(x: 250, y: 100), Pt(x: 300, y: 100)], color: "#1A1A1A", width: 3, marker: false, pressures: nil, pencil: nil)))
    }

    func testEraseAtTheEndKeepsOneSide() {
        // The eraser at the first point lifts only it; the
        // rest of the stroke survives as one piece.
        var b = Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 1), group: nil, kind: .stroke(StrokePayload(points: [Pt(x: 100, y: 100), Pt(x: 150, y: 100), Pt(x: 200, y: 100), Pt(x: 250, y: 100), Pt(x: 300, y: 100)], color: "#1A1A1A", width: 3, marker: false, pressures: nil, pencil: nil)), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 2, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
        XCTAssertTrue(BoardErase.erase(&b, at: Pt(x: 100, y: 100)))
        XCTAssertEqual(b.items.count, 1)
        XCTAssertEqual(b.items[0].kind, .stroke(StrokePayload(points: [Pt(x: 150, y: 100), Pt(x: 200, y: 100), Pt(x: 250, y: 100), Pt(x: 300, y: 100)], color: "#1A1A1A", width: 3, marker: false, pressures: nil, pencil: nil)))
    }

    func testSplitKeepsPressuresWithTheirPoints() {
        // Pressures travel with their points, so a split
        // stroke keeps its thick and thin parts.
        let points = [Pt(x: 100, y: 100), Pt(x: 150, y: 100), Pt(x: 200, y: 100), Pt(x: 250, y: 100), Pt(x: 300, y: 100)]
        let runs = BoardErase.splitStroke(points: points, pressures: [0.5, 0.6, 0.7, 0.8, 0.9], center: Pt(x: 200, y: 100), halfWidth: 1.5)
        XCTAssertEqual(runs.count, 2)
        XCTAssertEqual(runs[0].pressures, [0.5, 0.6])
        XCTAssertEqual(runs[1].pressures, [0.8, 0.9])
    }

    func testSplitDropsASinglePointRun() {
        // A run of one point cannot draw: erasing the
        // middle of a three-point stroke leaves two lone
        // points, so nothing survives.
        let points = [Pt(x: 100, y: 100), Pt(x: 200, y: 100), Pt(x: 300, y: 100)]
        let runs = BoardErase.splitStroke(points: points, pressures: nil, center: Pt(x: 200, y: 100), halfWidth: 1.5)
        XCTAssertEqual(runs.count, 0)
    }

    func testStrokeMaxWidthGrowsWithPressure() {
        // Twice the base width times the pressure, clamped
        // to 1…8: a pressure of 1.0 on a width-3 stroke
        // makes it 6 wide.
        let stroke = StrokePayload(points: [], color: "#1A1A1A", width: 3, marker: false, pressures: [1.0], pencil: nil)
        XCTAssertEqual(BoardErase.maxWidth(of: stroke), 6)
        let plain = StrokePayload(points: [], color: "#1A1A1A", width: 3, marker: false, pressures: nil, pencil: nil)
        XCTAssertEqual(BoardErase.maxWidth(of: plain), 3)
    }
}
