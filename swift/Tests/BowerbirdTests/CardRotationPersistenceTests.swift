import AppKit
import XCTest
@testable import BoardUI
import BowerbirdCore

/// A rotated card's turn must survive a display pass. The
/// bird's parts sat unturned on load because the turn was
/// set on the layer directly and AppKit reset it at the
/// first display. With `frameCenterRotation` the turn is
/// the view's own, and it holds — the drawn pixels prove
/// it, not just the layer state.
final class CardRotationPersistenceTests: XCTestCase {
    private func rotatedItem() -> Item {
        Item(
            id: 16, pos: Pt(x: 100, y: 100), size: Size(w: 30, h: 24), group: nil,
            kind: .shape(ShapePayload(shape: .ellipse, fill: "#2A6D09", outline: nil)),
            rotation: -28
        )
    }

    /// The rotation angle, in degrees, of a layer's
    /// transform about the z axis.
    private func rotationDegrees(of layer: CALayer) -> Double {
        let t = layer.transform
        return atan2(Double(t.m12), Double(t.m11)) * 180 / .pi
    }

    private func cardViews(in container: NSView) -> [CardView] {
        container.subviews.compactMap { $0 as? CardView }
    }

    /// The turn survives a display pass and stays about
    /// the card's centre.
    func testRotationSurvivesDisplayPass() {
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        let container = WorldView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        container.wantsLayer = true
        window.contentView = container
        let item = rotatedItem()
        let board = Board(
            items: [item], camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 17, nextGroup: 0, groups: nil, bg: "#FFFFFF", grid: .dots
        )
        let host = CardHost(container: container, board: board, camera: board.camera)
        XCTAssertNotNil(host)
        guard let view = cardViews(in: container).first else {
            XCTFail("no card view")
            return
        }
        // A display pass, then the geometry from here on.
        window.displayIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        // The turn is still there, and it is about the
        // card's centre — the drawn rect is still centred
        // on the item.
        XCTAssertEqual(rotationDegrees(of: view.layer!), -28, accuracy: 0.5)
        let drawn = view.convert(view.bounds, to: container)
        XCTAssertEqual(drawn.midX, item.pos.x + item.size.w / 2, accuracy: 0.01)
        XCTAssertEqual(drawn.midY, item.pos.y + item.size.h / 2, accuracy: 0.01)
        _ = host
        window.orderOut(nil)
    }

    /// The drawn pixels, not just the layer state: after a
    /// display pass the rotated ellipse must sit centred on
    /// the item, with the rotated bounding box — the way the
    /// Electron app's `transform: rotate()` puts it (about
    /// the centre).
    func testRotatedCardDrawsAtItsCentreAfterDisplay() {
        let window = NSWindow(
            contentRect: CGRect(x: 0, y: 0, width: 400, height: 300),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        let container = WorldView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        container.wantsLayer = true
        window.contentView = container
        let item = rotatedItem()
        let board = Board(
            items: [item], camera: Camera(x: 0, y: 0, zoom: 1),
            nextId: 17, nextGroup: 0, groups: nil, bg: "#FFFFFF", grid: .dots
        )
        let host = CardHost(container: container, board: board, camera: board.camera)
        XCTAssertNotNil(host)
        window.displayIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        guard let rep = container.bitmapImageRepForCachingDisplay(in: container.bounds) else {
            XCTFail("no bitmap")
            return
        }
        container.cacheDisplay(in: container.bounds, to: rep)
        let scale = Double(rep.pixelsWide) / Double(container.bounds.width)
        var minX = Double.infinity, minY = Double.infinity
        var maxX = -Double.infinity, maxY = -Double.infinity
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                // The shape's fill (#2A6D09): green dominant.
                guard color.greenComponent > 0.25,
                      color.greenComponent > color.redComponent * 1.5,
                      color.greenComponent > color.blueComponent * 1.5 else { continue }
                minX = min(minX, Double(x) / scale)
                maxX = max(maxX, Double(x) / scale)
                minY = min(minY, Double(y) / scale)
                maxY = max(maxY, Double(y) / scale)
            }
        }
        guard minX.isFinite else {
            XCTFail("the rotated ellipse did not draw")
            return
        }
        // Rotation about the centre: the drawn box's centre
        // is the item's centre, and its width/height are the
        // rotated extents of the ellipse (an ellipse turns
        // inside a smaller box than its bounding rect does).
        let rad = 28.0 * .pi / 180
        let a = Double(item.size.w) / 2, b = Double(item.size.h) / 2
        let boxW = 2 * (a * a * cos(rad) * cos(rad) + b * b * sin(rad) * sin(rad)).squareRoot()
        let boxH = 2 * (a * a * sin(rad) * sin(rad) + b * b * cos(rad) * cos(rad)).squareRoot()
        XCTAssertEqual((minX + maxX) / 2, item.pos.x + item.size.w / 2, accuracy: 1.5)
        XCTAssertEqual((minY + maxY) / 2, item.pos.y + item.size.h / 2, accuracy: 1.5)
        XCTAssertEqual(maxX - minX, boxW, accuracy: 2)
        XCTAssertEqual(maxY - minY, boxH, accuracy: 2)
        window.orderOut(nil)
    }
}
