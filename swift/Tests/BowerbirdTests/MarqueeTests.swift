import XCTest
@testable import BowerbirdCore

final class MarqueeTests: XCTestCase {
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

    func testMarqueeSelectsOneCard() {
        XCTAssertEqual(MarqueeSelection.select(board: board(), from: Pt(x: 50, y: 50), to: Pt(x: 350, y: 250)), [1])
    }

    func testMarqueeSelectsBothCards() {
        XCTAssertEqual(MarqueeSelection.select(board: board(), from: Pt(x: 50, y: 50), to: Pt(x: 650, y: 250)), [1, 2])
    }

    func testMarqueeDraggedUpLeftSelectsTheSame() {
        // Dragging up-left normalises to the same rect.
        XCTAssertEqual(MarqueeSelection.select(board: board(), from: Pt(x: 350, y: 250), to: Pt(x: 50, y: 50)), [1])
    }

    func testMarqueeSelectsOnIntersectionNotContainment() {
        // The rect only clips card 1's right edge — the card
        // is not inside it, but it intersects, so it counts.
        XCTAssertEqual(MarqueeSelection.select(board: board(), from: Pt(x: 290, y: 50), to: Pt(x: 350, y: 250)), [1])
    }

    func testMarqueeOnEmptySpaceSelectsNothing() {
        XCTAssertEqual(MarqueeSelection.select(board: board(), from: Pt(x: 50, y: 500), to: Pt(x: 350, y: 600)), [])
    }

    func testMarqueeCrossingAStrokeSelectsIt() {
        // The rect crosses the stroke's line (y 350) without
        // containing the stroke's whole bounds.
        XCTAssertEqual(MarqueeSelection.select(board: board(), from: Pt(x: 150, y: 320), to: Pt(x: 250, y: 380)), [3])
    }
}
