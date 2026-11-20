import XCTest
@testable import BowerbirdCore

final class StrokeTests: XCTestCase {
    private func board() -> Board {
        Board(
            items: [],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 0, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
    }

    func testAddCommitsAStrokeWithThePointsBbox() {
        var b = board()
        let id = BoardStroke.add(
            &b,
            points: [Pt(x: 300, y: 200), Pt(x: 100, y: 100), Pt(x: 200, y: 150)],
            color: "#E63946", width: 3, marker: false, pencil: nil, pressures: nil
        )
        XCTAssertEqual(id, 1)
        XCTAssertEqual(b.nextId, 1)
        XCTAssertEqual(b.items.count, 1)
        XCTAssertEqual(b.items[0].pos, Pt(x: 100, y: 100))
        XCTAssertEqual(b.items[0].size, Size(w: 200, h: 100))
        guard case .stroke(let payload) = b.items[0].kind else { return XCTFail("item is not a stroke") }
        XCTAssertEqual(payload.points.count, 3)
        XCTAssertEqual(payload.color, "#E63946")
        XCTAssertEqual(payload.width, 3)
        XCTAssertFalse(payload.marker)
        XCTAssertNil(payload.pencil)
    }

    func testAddClampsASingleLineToAtLeastOneByOne() {
        // A straight horizontal line has zero height; the
        // item still gets a 1×1 size, so it renders.
        var b = board()
        let id = BoardStroke.add(
            &b,
            points: [Pt(x: 100, y: 100), Pt(x: 300, y: 100)],
            color: "#1A1A1A", width: 3, marker: false, pencil: nil, pressures: nil
        )
        XCTAssertNotNil(id)
        XCTAssertEqual(b.items[0].size, Size(w: 200, h: 1))
    }

    func testAddKeepsPencilAndMarkerFlags() {
        var b = board()
        BoardStroke.add(
            &b,
            points: [Pt(x: 0, y: 0), Pt(x: 10, y: 10)],
            color: "#1A1A1A", width: 2, marker: false, pencil: true, pressures: nil
        )
        guard case .stroke(let pencil) = b.items[0].kind else { return XCTFail("item is not a stroke") }
        XCTAssertEqual(pencil.pencil, true)
        XCTAssertEqual(pencil.width, 2)

        var b2 = board()
        BoardStroke.add(
            &b2,
            points: [Pt(x: 0, y: 0), Pt(x: 10, y: 10)],
            color: "#FF6B35", width: 12, marker: true, pencil: nil, pressures: nil
        )
        guard case .stroke(let marker) = b2.items[0].kind else { return XCTFail("item is not a stroke") }
        XCTAssertTrue(marker.marker)
        XCTAssertEqual(marker.width, 12)
    }

    func testAddRefusesASinglePoint() {
        // A click that never moved is one point and commits
        // nothing — no item, no id spent.
        var b = board()
        let id = BoardStroke.add(
            &b,
            points: [Pt(x: 100, y: 100)],
            color: "#1A1A1A", width: 3, marker: false, pencil: nil, pressures: nil
        )
        XCTAssertNil(id)
        XCTAssertEqual(b.items.count, 0)
        XCTAssertEqual(b.nextId, 0)
    }
}
