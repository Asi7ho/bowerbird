import XCTest
@testable import BowerbirdCore

final class ConnectorGeometryTests: XCTestCase {
    private func boardWithTwoCards() -> Board {
        let text = { (id: Int, x: Double, y: Double) in
            Item(
                id: id,
                pos: Pt(x: x, y: y),
                size: Size(w: 100, h: 50),
                group: nil,
                kind: .text(TextPayload(text: "t", bold: false, size: 16, color: "#1A1A1A", bg: nil)),
                rotation: nil
            )
        }
        return Board(
            items: [text(1, 0, 0), text(2, 300, 200)],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 2,
            nextGroup: 0,
            groups: nil,
            bg: "#FFFFFF",
            grid: .dots
        )
    }

    func testClippedEndsStopAtCardEdges() {
        let board = boardWithTwoCards()
        let ends = ConnectorGeometry.clippedEnds(board: board, from: .item(1), to: .item(2))
        XCTAssertNotNil(ends)
        // The line from (50,25) to (350,225) leaves the
        // first card through its bottom edge and enters the
        // second through its top edge.
        XCTAssertEqual(ends?.0.x, 87.5, accuracy: 0.001)
        XCTAssertEqual(ends?.0.y, 50, accuracy: 0.001)
        XCTAssertEqual(ends?.1.x, 312.5, accuracy: 0.001)
        XCTAssertEqual(ends?.1.y, 200, accuracy: 0.001)
    }

    func testPointAnchorsAreUsedAsIs() {
        let board = boardWithTwoCards()
        let ends = ConnectorGeometry.clippedEnds(board: board, from: .point(Pt(x: 10, y: 10)), to: .point(Pt(x: 20, y: 20)))
        XCTAssertEqual(ends?.0, Pt(x: 10, y: 10))
        XCTAssertEqual(ends?.1, Pt(x: 20, y: 20))
    }

    func testMissingAnchorIsNil() {
        let board = boardWithTwoCards()
        XCTAssertNil(ConnectorGeometry.clippedEnds(board: board, from: .item(99), to: .item(2)))
    }
}
