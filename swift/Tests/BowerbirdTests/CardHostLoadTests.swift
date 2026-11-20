import AppKit
import XCTest
@testable import BoardUI
import BowerbirdCore

/// The load sequence: the host renders once while the
/// container is still zero-sized (the viewport is not
/// laid out yet), then again once the container has its
/// real size. A card that only becomes visible on the
/// second render must land in the right place on that
/// render — not only after a later click (a reposition).
final class CardHostLoadTests: XCTestCase {
    private func shapeItem(id: Int, pos: Pt, size: Size, rotation: Double?) -> Item {
        Item(
            id: id, pos: pos, size: size, group: nil,
            kind: .shape(ShapePayload(shape: .ellipse, fill: "#E63946", outline: nil)),
            rotation: rotation
        )
    }

    private func cardViews(in container: NSView) -> [CardView] {
        container.subviews.compactMap { $0 as? CardView }
    }

    /// A rotated card that appears only after the
    /// container grows to its real size lands correctly —
    /// and its shape is drawn for the real bounds on that
    /// same render, not only after a later layout pass.
    func testCardAppearingAfterResizeLandsCorrectly() {
        let container = NSView(frame: .zero)
        let camera = Camera(x: 0, y: 0, zoom: 1)
        // The bird part sits far right, off a zero-sized
        // viewport, so the first render culls it.
        let part = shapeItem(id: 1, pos: Pt(x: 1300, y: 200), size: Size(w: 30, h: 24), rotation: -28)
        let board = Board(items: [part], camera: camera, nextId: 1, nextGroup: 0, groups: nil, bg: "#FFFFFF", grid: .dots)
        let host = CardHost(container: container, board: board, camera: camera)
        XCTAssertEqual(cardViews(in: container).count, 0)

        // The viewport is laid out: the container grows
        // and the host renders again.
        container.frame = CGRect(x: 0, y: 0, width: 2000, height: 1000)
        host.render()
        let views = cardViews(in: container)
        XCTAssertEqual(views.count, 1)
        guard let view = views.first else { return }
        XCTAssertEqual(view.bounds.width, 30, accuracy: 0.001)
        XCTAssertEqual(view.bounds.height, 24, accuracy: 0.001)
        // The drawn rect (the rotation's bounding box) is
        // centred on the item; `frame` is not a reliable
        // read for a rotated view (AppKit keeps its own
        // geometry for the turn).
        let drawn = view.convert(view.bounds, to: container)
        XCTAssertEqual(drawn.midX, 1315, accuracy: 0.001)
        XCTAssertEqual(drawn.midY, 212, accuracy: 0.001)
        // The shape itself is drawn for the real bounds:
        // the path's box fills the card, so the ellipse
        // sits where the card sits.
        let shapeLayer = view.layer?.sublayers?.compactMap { $0 as? CAShapeLayer }.first
        XCTAssertNotNil(shapeLayer)
        if let path = shapeLayer?.path {
            let box = path.boundingBox
            XCTAssertEqual(box.width, 30, accuracy: 0.5)
            XCTAssertEqual(box.height, 24, accuracy: 0.5)
        } else {
            XCTFail("shape layer has no path after render")
        }
    }
}
