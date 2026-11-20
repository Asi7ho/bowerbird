import XCTest
@testable import BowerbirdCore

final class ConnectorTests: XCTestCase {
    private func board() -> Board {
        Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "Note", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
                Item(id: 2, pos: Pt(x: 500, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "Other", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 2, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
    }

    func testAddCommitsAConnectorBetweenTwoCards() {
        var b = board()
        let id = BoardConnector.add(&b, from: .item(1), to: .item(2), color: "#E63946")
        XCTAssertEqual(id, 3)
        XCTAssertEqual(b.nextId, 3)
        XCTAssertEqual(b.items.count, 3)
        guard case .connector(let payload) = b.items[2].kind else { return XCTFail("item is not a connector") }
        XCTAssertEqual(payload.from, .item(1))
        XCTAssertEqual(payload.to, .item(2))
        XCTAssertEqual(payload.color, "#E63946")
        // The bbox of the two card centres (200,150) and
        // (600,150).
        XCTAssertEqual(b.items[2].pos, Pt(x: 200, y: 150))
        XCTAssertEqual(b.items[2].size, Size(w: 400, h: 1))
    }

    func testAddCommitsAConnectorToAPoint() {
        var b = board()
        let id = BoardConnector.add(&b, from: .item(1), to: .point(Pt(x: 800, y: 400)), color: "#1A1A1A")
        XCTAssertNotNil(id)
        guard case .connector(let payload) = b.items[2].kind else { return XCTFail("item is not a connector") }
        XCTAssertEqual(payload.to, .point(Pt(x: 800, y: 400)))
    }

    func testAddRefusesASelfConnector() {
        // A connector from a card to itself is a click, not
        // a connection — no item, no id spent.
        var b = board()
        let id = BoardConnector.add(&b, from: .item(1), to: .item(1), color: "#1A1A1A")
        XCTAssertNil(id)
        XCTAssertEqual(b.items.count, 2)
        XCTAssertEqual(b.nextId, 2)
    }

    func testAddRefusesADegeneratePointTarget() {
        // A point target less than 4 world pixels from the
        // source anchor is a click, not a connection.
        var b = board()
        let id = BoardConnector.add(&b, from: .item(1), to: .point(Pt(x: 201, y: 151)), color: "#1A1A1A")
        XCTAssertNil(id)
        XCTAssertEqual(b.items.count, 2)
        XCTAssertEqual(b.nextId, 2)
    }

    func testAddRefusesAnUnresolvableAnchor() {
        var b = board()
        let id = BoardConnector.add(&b, from: .item(99), to: .item(2), color: "#1A1A1A")
        XCTAssertNil(id)
        XCTAssertEqual(b.items.count, 2)
    }
}
