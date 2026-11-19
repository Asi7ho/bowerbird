import AppKit
import BowerbirdCore

/// The spatial viewport: an AppKit `NSView` (Core Animation
/// layers) that owns the camera and the world-to-screen
/// transform, and handles trackpad magnify/scroll with zero
/// SwiftUI layout-pass overhead.
///
/// The view is flipped (y down), like the DOM, so a board
/// point maps to the screen exactly as the Electron app
/// maps it: screen = (world − camera) × zoom.
///
/// Layers, back to front: the Metal grid (`GridView`), then
/// the card container (whose affine transform is the camera).
/// The card host (CardHost) owns the card views inside the
/// container; this view only moves the camera and tells the
/// host when it does.
public final class BoardViewport: NSView {
    /// The camera. Setting it applies the transform, redraws
    /// the grid and tells the host to re-cull.
    public var camera: Camera {
        didSet {
            applyCamera()
            onCameraChanged?(camera)
        }
    }

    public var board: Board {
        didSet {
            gridView.grid = board.grid
            gridView.backgroundHex = board.bg
            onBoardChanged?(board)
        }
    }

    /// Called after the camera moves (pan, zoom, fit) so the
    /// host can re-cull and the app can save the camera.
    public var onCameraChanged: ((Camera) -> Void)?
    public var onBoardChanged: ((Board) -> Void)?

    public let gridView = GridView()
    let cardContainer = WorldView()

    private var spaceHeld = false
    private var panStart: (point: NSPoint, camera: Camera)?

    public init(board: Board) {
        self.camera = board.camera
        self.board = board
        super.init(frame: .zero)
        wantsLayer = true
        gridView.grid = board.grid
        gridView.backgroundHex = board.bg
        gridView.autoresizingMask = [.width, .height]
        addSubview(gridView)
        cardContainer.wantsLayer = true
        cardContainer.autoresizingMask = [.width, .height]
        addSubview(cardContainer)
        applyCamera()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("BoardViewport is not Interface Builder backed")
    }

    override public var isFlipped: Bool { true }
    override public var acceptsFirstResponder: Bool { true }

    override public func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        gridView.frame = bounds
        cardContainer.frame = bounds
        applyCamera()
    }

    /// The world rect currently visible, with the culling
    /// margin — what the card host builds views for.
    public var visibleWorldRect: WorldRect {
        CameraMath.visibleRect(camera: camera, viewport: Size(w: Double(bounds.width), h: Double(bounds.height)))
    }

    /// Zoom to fit: the camera that shows every item at once
    /// (the Electron app's fitCamera: 48px padding, zoom
    /// capped at 1). No-op on an empty board.
    public func zoomToFit() {
        guard let fitted = CameraMath.fitCamera(
            board: board,
            viewport: Size(w: Double(bounds.width), h: Double(bounds.height))
        ) else { return }
        camera = fitted
    }

    private func applyCamera() {
        // The camera is the container's bounds: its origin is
        // the world point at the top-left, and its size is the
        // viewport in world units (viewport / zoom). A point in
        // the container's (world) coordinates then maps to the
        // screen exactly as the Electron app maps it:
        // screen = (world − camera) × zoom. The frame is set
        // first (it resets the bounds), then the bounds.
        cardContainer.frame = bounds
        cardContainer.bounds = CGRect(
            x: camera.x,
            y: camera.y,
            width: bounds.width / camera.zoom,
            height: bounds.height / camera.zoom
        )
        gridView.camera = camera
    }

    // MARK: - Trackpad and wheel

    override public func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.control) {
            // Ctrl+wheel zooms around the cursor (the Electron
            // app's wheel zoom: factor exp(−dy × 0.003)).
            let factor = exp(-Double(event.scrollingDeltaY) * 0.003)
            let location = convert(event.locationInWindow, from: nil)
            camera = CameraMath.zoomCamera(camera, around: Pt(x: Double(location.x), y: Double(location.y)), factor: factor)
            return
        }
        // Pan follows standard Mac scrolling: scrolling down
        // moves the content up, as in Safari and Notes. The
        // deltas are in screen points; the camera moves in
        // world units, so they are divided by the zoom.
        camera = Camera(
            x: camera.x + Double(event.scrollingDeltaX) / camera.zoom,
            y: camera.y + Double(event.scrollingDeltaY) / camera.zoom,
            zoom: camera.zoom
        )
    }

    override public func magnify(with event: NSEvent) {
        // A pinch zooms around the cursor: factor 1 + the
        // relative magnification.
        let location = convert(event.locationInWindow, from: nil)
        camera = CameraMath.zoomCamera(
            camera,
            around: Pt(x: Double(location.x), y: Double(location.y)),
            factor: 1 + Double(event.magnification)
        )
    }

    // MARK: - Space+drag pan (a grab, not a scroll)

    override public func keyDown(with event: NSEvent) {
        if event.charactersIgnoringModifiers == " " {
            spaceHeld = true
            window?.invalidateCursorRects(for: self)
            return
        }
        if event.charactersIgnoringModifiers == "f" || event.charactersIgnoringModifiers == "F" {
            zoomToFit()
            return
        }
        super.keyDown(with: event)
    }

    override public func keyUp(with event: NSEvent) {
        if event.charactersIgnoringModifiers == " " {
            spaceHeld = false
            window?.invalidateCursorRects(for: self)
            return
        }
        super.keyUp(with: event)
    }

    override public func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        if spaceHeld {
            panStart = (convert(event.locationInWindow, from: nil), camera)
        }
        // Selection and tools take the event from here (M2/M3).
    }

    override public func mouseDragged(with event: NSEvent) {
        guard let start = panStart else { return }
        let point = convert(event.locationInWindow, from: nil)
        // A grab moves the paper with the pointer: the content
        // follows the hand, so the camera moves against it.
        camera = Camera(
            x: start.camera.x - Double(point.x - start.point.x) / start.camera.zoom,
            y: start.camera.y - Double(point.y - start.point.y) / start.camera.zoom,
            zoom: start.camera.zoom
        )
    }

    override public func mouseUp(with event: NSEvent) {
        panStart = nil
    }

    // MARK: - Cursor

    override public func resetCursorRects() {
        super.resetCursorRects()
        if panStart != nil {
            addCursorRect(bounds, cursor: .closedHand)
        } else if spaceHeld {
            addCursorRect(bounds, cursor: .openHand)
        }
    }
}

/// The card container: a flipped view (y down), like the
/// DOM, so a card's frame is its world position and the
/// container's bounds are the camera.
final class WorldView: NSView {
    override var isFlipped: Bool { true }
}
