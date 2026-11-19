import XCTest
@testable import BowerbirdCore

final class LassoTests: XCTestCase {
    private func board() -> Board {
        Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "Note", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
                Item(id: 2, pos: Pt(x: 400, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .swatch(SwatchPayload(hex: "#2A9D8F")), rotation: nil),
                Item(id: 3, pos: Pt(x: 100, y: 300), size: Size(w: 200, h: 100), group: nil, kind: .stroke(StrokePayload(points: [Pt(x: 100, y: 350), Pt(x: 300, y: 350)], color: "#E63946", width: 3, marker: false, pressures: nil, pencil: nil)), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 4, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
    }

    func testLassoAroundOneCard() {
        let loop = [Pt(x: 50, y: 50), Pt(x: 350, y: 50), Pt(x: 350, y: 250), Pt(x: 50, y: 250)]
        XCTAssertEqual(LassoSelection.select(board: board(), points: loop), [1])
    }

    func testLassoAroundBothCards() {
        let loop = [Pt(x: 50, y: 50), Pt(x: 650, y: 50), Pt(x: 650, y: 250), Pt(x: 50, y: 250)]
        XCTAssertEqual(LassoSelection.select(board: board(), points: loop), [1, 2])
    }

    func testLassoOnEmptySpaceSelectsNothing() {
        let loop = [Pt(x: 50, y: 500), Pt(x: 350, y: 500), Pt(x: 350, y: 600), Pt(x: 50, y: 600)]
        XCTAssertEqual(LassoSelection.select(board: board(), points: loop), [])
    }

    func testLassoNeedsThreePoints() {
        XCTAssertEqual(LassoSelection.select(board: board(), points: [Pt(x: 50, y: 50), Pt(x: 350, y: 50)]), [])
    }

    func testLassoEdgeCrossingAStrokeSelectsIt() {
        // A thin horizontal strip (y 310–320) crossing the
        // stroke's bounds (100,300)–(300,400): the stroke's
        // centre (200,350) and all four corners sit outside
        // the strip, so only a loop edge crossing the bounds
        // selects it.
        let loop = [Pt(x: 50, y: 310), Pt(x: 350, y: 310), Pt(x: 350, y: 320), Pt(x: 50, y: 320)]
        XCTAssertEqual(LassoSelection.select(board: board(), points: loop), [3])
    }
}
