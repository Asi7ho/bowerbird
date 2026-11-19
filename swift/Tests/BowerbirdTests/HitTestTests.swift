import XCTest
@testable import BowerbirdCore

final class HitTestTests: XCTestCase {
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

    func testHitInsideACard() {
        XCTAssertEqual(HitTest.hit(board: board(), at: Pt(x: 150, y: 150))?.id, 1)
    }

    func testHitOnEmptySpaceIsNil() {
        XCTAssertNil(HitTest.hit(board: board(), at: Pt(x: 50, y: 50)))
    }

    func testTopmostWinsWhenCardsOverlap() {
        var b = board()
        b.items.append(Item(id: 4, pos: Pt(x: 150, y: 120), size: Size(w: 200, h: 100), group: nil, kind: .swatch(SwatchPayload(hex: "#FF6B35")), rotation: nil))
        // (200, 150) is inside both card 1 and card 4; the
        // later one (4) is on top.
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 150))?.id, 4)
    }

    func testStrokeHitNearThePathButNotFarAway() {
        let b = board()
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 352))?.id, 3)
        XCTAssertNil(HitTest.hit(board: b, at: Pt(x: 200, y: 380)))
    }

    func testEllipseHitInsideTheShapeNotItsCorner() {
        var b = board()
        // An ellipse at (100,100) 200x100: its centre hits,
        // its top-left corner (inside the box, outside the
        // ellipse) does not.
        b.items.append(Item(id: 5, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .shape(ShapePayload(shape: .ellipse, fill: "#2A9D8F", outline: nil)), rotation: nil))
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 150))?.id, 5)
        XCTAssertNil(HitTest.hit(board: b, at: Pt(x: 105, y: 105)))
    }

    func testTriangleHitInsideTheShapeNotItsCorner() {
        var b = board()
        // A triangle at (100,100) 200x100: its centre hits,
        // its top-left corner (inside the box, outside the
        // triangle) does not.
        b.items.append(Item(id: 6, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .shape(ShapePayload(shape: .triangle, fill: "#2A9D8F", outline: nil)), rotation: nil))
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 170))?.id, 6)
        XCTAssertNil(HitTest.hit(board: b, at: Pt(x: 105, y: 105)))
    }
}
