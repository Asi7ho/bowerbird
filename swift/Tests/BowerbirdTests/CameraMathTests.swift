import XCTest
@testable import BowerbirdCore

final class CameraMathTests: XCTestCase {
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

    func testClampZoom() {
        XCTAssertEqual(CameraMath.clampZoom(0.001), 0.01)
        XCTAssertEqual(CameraMath.clampZoom(100), 8)
        XCTAssertEqual(CameraMath.clampZoom(2), 2)
    }

    func testWorldScreenRoundTrip() {
        let camera = Camera(x: 100, y: 50, zoom: 2)
        let world = Pt(x: 150, y: 75)
        let screen = CameraMath.worldToScreen(world, camera: camera)
        XCTAssertEqual(screen, Pt(x: 100, y: 50))
        XCTAssertEqual(CameraMath.screenToWorld(screen, camera: camera), world)
    }

    func testZoomCameraKeepsPointUnderCursor() {
        let camera = Camera(x: 0, y: 0, zoom: 1)
        let cursor = Pt(x: 200, y: 100)
        let zoomed = CameraMath.zoomCamera(camera, around: cursor, factor: 2)
        XCTAssertEqual(zoomed.zoom, 2)
        XCTAssertEqual(CameraMath.screenToWorld(cursor, camera: zoomed), CameraMath.screenToWorld(cursor, camera: camera))
    }

    func testFitCamera() {
        let board = boardWithTwoCards()
        let camera = CameraMath.fitCamera(board: board, viewport: Size(w: 800, h: 600))
        XCTAssertNotNil(camera)
        // Content is 400x250 at (0,0); the 800x600 view with
        // 48px padding fits it at zoom 1, centred.
        XCTAssertEqual(camera?.zoom, 1)
        XCTAssertEqual(camera?.x, -200)
        XCTAssertEqual(camera?.y, -175)
    }

    func testFitCameraCapsZoomAtOne() {
        var board = boardWithTwoCards()
        board.items = [board.items[0]]
        let camera = CameraMath.fitCamera(board: board, viewport: Size(w: 800, h: 600))
        XCTAssertEqual(camera?.zoom, 1)
    }

    func testFitCameraEmptyBoardIsNil() {
        let board = BoardStore.emptyBoard()
        XCTAssertNil(CameraMath.fitCamera(board: board, viewport: Size(w: 800, h: 600)))
    }

    func testVisibleRect() {
        let camera = Camera(x: 100, y: 50, zoom: 2)
        let rect = CameraMath.visibleRect(camera: camera, viewport: Size(w: 800, h: 600))
        XCTAssertEqual(rect.x, -100)
        XCTAssertEqual(rect.y, -150)
        XCTAssertEqual(rect.w, 800)
        XCTAssertEqual(rect.h, 700)
    }

    func testGridStepDoublesWhenZoomedOut() {
        XCTAssertEqual(CameraMath.gridStep(for: Size(w: 800, h: 600), zoom: 1), 100)
        // At zoom 0.1 the view spans 8000 world units wide:
        // the step doubles once (100 -> 200) so 40 cells fit.
        XCTAssertEqual(CameraMath.gridStep(for: Size(w: 800, h: 600), zoom: 0.1), 200)
    }

    func testConnectorBounds() {
        let board = boardWithTwoCards()
        let connector = Item(
            id: 3,
            pos: Pt(x: 0, y: 0),
            size: Size(w: 1, h: 1),
            group: nil,
            kind: .connector(ConnectorPayload(from: .item(1), to: .item(2), color: "#1A1A1A")),
            rotation: nil
        )
        let bounds = CameraMath.itemBounds(board: board, item: connector)
        // Centres are (50,25) and (350,225); expanded by 8.
        XCTAssertEqual(bounds.x, 42)
        XCTAssertEqual(bounds.y, 17)
        XCTAssertEqual(bounds.w, 316)
        XCTAssertEqual(bounds.h, 216)
    }
}
