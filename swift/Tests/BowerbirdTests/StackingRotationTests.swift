import AppKit
import XCTest
@testable import BoardUI
import BowerbirdCore

/// Does re-adding a card to its container (the stacking
/// pass at the end of layoutVisible) keep the card's
/// rotation? The bird's turned parts sit unturned on
/// load and snap to their turn after a click, even
/// though the turn is set when the card is placed. If
/// the stacking re-add drops the turn, the card draws
/// unturned until a later pass sets it again.
final class StackingRotationTests: XCTestCase {
    func testReAddKeepsRotation() {
        let container = NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 1000))
        let item = Item(
            id: 16, pos: Pt(x: 100, y: 100), size: Size(w: 30, h: 24), group: nil,
            kind: .shape(ShapePayload(shape: .ellipse, fill: "#2A6D09", outline: nil)),
            rotation: -28
        )
        let view = ShapeCardView()
        view.configure(item: item)
        view.frame = CGRect(x: 100, y: 100, width: 30, height: 24)
        container.addSubview(view)
        view.layer?.transform = CATransform3DMakeRotation(28 * .pi / 180, 0, 0, 1)
        let before = view.layer?.transform
        // The stacking pass re-adds the card above the rest.
        container.addSubview(view, positioned: .above, relativeTo: nil)
        let after = view.layer?.transform
        guard let before, let after else {
            XCTFail("transform missing")
            return
        }
        XCTAssertEqual(after.m11, before.m11, accuracy: 0.001)
        XCTAssertEqual(after.m12, before.m12, accuracy: 0.001)
        XCTAssertEqual(after.m21, before.m21, accuracy: 0.001)
        XCTAssertEqual(after.m22, before.m22, accuracy: 0.001)
    }
}
