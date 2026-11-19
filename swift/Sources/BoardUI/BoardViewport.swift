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
    /// Called when the selection changes, so the host can
    /// show the rings and stack the selected cards on top.
    public var onSelectionChanged: ((Set<Int>) -> Void)?

    /// The selected item ids. The viewport owns the
    /// interaction state; the host only renders it.
    public private(set) var selected: Set<Int> = [] {
        didSet { onSelectionChanged?(selected) }
    }
    /// Called when the viewport is laid out or resized, so
    /// the host can re-cull for the new size. The first
    /// layout is the first time the viewport has a real
    /// size: the host is built while the frame is still
    /// zero, so without this the canvas stays empty until
    /// the user moves.
    public var onViewportResized: (() -> Void)?

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
        onViewportResized?()
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

    override public func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Be the first responder from the start, so a pinch
        // and the keyboard (Space, F) work without a click
        // first — AppKit sends those to the first responder.
        if window != nil {
            window?.makeFirstResponder(self)
        }
    }

    // MARK: - Trackpad and wheel

    /// The scroll deltas in screen points. A trackpad
    /// reports precise pixel deltas; a mouse wheel reports
    /// lines. The Electron app multiplies line deltas by 16
    /// (deltaMode), so a wheel notch moves and zooms by the
    /// same amount as a trackpad gesture — without it a
    /// wheel notch barely zooms at all.
    private func scrollDelta(_ event: NSEvent) -> (x: Double, y: Double) {
        let scale = event.hasPreciseScrollingDeltas ? 1.0 : 16.0
        return (Double(event.scrollingDeltaX) * scale, Double(event.scrollingDeltaY) * scale)
    }

    override public func scrollWheel(with event: NSEvent) {
        let delta = scrollDelta(event)
        if event.modifierFlags.contains(.control) || event.modifierFlags.contains(.command) {
            // Ctrl or Cmd+wheel zooms around the cursor (the
            // Electron app's wheel zoom: factor
            // exp(−dy × 0.003) for the DOM's dy, which is
            // y-down. AppKit's delta is y-up, so the sign
            // flips: scroll down zooms out, as in the
            // Electron app.
            let factor = exp(delta.y * 0.003)
            let location = convert(event.locationInWindow, from: nil)
            camera = CameraMath.zoomCamera(camera, around: Pt(x: Double(location.x), y: Double(location.y)), factor: factor)
            return
        }
        // Pan follows standard Mac scrolling: scrolling down
        // moves the content up, as in Safari and Notes. The
        // deltas are in screen points; the camera moves in
        // world units, so they are divided by the zoom.
        // AppKit's deltas are y-up (the opposite sign to the
        // DOM's, whose y is down), so they are negated to
        // match the Electron app's `cam + delta / zoom`.
        camera = Camera(
            x: camera.x - delta.x / camera.zoom,
            y: camera.y - delta.y / camera.zoom,
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

    override public func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInKeyWindow],
            owner: self, userInfo: nil
        ))
    }

    override public func mouseEntered(with event: NSEvent) {
        // Take focus when the pointer arrives, so a pinch
        // and the keyboard work without a click first —
        // AppKit sends those to the first responder, and
        // the board is the only focusable view for now.
        window?.makeFirstResponder(self)
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
        if event.keyCode == 53 { // Escape: deselect.
            selected = []
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
            return
        }
        // Click selection (the Electron app's setSelected):
        // a card, or its whole group, is selected; Shift
        // toggles it in the selection; empty space clears
        // it. Clicking an already-selected card keeps the
        // selection, so a drag can start from it (M3).
        let point = convert(event.locationInWindow, from: nil)
        let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
        let shift = event.modifierFlags.contains(.shift)
        guard let item = HitTest.hit(board: board, at: world) else {
            if !shift { selected = [] }
            return
        }
        let group = groupIds(of: item)
        if shift {
            if group.isSubset(of: selected) {
                selected.subtract(group)
            } else {
                selected.formUnion(group)
            }
        } else if !group.isSubset(of: selected) {
            selected = group
        }
    }

    /// The ids a click on this item selects: the whole
    /// group when the item is grouped, just the item when
    /// it is not.
    private func groupIds(of item: Item) -> Set<Int> {
        guard let group = item.group else { return [item.id] }
        return Set(board.items.filter { $0.group == group }.map { $0.id })
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
