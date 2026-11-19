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
            updateWindowBackground()
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

    /// A local event monitor for pinch and wheel, so the
    /// gestures reach the board whatever the first
    /// responder is. AppKit sends a pinch to the first
    /// responder and a wheel to the view under the cursor,
    /// and both proved unreliable in practice (the board
    /// only became first responder after a click, and the
    /// wheel went to the card under the cursor first) —
    /// the fit key worked while the gestures did nothing,
    /// which is how the camera itself was exonerated. The
    /// monitor hands the event to the same handlers and
    /// consumes it, so it is never handled twice.
    private var eventMonitor: Any?

    public init(board: Board) {
        self.camera = board.camera
        self.board = board
        super.init(frame: .zero)
        wantsLayer = true
        // Clip to the viewport: an NSView does not clip its
        // subviews by default, so the cards (which are
        // positioned in world coordinates and transformed
        // by the camera) drew outside the board — over the
        // title bar strip and the window edges.
        clipsToBounds = true
        gridView.grid = board.grid
        gridView.backgroundHex = board.bg
        gridView.autoresizingMask = [.width, .height]
        addSubview(gridView)
        cardContainer.wantsLayer = true
        cardContainer.autoresizingMask = [.width, .height]
        addSubview(cardContainer)
        // A pinch is a gesture recognizer, not the
        // responder chain: `magnify(with:)` needs the view
        // to be the first responder, and the pinch kept not
        // arriving (Cmd+scroll worked, pinch did not). The
        // recognizer is attached to the view, so it sees the
        // pinch whatever has focus.
        let pinch = NSMagnificationGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
        addGestureRecognizer(pinch)
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
        // The camera is NOT a transform on the container's
        // layer. A layer transform is applied about the
        // layer's anchor point (its centre), so the mapping
        // was not (world − camera) × zoom but that plus a
        // centre × (1 − zoom) offset — the cards displayed
        // shifted from where the hit-test looked for them,
        // which is why a click on a card missed and a click
        // beside it hit. The host instead positions every
        // card at its screen coordinates, computed from the
        // camera, so what is drawn is exactly what the
        // hit-test checks. The grid takes the camera
        // directly (its shader does the same mapping).
        gridView.camera = camera
    }

    /// The window behind the board is the board's own
    /// background colour, so the title bar strip and the
    /// board are the same white: the strip is a SwiftUI
    /// colour and the board is a Metal clear colour, and
    /// the window's own background (the light grey it
    /// shows where no view covers it) read as a second,
    /// different white next to the board.
    private func updateWindowBackground() {
        window?.backgroundColor = NSColor.fromHex(board.bg) ?? .white
    }

    override public func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Be the first responder from the start, so a pinch
        // and the keyboard (Space, F) work without a click
        // first — AppKit sends those to the first responder.
        if window != nil {
            // The window is resizable: the hidden title bar
            // style left it without the resizable flag, so
            // dragging an edge did nothing. (The Electron
            // app's window is 1280x850, min 1100x720.)
            window?.styleMask.insert(.resizable)
            window?.makeFirstResponder(self)
            updateWindowBackground()
            startEventMonitor()
        } else {
            stopEventMonitor()
        }
    }

    override public func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil { stopEventMonitor() }
    }

    deinit {
        stopEventMonitor()
    }

    /// A local event monitor for the wheel and the pinch.
    /// The monitor sees the event before it is dispatched
    /// to any view, so it is the delivery route that does
    /// not depend on first responder status or on the
    /// SwiftUI hosting view forwarding the gesture — the
    /// pinch did not arrive through the responder chain
    /// (`magnify(with:)`) or through a gesture recognizer,
    /// so the monitor is the route that catches it. The
    /// monitor consumes the event so the responder chain
    /// never handles it twice.
    private func startEventMonitor() {
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.magnify, .scrollWheel]) { [weak self] event in
            guard let self, self.window != nil else { return event }
            // Only the board's own events: the pointer must
            // be over this view. The window is not checked
            // (a wheel event can carry no window), the
            // bounds check is the gate.
            let location = self.convert(event.locationInWindow, from: nil)
            guard self.bounds.contains(location) else { return event }
            if event.type == .magnify {
                self.magnify(with: event)
            } else {
                self.scrollWheel(with: event)
            }
            return nil
        }
    }

    private func stopEventMonitor() {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
            eventMonitor = nil
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
        // A pinch zooms around the cursor. The magnification
        // is the relative change since the last event; it is
        // tripled, because at 1x a pinch was barely
        // perceptible next to Cmd+scroll (5% a notch) — the
        // multiplier is deliberately strong so a pinch is
        // unmistakable.
        let location = convert(event.locationInWindow, from: nil)
        camera = CameraMath.zoomCamera(
            camera,
            around: Pt(x: Double(location.x), y: Double(location.y)),
            factor: 1 + Double(event.magnification) * 3
        )
    }

    /// The pinch, via a gesture recognizer (a second route,
    /// in case the event monitor does not see it). The
    /// magnification is the relative change since the last
    /// update; the recognizer resets it to 0 after each one,
    /// so the factor is applied per update and the gesture
    /// accumulates.
    @objc private func handlePinch(_ recognizer: NSMagnificationGestureRecognizer) {
        guard recognizer.magnification != 0 else { return }
        let location = recognizer.location(in: self)
        camera = CameraMath.zoomCamera(
            camera,
            around: Pt(x: Double(location.x), y: Double(location.y)),
            factor: 1 + Double(recognizer.magnification) * 3
        )
        recognizer.magnification = 0
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
        if event.charactersIgnoringModifiers == "=" || event.charactersIgnoringModifiers == "+" {
            // Zoom in around the centre (the Electron app's
            // = / + shortcut).
            let centre = Pt(x: Double(bounds.width) / 2, y: Double(bounds.height) / 2)
            camera = CameraMath.zoomCamera(camera, around: centre, factor: 1.25)
            return
        }
        if event.charactersIgnoringModifiers == "-" || event.charactersIgnoringModifiers == "_" {
            let centre = Pt(x: Double(bounds.width) / 2, y: Double(bounds.height) / 2)
            camera = CameraMath.zoomCamera(camera, around: centre, factor: 0.8)
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
        //
        // The hit walks the container's subviews back to
        // front (the visual order) and tests each card with
        // the shape-aware geometry. The board order is not
        // the visual order once a selected card has been
        // re-added on top, and the cards are now positioned
        // at their screen coordinates, so the point converts
        // cleanly to world coordinates and the card under the
        // cursor is the card that is hit.
        let point = convert(event.locationInWindow, from: nil)
        let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
        let shift = event.modifierFlags.contains(.shift)
        var hitItem: Item?
        for subview in cardContainer.subviews.reversed() {
            guard let cardView = subview as? CardView, let item = cardView.currentItem else { continue }
            if HitTest.hits(item: item, board: board, at: world) {
                hitItem = item
                break
            }
        }
        // A connector is drawn, not a view, so it is the
        // only thing that still uses the board-order walk.
        guard let item = hitItem ?? HitTest.hit(board: board, at: world) else {
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
        // The window's resize cursor, explicitly: the
        // board's pan cursor is not the only thing that
        // covers the edges — in the normal state there is
        // no pan cursor at all, and the window's own resize
        // cursor still did not show at the edges, so the
        // edges get their own cursor rects. The view is
        // flipped (y down), so the bottom edge is at
        // bounds.height. The top edge is the title strip,
        // not this view (see TitleBarDragView).
        let edge: CGFloat = 6
        let w = bounds.width, h = bounds.height
        guard w > edge * 2, h > edge * 2 else { return }
        addCursorRect(CGRect(x: 0, y: edge, width: edge, height: h - edge * 2), cursor: .resizeLeftRight)
        addCursorRect(CGRect(x: w - edge, y: edge, width: edge, height: h - edge * 2), cursor: .resizeLeftRight)
        addCursorRect(CGRect(x: edge, y: h - edge, width: w - edge * 2, height: edge), cursor: .resizeUpDown)
        addCursorRect(CGRect(x: 0, y: h - edge, width: edge, height: edge), cursor: .resizeNorthEastSouthWest)
        addCursorRect(CGRect(x: w - edge, y: h - edge, width: edge, height: edge), cursor: .resizeNorthWestSouthEast)
        // The pan cursor covers the board, but NOT the
        // window's edges: the resize zone is the outer few
        // points, and a cursor rect over the whole bounds
        // swallowed the window's resize cursor there, so
        // dragging an edge showed a hand and did nothing
        // useful. Inset by the edge so the resize rects
        // above win at the border.
        let rect = bounds.insetBy(dx: edge, dy: edge)
        if panStart != nil {
            addCursorRect(rect, cursor: .closedHand)
        } else if spaceHeld {
            addCursorRect(rect, cursor: .openHand)
        }
    }
}

/// The card container: a flipped view (y down), like the
/// DOM, so a card's frame is its world position and the
/// container's bounds are the camera.
final class WorldView: NSView {
    override var isFlipped: Bool { true }
}
