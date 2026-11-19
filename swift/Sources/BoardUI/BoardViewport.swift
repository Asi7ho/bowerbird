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
    /// Called when the user commits a board edit (a drag
    /// ends, a card is deleted): the app applies the board
    /// to the store (one undo step) and saves it. Live drags
    /// mutate the viewport's own board and re-render; only
    /// the commit goes through here.
    public var onBoardMutate: ((Board) -> Void)?
    /// Called on Cmd+Z / Cmd+Shift+Z: the app undoes or
    /// redoes one step through the store (which saves).
    public var onUndo: (() -> Void)?
    public var onRedo: (() -> Void)?
    /// The toolbar's state: the viewport reads the active
    /// tool to decide what a pointer gesture does, and
    /// closes the flyout when the user clicks the board.
    public weak var toolState: ToolState?

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

    /// Called during a card drag with the dragged ids and
    /// the TOTAL world delta from the drag start, so the
    /// host can move the views (no reconfigure, no board
    /// change) while the drag is live. The commit goes
    /// through onBoardMutate on mouseUp.
    public var onDragMove: ((Set<Int>, Pt) -> Void)?

    /// A card drag in progress: the world point where the
    /// drag started, the ids being dragged (the selection
    /// at the drag start), the total world delta from the
    /// drag start (the commit uses this, so the board lands
    /// exactly where the drag last drew it), and whether
    /// the pointer has actually moved — a click that never
    /// moved is a selection, not a drag, and commits nothing.
    private var dragStart: Pt?
    private var dragIds: Set<Int> = []
    private var dragDelta = Pt(x: 0, y: 0)
    private var dragMoved = false

    /// A marquee drag in progress: the world point where the
    /// drag started and where the pointer is now. A drag on
    /// empty space (no card hit, no Space pan) starts one.
    private var marqueeStart: Pt?
    private var marqueeCurrent: Pt?
    /// The marquee rect overlay, above the cards: a
    /// WorldView (flipped, like the card container)
    /// carrying one CAShapeLayer — the same pattern as the
    /// CardHost's connector and group-frame overlays.
    private let marqueeOverlay = WorldView()
    private let marqueeLayer = CAShapeLayer()

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
        marqueeOverlay.wantsLayer = true
        marqueeOverlay.autoresizingMask = [.width, .height]
        addSubview(marqueeOverlay)
        marqueeLayer.fillColor = NSColor.clear.cgColor
        marqueeLayer.strokeColor = NSColor.systemBlue.cgColor
        marqueeOverlay.layer?.addSublayer(marqueeLayer)
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
        marqueeOverlay.frame = bounds
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
        updateMarqueeOverlay()
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

    /// A local event monitor for the wheel only. A pinch
    /// (magnify) is NOT monitored: it is a gesture event
    /// that AppKit delivers to the first responder, and
    /// intercepting it here consumed it without zooming —
    /// the wheel goes through the monitor because a card
    /// under the cursor would otherwise swallow it, but a
    /// pinch reaches the viewport through the responder
    /// chain (see `magnify(with:)`). The monitor consumes
    /// the wheel event so the responder chain never
    /// handles it twice.
    private func startEventMonitor() {
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
            guard let self, self.window != nil else { return event }
            // Only the board's own events: the pointer must
            // be over this view. The window is not checked
            // (a wheel event can carry no window), the
            // bounds check is the gate.
            let location = self.convert(event.locationInWindow, from: nil)
            guard self.bounds.contains(location) else { return event }
            self.scrollWheel(with: event)
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
        // doubled, because at 1x a pinch was barely
        // perceptible next to Cmd+scroll (5% a notch).
        // The pinch arrives through the responder chain
        // (the viewport is the first responder) — it is
        // deliberately not routed through the event monitor,
        // which consumed it without zooming.
        let location = convert(event.locationInWindow, from: nil)
        camera = CameraMath.zoomCamera(
            camera,
            around: Pt(x: Double(location.x), y: Double(location.y)),
            factor: 1 + Double(event.magnification) * 2
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
        // Undo / redo: Cmd+Z undoes one step, Cmd+Shift+Z
        // redoes it. The store owns the stacks and saves.
        if event.modifierFlags.contains(.command),
           let chars = event.charactersIgnoringModifiers?.lowercased(), chars == "z" {
            if event.modifierFlags.contains(.shift) {
                onRedo?()
            } else {
                onUndo?()
            }
            return
        }
        // Delete: remove the selection (one undo step, one
        // save) and clear it. A group that drops below two
        // members loses its label, like on load.
        if event.keyCode == 51, !selected.isEmpty {
            var next = board
            next.items.removeAll { selected.contains($0.id) }
            syncGroupLabels(&next)
            onBoardMutate?(next)
            selected = []
            return
        }
        // Group / ungroup: Cmd+G groups the selection (at
        // least two), Cmd+U ungroups the groups the
        // selection belongs to. The core owns the ids and
        // the labels; the commit is one undo step and one
        // save. Nothing is committed when there is nothing
        // to group or ungroup.
        if event.modifierFlags.contains(.command),
           let chars = event.charactersIgnoringModifiers?.lowercased() {
            if chars == "g" {
                var next = board
                if BoardGroup.group(&next, ids: Array(selected)) != nil {
                    onBoardMutate?(next)
                }
                return
            }
            if chars == "u" {
                var next = board
                if BoardGroup.ungroup(&next, ids: Array(selected)) {
                    onBoardMutate?(next)
                }
                return
            }
        }
        // Tool shortcuts: V select, P draw, R geometry, A
        // connector, X eraser. A family shortcut restores
        // the last tool of that family and opens its flyout;
        // it never resets the tool in use. (A keypress with
        // the command key held is an app shortcut, not a
        // tool shortcut — Cmd+Z and friends are handled
        // above.)
        if !event.modifierFlags.contains(.command),
           let chars = event.charactersIgnoringModifiers?.lowercased() {
            switch chars {
            case "v":
                toolState?.selectShortcut()
                return
            case "p":
                toolState?.drawShortcut()
                return
            case "r":
                toolState?.shapeShortcut()
                return
            case "a":
                toolState?.activate(.connector)
                toolState?.pickerOpen = nil
                return
            case "x":
                toolState?.eraserShortcut()
                return
            default:
                break
            }
        }
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
        // A click on the board closes the toolbar flyout
        // (flyouts are transient: they disappear once the
        // user clicks anywhere else).
        toolState?.pickerOpen = nil
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
            // Empty space: a drag from here is a marquee.
            // Shift keeps the existing selection until the
            // drag ends (the Electron app clears it only
            // without Shift); the marquee result replaces
            // the selection on mouseUp either way.
            if !shift { selected = [] }
            marqueeStart = world
            marqueeCurrent = world
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
        // A drag from a selected card: the drag moves the
        // whole selection (the group, when the card is
        // grouped). A Shift-click that deselected the card
        // starts no drag.
        if group.isSubset(of: selected) {
            dragStart = world
            dragIds = selected
            dragDelta = Pt(x: 0, y: 0)
            dragMoved = false
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
        if let start = panStart {
            let point = convert(event.locationInWindow, from: nil)
            // A grab moves the paper with the pointer: the content
            // follows the hand, so the camera moves against it.
            camera = Camera(
                x: start.camera.x - Double(point.x - start.point.x) / start.camera.zoom,
                y: start.camera.y - Double(point.y - start.point.y) / start.camera.zoom,
                zoom: start.camera.zoom
            )
            return
        }
        // A card drag: the total world delta from the drag
        // start moves the views (no reconfigure, no board
        // change — the board is committed on mouseUp).
        if let start = dragStart {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            dragDelta = Pt(x: world.x - start.x, y: world.y - start.y)
            if dragDelta.x != 0 || dragDelta.y != 0 {
                dragMoved = true
                onDragMove?(dragIds, dragDelta)
            }
            return
        }
        guard marqueeStart != nil else { return }
        let point = convert(event.locationInWindow, from: nil)
        marqueeCurrent = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
        updateMarqueeOverlay()
    }

    override public func mouseUp(with event: NSEvent) {
        panStart = nil
        // A card drag that moved: commit the final board
        // (one undo step, one save). A click that never
        // moved commits nothing.
        if dragStart != nil {
            if dragMoved {
                var final = board
                BoardMove.move(&final, ids: dragIds, by: dragDelta)
                onBoardMutate?(final)
            }
            dragStart = nil
            dragIds = []
            dragDelta = Pt(x: 0, y: 0)
            dragMoved = false
            return
        }
        guard let start = marqueeStart else { return }
        let end = marqueeCurrent ?? start
        selected = Set(MarqueeSelection.select(board: board, from: start, to: end))
        marqueeStart = nil
        marqueeCurrent = nil
        updateMarqueeOverlay()
    }

    /// Draws (or hides) the marquee rect. The rect is the
    /// drag's world corners mapped to screen coordinates;
    /// the stroke is the Electron app's 1 world pixel of the
    /// accent blue, so it scales with the zoom, with no fill.
    private func updateMarqueeOverlay() {
        marqueeOverlay.frame = bounds
        guard let start = marqueeStart, let current = marqueeCurrent else {
            marqueeLayer.path = nil
            return
        }
        let a = Pt(x: (start.x - camera.x) * camera.zoom, y: (start.y - camera.y) * camera.zoom)
        let b = Pt(x: (current.x - camera.x) * camera.zoom, y: (current.y - camera.y) * camera.zoom)
        let rect = CGRect(
            x: min(a.x, b.x), y: min(a.y, b.y),
            width: abs(b.x - a.x), height: abs(b.y - a.y)
        )
        marqueeLayer.path = CGPath(rect: rect, transform: nil)
        marqueeLayer.lineWidth = 1 * camera.zoom
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
