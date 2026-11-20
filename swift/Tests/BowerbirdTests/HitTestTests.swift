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
        // A board with only an ellipse at (100,100)
        // 200x100: its centre hits, its top-left corner
        // (inside the box, outside the ellipse) does not.
        let b = Board(
            items: [Item(id: 5, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .shape(ShapePayload(shape: .ellipse, fill: "#2A9D8F", outline: nil)), rotation: nil)],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 6, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 150))?.id, 5)
        XCTAssertNil(HitTest.hit(board: b, at: Pt(x: 105, y: 105)))
    }

    func testTriangleHitInsideTheShapeNotItsCorner() {
        // A board with only a triangle at (100,100)
        // 200x100: its centre hits, its top-left corner
        // (inside the box, outside the triangle) does not.
        let b = Board(
            items: [Item(id: 6, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .shape(ShapePayload(shape: .triangle, fill: "#2A9D8F", outline: nil)), rotation: nil)],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 7, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 170))?.id, 6)
        XCTAssertNil(HitTest.hit(board: b, at: Pt(x: 105, y: 105)))
    }

    func testOutlineRectHitOnlyOnItsEdge() {
        // An outline rect is only selectable on its edge:
        // its centre and a point well inside do not hit,
        // a point on the edge (and one within the 4px
        // tolerance just inside it) does.
        let b = Board(
            items: [Item(id: 7, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .shape(ShapePayload(shape: .rect, fill: "#2A9D8F", outline: true)), rotation: nil)],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 8, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
        XCTAssertNil(HitTest.hit(board: b, at: Pt(x: 200, y: 150)))
        XCTAssertNil(HitTest.hit(board: b, at: Pt(x: 200, y: 110)))
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 100))?.id, 7)
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 103))?.id, 7)
    }

    func testOutlineEllipseHitOnlyOnItsEdge() {
        // An outline ellipse: its centre does not hit, a
        // point on its top edge does.
        let b = Board(
            items: [Item(id: 8, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .shape(ShapePayload(shape: .ellipse, fill: "#2A9D8F", outline: true)), rotation: nil)],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 9, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
        XCTAssertNil(HitTest.hit(board: b, at: Pt(x: 200, y: 150)))
        XCTAssertEqual(HitTest.hit(board: b, at: Pt(x: 200, y: 100))?.id, 8)
    }
}
