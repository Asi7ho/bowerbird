import XCTest
@testable import BowerbirdCore

final class ModelTests: XCTestCase {
    private func fixtureBoard() throws -> Board {
        let url = Bundle.module.url(forResource: "board", withExtension: "json", subdirectory: "Fixtures")!
        return try Board.decode(from: Data(contentsOf: url))
    }

    func testDecodesEveryKind() throws {
        let board = try fixtureBoard()
        XCTAssertEqual(board.items.count, 7)
        XCTAssertEqual(board.nextId, 7)
        XCTAssertEqual(board.nextGroup, 1)
        XCTAssertEqual(board.groups?[1]?.label, "Section 1")
        XCTAssertEqual(board.grid, .dots)
        XCTAssertEqual(board.camera.zoom, 1)

        guard case .text(let text) = board.items[0].kind else { return XCTFail("item 1 is not Text") }
        XCTAssertEqual(text.text, "Hello")
        XCTAssertFalse(text.bold)

        guard case .shape(let shape) = board.items[1].kind else { return XCTFail("item 2 is not Shape") }
        XCTAssertEqual(shape.shape, .rect)
        XCTAssertEqual(shape.outline, true)
        XCTAssertEqual(board.items[1].rotation, 15)

        guard case .stroke(let stroke) = board.items[2].kind else { return XCTFail("item 3 is not Stroke") }
        XCTAssertEqual(stroke.points.count, 3)
        XCTAssertEqual(stroke.pencil, true)

        guard case .connector(let connector) = board.items[3].kind else { return XCTFail("item 4 is not Connector") }
        XCTAssertEqual(connector.from, .item(1))
        XCTAssertEqual(connector.to, .point(Pt(x: 400, y: 400)))

        guard case .urlCard(let card) = board.items[4].kind else { return XCTFail("item 5 is not UrlCard") }
        XCTAssertEqual(card.title, "Example")
        XCTAssertEqual(board.items[4].group, 1)

        guard case .fileCard(let file) = board.items[5].kind else { return XCTFail("item 6 is not FileCard") }
        XCTAssertEqual(file.format, .psd)
        XCTAssertEqual(file.sizeBytes, 57446)

        guard case .plugin(let plugin) = board.items[6].kind else { return XCTFail("item 7 is not Plugin") }
        XCTAssertEqual(plugin.data, .object(["count": .number(3), "label": .string("hi")]))
    }

    func testRoundTrip() throws {
        let board = try fixtureBoard()
        let decoded = try Board.decode(from: board.encode())
        XCTAssertEqual(decoded, board)
    }
}
