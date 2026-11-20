import AppKit
import XCTest
@testable import BoardUI
import BowerbirdCore

/// The bird-on-load fix: the path must be built from the
/// size the host passes in, not from `bounds`. The debug
/// file showed the views' frames are right on load while
/// the parts still draw wrong — the path was built from a
/// bounds that had not caught up with the new frame yet
/// (a fresh view not yet in the window). A view whose
/// bounds are still zero must still draw the right path
/// when the host hands it its real size.
final class RebuildContentTests: XCTestCase {
    func testShapePathBuiltFromPassedSizeNotBounds() {
        let item = Item(
            id: 16, pos: Pt(x: 1342.64, y: 228.65), size: Size(w: 30.36, h: 23.74), group: nil,
            kind: .shape(ShapePayload(shape: .ellipse, fill: "#2A6D09", outline: nil)),
            rotation: -28
        )
        let view = ShapeCardView()
        view.configure(item: item)
        // Bounds still zero: the view has never been in a
        // window and its frame was never set — the state
        // a fresh card is in when the host places it.
        XCTAssertEqual(view.bounds.width, 0)
        // The host hands it the size it just set.
        let size = CGSize(width: 30.36 * 0.5275801121484833, height: 23.74 * 0.5275801121484833)
        view.rebuildContent(size: size)
        guard let path = view.shapeLayer.path else {
            XCTFail("no path built")
            return
        }
        let box = path.boundingBox
        XCTAssertEqual(box.width, size.width, accuracy: 0.01)
        XCTAssertEqual(box.height, size.height, accuracy: 0.01)
    }

    func testStrokePathBuiltFromPassedSizeNotBounds() {
        let item = Item(
            id: 15, pos: Pt(x: 1281.82, y: 208.52), size: Size(w: 340.0, h: 46.0), group: nil,
            kind: .stroke(StrokePayload(
                points: [Pt(x: 1281.82, y: 254.52), Pt(x: 1441.82, y: 236.77), Pt(x: 1621.82, y: 208.52)],
                color: "#7A5230", width: 6, marker: false, pressures: nil, pencil: nil
            )),
            rotation: nil
        )
        let view = StrokeCardView()
        view.configure(item: item)
        XCTAssertEqual(view.bounds.width, 0)
        let size = CGSize(width: 340.0 * 0.5275801121484833, height: 46.0 * 0.5275801121484833)
        view.rebuildContent(size: size)
        guard let path = view.shapeLayer.path else {
            XCTFail("no path built")
            return
        }
        let box = path.boundingBox
        XCTAssertEqual(box.width, size.width, accuracy: 0.01)
        XCTAssertEqual(box.height, size.height, accuracy: 0.01)
    }
}
