import AppKit
import XCTest
@testable import BoardUI
import BowerbirdCore

/// A recycled card view must land in the right place when
/// it is reused for a differently rotated item. Setting a
/// frame while a rotation is still applied computes the
/// wrong bounds (the frame is the bounding box of the
/// rotated rect), so the bird's rotated parts sat wrong on
/// load and only snapped into place once something moved
/// them. The host resets the rotation before setting the
/// frame, so the bounds are always the unrotated size.
final class CardHostRotationTests: XCTestCase {
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

    /// A view recycled from a 30-degree item to a
    /// -28-degree item keeps the new item's size and
    /// centre — the frame is set unrotated first.
    func testRecycledRotatedViewKeepsNewSizeAndCentre() {
        let container = NSView(frame: CGRect(x: 0, y: 0, width: 2000, height: 1000))
        let camera = Camera(x: 0, y: 0, zoom: 1)
        let first = shapeItem(id: 1, pos: Pt(x: 100, y: 100), size: Size(w: 60, h: 40), rotation: 30)
        let board = Board(items: [first], camera: camera, nextId: 1, nextGroup: 0, groups: nil, bg: "#FFFFFF", grid: .dots)
        let host = CardHost(container: container, board: board, camera: camera)
        XCTAssertEqual(cardViews(in: container).count, 1)

        // Recycle the same view for a differently rotated,
        // differently sized item at a new place.
        let second = shapeItem(id: 2, pos: Pt(x: 500, y: 300), size: Size(w: 30, h: 24), rotation: -28)
        let board2 = Board(items: [second], camera: camera, nextId: 2, nextGroup: 0, groups: nil, bg: "#FFFFFF", grid: .dots)
        host.board = board2
        let views = cardViews(in: container)
        XCTAssertEqual(views.count, 1)
        guard let view = views.first else { return }
        // The bounds are the unrotated screen size.
        XCTAssertEqual(view.bounds.width, 30, accuracy: 0.001)
        XCTAssertEqual(view.bounds.height, 24, accuracy: 0.001)
        // The centre is the centre of the new item's rect.
        XCTAssertEqual(view.frame.midX, 515, accuracy: 0.001)
        XCTAssertEqual(view.frame.midY, 312, accuracy: 0.001)
    }
}
