import XCTest
@testable import BowerbirdCore

final class HandlesTests: XCTestCase {
    private func board() -> Board {
        Board(
            items: [
                Item(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 200, h: 100), group: nil, kind: .text(TextPayload(text: "Note", bold: false, size: 16, color: "#1A1A1A", bg: nil)), rotation: nil),
                Item(id: 2, pos: Pt(x: 100, y: 300), size: Size(w: 200, h: 1), group: nil, kind: .stroke(StrokePayload(points: [Pt(x: 100, y: 300), Pt(x: 300, y: 300)], color: "#1A1A1A", width: 3, marker: false, pressures: nil, pencil: nil)), rotation: nil),
                Item(id: 3, pos: Pt(x: 400, y: 100), size: Size(w: 100, h: 100), group: nil, kind: .connector(ConnectorPayload(from: .point(Pt(x: 350, y: 150)), to: .item(1), color: "#1A1A1A")), rotation: nil),
            ],
            camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 4, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots
        )
    }

    func testRotatePointTurnsAroundTheCentre() {
        // A point to the right of the centre, rotated 90°
        // clockwise, lands below it.
        let p = Handles.rotatePoint(Pt(x: 10, y: 0), around: Pt(x: 0, y: 0), by: 90)
        XCTAssertEqual(p.x, 0, accuracy: 1e-9)
        XCTAssertEqual(p.y, 10, accuracy: 1e-9)
    }

    func testNormAngleWraps() {
        XCTAssertEqual(Handles.normAngle(270), -90)
        XCTAssertEqual(Handles.normAngle(-270), 90)
        XCTAssertEqual(Handles.normAngle(180), 180)
        XCTAssertEqual(Handles.normAngle(360), 0)
    }

    func testRotateAngleForPointsUpAtZero() {
        // A pointer straight above the centre is 0° (the
        // handle above the card means unrotated).
        let b = board()
        let deg = Handles.rotateAngleFor(world: Pt(x: 200, y: 50), item: b.items[0], snap: false)
        XCTAssertEqual(deg, 0, accuracy: 1e-9)
    }

    func testRotateAngleForSnapsToFifteenWithShift() {
        let b = board()
        // 20° off straight up snaps to 15°.
        let deg = Handles.rotateAngleFor(world: Pt(x: 200 + 100 * sin(20 * Double.pi / 180), y: 50), item: b.items[0], snap: true)
        XCTAssertEqual(deg, 15, accuracy: 1e-9)
    }

    func testCornerWorldIsTheBottomRight() {
        let b = board()
        let corner = Handles.cornerWorld(board: b, item: b.items[0])
        XCTAssertEqual(corner, Pt(x: 300, y: 200))
    }

    func testCornerWorldIsNilForAConnector() {
        let b = board()
        XCTAssertNil(Handles.cornerWorld(board: b, item: b.items[2]))
    }

    func testRotateHandleWorldIsAboveTheTopEdge() {
        let b = board()
        // 28 world pixels above the top edge centre.
        let handle = Handles.rotateHandleWorld(item: b.items[0], zoom: 1)
        XCTAssertEqual(handle, Pt(x: 200, y: 72))
    }

    func testCornerHitWithinTolerance() {
        let b = board()
        XCTAssertTrue(Handles.cornerHit(board: b, item: b.items[0], at: Pt(x: 305, y: 195), zoom: 1))
        XCTAssertFalse(Handles.cornerHit(board: b, item: b.items[0], at: Pt(x: 350, y: 200), zoom: 1))
    }

    func testRotateHitWithinTolerance() {
        let b = board()
        XCTAssertTrue(Handles.rotateHit(item: b.items[0], at: Pt(x: 200, y: 80), zoom: 1))
        XCTAssertFalse(Handles.rotateHit(item: b.items[0], at: Pt(x: 200, y: 120), zoom: 1))
        // A connector is not rotatable, so it has no
        // rotate handle to hit.
        XCTAssertFalse(Handles.rotateHit(item: b.items[2], at: Pt(x: 200, y: 80), zoom: 1))
    }

    func testResizeClampsToFortyEight() {
        var b = board()
        BoardResize.resize(&b, id: 1, newW: 10, newH: 20)
        XCTAssertEqual(b.items[0].size, Size(w: 48, h: 48))
    }

    func testResizeScalesAStrokesPoints() {
        var b = board()
        BoardResize.resize(&b, id: 2, newW: 400, newH: 48)
        guard case .stroke(let stroke) = b.items[1].kind else { return XCTFail("item is not a stroke") }
        // The points scale with the frame (2× wide, 48×
        // tall — the height clamps the frame, the points
        // scale by the same factor).
        XCTAssertEqual(stroke.points[0], Pt(x: 100, y: 300))
        XCTAssertEqual(stroke.points[1], Pt(x: 500, y: 300))
        XCTAssertEqual(b.items[1].size, Size(w: 400, h: 48))
    }

    func testSetRotationStoresTheAngle() {
        var b = board()
        BoardRotate.setRotation(&b, id: 1, rotation: 45)
        XCTAssertEqual(b.items[0].rotation, 45)
        XCTAssertFalse(BoardRotate.setRotation(&b, id: 99, rotation: 45))
    }
}
