import AppKit
import XCTest
@testable import BoardUI
import BowerbirdCore

/// The full load through the viewport: the viewport is
/// created, the host renders into its card container, and
/// the viewport is then laid out to its window size. The
/// bird's parts must be in the right place once the
/// viewport has its size — a click must not be needed to
/// put them right.
final class ViewportLoadTests: XCTestCase {
    private func birdBoard() -> Board {
        // Two bird parts: a rotated ellipse and the branch
        // stroke, at the welcome board's places.
        let ellipse = Item(
            id: 16, pos: Pt(x: 1340.82, y: 216.13), size: Size(w: 30.36, h: 23.74), group: nil,
            kind: .shape(ShapePayload(shape: .ellipse, fill: "#2A6D09", outline: nil)),
            rotation: -28
        )
        let branch = Item(
            id: 15, pos: Pt(x: 1280, y: 196), size: Size(w: 340, h: 46), group: nil,
            kind: .stroke(StrokePayload(
                points: [Pt(x: 1280, y: 242), Pt(x: 1441, y: 224.25), Pt(x: 1620, y: 196)],
                color: "#7A5230", width: 6, marker: false, pressures: nil, pencil: nil
            )),
            rotation: nil
        )
        return Board(
            items: [ellipse, branch], camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 17, nextGroup: 0, groups: nil, bg: "#FFFFFF", grid: .dots
        )
    }

    func testBirdPartsPlacedOnViewportLoad() {
        let board = birdBoard()
        let viewport = BoardViewport(board: board)
        // The host, as BoardView.makeNSView wires it.
        let host = CardHost(container: viewport.cardContainer, board: board, camera: board.camera)
        viewport.onViewportResized = { host.render() }
        // The window lays the viewport out.
        viewport.frame = CGRect(x: 0, y: 0, width: 2000, height: 1000)
        viewport.resizeSubviews(withOldSize: .zero)
        // The card views are in the container now.
        let cards = viewport.cardContainer.subviews.compactMap { $0 as? CardView }
        XCTAssertEqual(cards.count, 2)
        for view in cards {
            guard let item = view.currentItem else { continue }
            // The frame's centre is the item's centre, in
            // screen coordinates (camera 0,0 zoom 1).
            let cx = item.pos.x + item.size.w / 2
            let cy = item.pos.y + item.size.h / 2
            XCTAssertEqual(view.frame.midX, cx, accuracy: 0.01, "item \(item.id) midX")
            XCTAssertEqual(view.frame.midY, cy, accuracy: 0.01, "item \(item.id) midY")
            XCTAssertEqual(view.bounds.width, item.size.w, accuracy: 0.01, "item \(item.id) width")
            XCTAssertEqual(view.bounds.height, item.size.h, accuracy: 0.01, "item \(item.id) height")
        }
    }
}
