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
            // Keep the board's camera in step with the live
            // camera: a board commit carries the board, and a
            // stale board camera would reset the store's
            // camera (and then the viewport's, via
            // updateNSView) to before the pan — the board
            // jumping back on every move, resize or new card.
            if board.camera != camera {
                board.camera = camera
            }
            applyCamera()
            onCameraChanged?(camera)
        }
    }

    public var board: Board {
        didSet {
            // A camera-only change (the camera didSet syncing
            // the board's camera above) must not re-render
            // the cards: the camera move already repositioned
            // them through applyCamera, and a full render on
            // every pan step would reconfigure every card.
            // The snapshot excludes the camera, so equal
            // snapshots mean only the camera changed.
            if BoardSnapshot(board: board) == BoardSnapshot(board: oldValue) {
                return
            }
            gridView.grid = board.grid
            gridView.backgroundHex = board.bg
            updateWindowBackground()
            updateHandles()
            updateNoteColourBar()
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
        didSet {
            updateHandles()
            updateNoteColourBar()
            onSelectionChanged?(selected)
        }
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

    /// A stroke in progress (pen, pencil or highlighter):
    /// the world points so far, the draw tool in use, and
    /// the stylus pressures (only when the stroke started
    /// with a stylus — a mouse records none, and draws a
    /// uniform stroke). The live preview is a shape layer
    /// over the cards, like the marquee overlay.
    private var strokePoints: [Pt]?
    private var strokePressures: [Double]?
    private var strokeTool: DrawTool?
    private let strokeOverlay = WorldView()
    private let strokeLayer = CAShapeLayer()

    /// A shape drag in progress: the world point where the
    /// drag started, where the pointer is now, and the
    /// shape being drawn. The live preview is a shape layer
    /// over the cards, in the pen colour.
    private var shapeStart: Pt?
    private var shapeCurrent: Pt?
    private var shapeKind: ShapeKind?
    private let shapeOverlay = WorldView()
    private let shapeLayer = CAShapeLayer()

    /// A connector drag in progress: the anchor it starts
    /// from (a card, or a bare point) and where the pointer
    /// is now. The live preview is a line over the cards,
    /// in the pen colour.
    private var connectorFrom: Anchor?
    private var connectorCurrent: Pt?
    private let connectorOverlay = WorldView()
    private let connectorLayer = CAShapeLayer()

    /// An erase sweep in progress: the ids erased so far.
    /// The viewport's board is mutated live (the strokes
    /// disappear as the eraser touches them, like the
    /// Electron app), and the sweep is committed as one
    /// undo step on mouseup. The ids are tracked so the
    /// commit re-applies them even if the board was
    /// refreshed mid-sweep.
    private var eraseIds: Set<Int> = []
    private var eraseActive = false
    /// The eraser ring: a circle over the board, following
    /// the cursor while the eraser tool is active, sized
    /// to the eraser's radius (12 world pixels).
    private let eraserOverlay = WorldView()
    private let eraserLayer = CAShapeLayer()

    /// A lasso loop in progress (the select tool's lasso
    /// mode): the world points of the loop so far. The live
    /// preview is a closed path over the cards, filled
    /// with the accent at 0.08 and stroked with it.
    private var lassoPoints: [Pt]?
    private let lassoOverlay = WorldView()
    private let lassoLayer = CAShapeLayer()

    /// The resize and rotate handles: small grips over the
    /// selected card (one card only), drawn as shape layers
    /// in an overlay. The hit-testing is geometric (a
    /// distance from the world point to the handle's world
    /// position), so the layers are visual only.
    private let handlesOverlay = WorldView()
    private let resizeHandleLayer = CAShapeLayer()
    private let rotateStemLayer = CAShapeLayer()
    private let rotateGripLayer = CAShapeLayer()

    /// A resize drag in progress: the id being resized,
    /// the world point where it started, the size it
    /// started at, and whether it actually moved.
    private var resizeDrag: (id: Int, startWorld: Pt, origW: Double, origH: Double)?
    private var resizeMoved = false
    /// A rotate drag in progress: the id being rotated,
    /// the rotation it started at, and whether it actually
    /// moved.
    private var rotateDrag: (id: Int, origRot: Double)?
    private var rotateMoved = false

    /// The note being edited (its id), and the editor view
    /// over its card. Nil when no note is being edited.
    private var editingNoteId: Int?
    private var noteEditor: NoteEditorView?

    /// The note colour bar, shown beside a selected text
    /// note (nil until first shown).
    private var noteColourBar: NoteColourBarView?

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
        strokeOverlay.wantsLayer = true
        strokeOverlay.autoresizingMask = [.width, .height]
        addSubview(strokeOverlay)
        strokeLayer.fillColor = NSColor.clear.cgColor
        strokeLayer.lineCap = .round
        strokeLayer.lineJoin = .round
        strokeOverlay.layer?.addSublayer(strokeLayer)
        shapeOverlay.wantsLayer = true
        shapeOverlay.autoresizingMask = [.width, .height]
        addSubview(shapeOverlay)
        shapeLayer.lineCap = .round
        shapeLayer.lineJoin = .round
        shapeOverlay.layer?.addSublayer(shapeLayer)
        connectorOverlay.wantsLayer = true
        connectorOverlay.autoresizingMask = [.width, .height]
        addSubview(connectorOverlay)
        connectorLayer.lineCap = .round
        connectorOverlay.layer?.addSublayer(connectorLayer)
        eraserOverlay.wantsLayer = true
        eraserOverlay.autoresizingMask = [.width, .height]
        addSubview(eraserOverlay)
        eraserLayer.fillColor = NSColor.clear.cgColor
        eraserLayer.strokeColor = NSColor.labelColor.withAlphaComponent(0.6).cgColor
        eraserOverlay.layer?.addSublayer(eraserLayer)
        lassoOverlay.wantsLayer = true
        lassoOverlay.autoresizingMask = [.width, .height]
        addSubview(lassoOverlay)
        lassoLayer.fillColor = NSColor.systemBlue.withAlphaComponent(0.08).cgColor
        lassoLayer.strokeColor = NSColor.systemBlue.cgColor
        lassoOverlay.layer?.addSublayer(lassoLayer)
        handlesOverlay.wantsLayer = true
        handlesOverlay.autoresizingMask = [.width, .height]
        addSubview(handlesOverlay)
        resizeHandleLayer.fillColor = NSColor.white.cgColor
        resizeHandleLayer.strokeColor = NSColor.labelColor.withAlphaComponent(0.4).cgColor
        handlesOverlay.layer?.addSublayer(resizeHandleLayer)
        rotateStemLayer.strokeColor = NSColor.labelColor.withAlphaComponent(0.4).cgColor
        rotateStemLayer.fillColor = NSColor.clear.cgColor
        handlesOverlay.layer?.addSublayer(rotateStemLayer)
        rotateGripLayer.fillColor = NSColor.white.cgColor
        rotateGripLayer.strokeColor = NSColor.labelColor.withAlphaComponent(0.4).cgColor
        handlesOverlay.layer?.addSublayer(rotateGripLayer)
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
        strokeOverlay.frame = bounds
        shapeOverlay.frame = bounds
        connectorOverlay.frame = bounds
        eraserOverlay.frame = bounds
        lassoOverlay.frame = bounds
        handlesOverlay.frame = bounds
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
        updateStrokePreview()
        updateShapePreview()
        updateConnectorPreview()
        updateLassoPreview()
        updateHandles()
        updateNoteColourBar()
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
            options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow],
            owner: self, userInfo: nil
        ))
    }

    override public func mouseEntered(with event: NSEvent) {
        // Take focus when the pointer arrives, so a pinch
        // and the keyboard work without a click first —
        // AppKit sends those to the first responder, and
        // the board is the only focusable view for now.
        window?.makeFirstResponder(self)
        updateEraserRing(at: convert(event.locationInWindow, from: nil))
    }

    override public func mouseExited(with event: NSEvent) {
        updateEraserRing(at: nil)
    }

    override public func mouseMoved(with event: NSEvent) {
        updateEraserRing(at: convert(event.locationInWindow, from: nil))
    }

    /// The eraser ring: a circle at the cursor, sized to
    /// the eraser's radius (12 world pixels, so 24 × zoom
    /// screen pixels across). It shows while the eraser
    /// tool is active and the pointer is over the board.
    private func updateEraserRing(at point: NSPoint?) {
        eraserOverlay.frame = bounds
        guard let point, toolState?.tool == .draw(.eraser) else {
            eraserLayer.path = nil
            return
        }
        let r = CGFloat(BoardErase.radius) * camera.zoom
        let circle = CGPath(ellipseIn: CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2), transform: nil)
        CardView.withoutLayerActions {
            eraserLayer.path = circle
            eraserLayer.lineWidth = 1
            eraserLayer.frame = bounds
        }
    }

    /// Erases the strokes the eraser touches at this world
    /// point, live: the ids join the sweep's set and the
    /// board loses them at once (the host re-renders, so
    /// they disappear as the eraser touches them). The
    /// sweep is committed as one undo step on mouseup.
    /// Returns true when at least one stroke went.
    @discardableResult
    private func eraseAt(_ world: Pt) -> Bool {
        let ids = BoardErase.strokesWithin(board: board, at: world)
        guard !ids.isEmpty else { return false }
        eraseIds.formUnion(ids)
        board.items.removeAll { eraseIds.contains($0.id) }
        return true
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
        // A double-click is the system's: NSEvent carries
        // the click count, which follows the user's
        // double-click speed in System Settings. The manual
        // 500 ms / 5 px rule missed real double-clicks that
        // were slightly slower or moved a little further,
        // so a double-click on empty space did nothing.
        let doubleClick = event.clickCount == 2
        if spaceHeld {
            panStart = (convert(event.locationInWindow, from: nil), camera)
            return
        }
        // A draw tool (pen, pencil, highlighter) starts a
        // stroke on press, whatever is under the cursor —
        // the Electron app's pen check comes before the
        // card hit-test, so a stroke can start on a card.
        // The eraser is a draw tool in the toolbar but a
        // different interaction, so it is not started here.
        if case .draw(let drawTool) = toolState?.tool, drawTool != .eraser {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            strokePoints = [world]
            strokeTool = drawTool
            // A stylus records its pressure per point, so
            // the stroke can thicken and thin with the
            // press; a mouse records none, and draws a
            // uniform stroke. A pressure is recorded only
            // when the first point carries one — a mouse
            // reports zero, a stylus reports its press.
            strokePressures = event.pressure > 0 ? [Double(event.pressure)] : nil
            return
        }
        // The eraser starts a sweep on press: it erases the
        // strokes it touches at once, and keeps erasing as
        // the pointer moves. The sweep is one undo step.
        if toolState?.tool == .draw(.eraser) {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            eraseActive = true
            eraseIds = []
            _ = eraseAt(world)
            updateEraserRing(at: point)
            return
        }
        // A shape tool starts a shape drag on press (the
        // Electron app's shape check, also before the card
        // hit-test): the drag sizes the shape, and it is
        // committed on release.
        if case .shape(let shape) = toolState?.tool {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            shapeStart = world
            shapeCurrent = world
            shapeKind = shape
            updateShapePreview()
            return
        }
        // The connector tool starts a connector drag on
        // press: from the card under the cursor when it is
        // anchorable, otherwise from the bare point.
        if toolState?.tool == .connector {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            if let hit = HitTest.hit(board: board, at: world), isAnchorable(hit) {
                connectorFrom = .item(hit.id)
            } else {
                connectorFrom = .point(world)
            }
            connectorCurrent = world
            updateConnectorPreview()
            return
        }
        // The lasso mode (the select tool's loop) starts a
        // loop on press, whatever is under the cursor —
        // the Electron app's lasso check comes before the
        // card hit-test, so a loop can start on a card.
        if toolState?.tool == .select(.lasso) {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            lassoPoints = [world]
            updateLassoPreview()
            return
        }
        // The handles, before the card hit-test: with one
        // card selected, a press on its rotate grip starts
        // a rotate drag, and a press on its resize corner
        // starts a resize drag (the Electron app's
        // rotateHit / cornerHit, in that order).
        if toolState?.tool == .select(.select), selected.count == 1,
           let id = selected.first,
           let item = board.items.first(where: { $0.id == id }) {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            if Handles.rotateHit(item: item, at: world, zoom: camera.zoom) {
                rotateDrag = (id: id, origRot: Handles.itemRotation(of: item))
                rotateMoved = false
                return
            }
            if Handles.cornerHit(board: board, item: item, at: world, zoom: camera.zoom) {
                resizeDrag = (id: id, startWorld: world, origW: item.size.w, origH: item.size.h)
                resizeMoved = false
                return
            }
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
            // A double-click on empty space creates a note
            // there and opens it for editing.
            if doubleClick, toolState?.tool == .select(.select) {
                createTextNoteAt(world)
                return
            }
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
        // A double-click on a text note opens it for
        // editing (a double-click on any other card does
        // nothing special yet — it falls through to the
        // normal selection below).
        if doubleClick, toolState?.tool == .select(.select), case .text = item.kind {
            startTextEdit(id: item.id)
            return
        }
        // A press on the clicked card's resize corner starts
        // a resize drag for that card (the Electron app's
        // corner grab: it selects the card first, replacing
        // the selection, then resizes it). This runs before
        // the Shift-toggle selection below, so a corner grab
        // never deselects the card it resizes.
        if Handles.cornerHit(board: board, item: item, at: world, zoom: camera.zoom) {
            selected = groupIds(of: item)
            resizeDrag = (id: item.id, startWorld: world, origW: item.size.w, origH: item.size.h)
            resizeMoved = false
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

    // MARK: - Text notes

    /// Creates a text note at this world point and opens
    /// it for editing: a silent add (260×48, empty, size
    /// 16, ink colour), with no save yet. The commit saves
    /// the typed text, or removes the note when it is
    /// empty — so an empty note leaves no board change and
    /// no undo step behind.
    private func createTextNoteAt(_ world: Pt) {
        var next = board
        let id = next.nextId
        next.nextId += 1
        let text = TextPayload(text: "", bold: false, size: 16, color: "#1A1A1A", bg: nil)
        next.items.append(Item(id: id, pos: world, size: Size(w: 260, h: 48), group: nil, kind: .text(text), rotation: nil))
        board = next
        startTextEdit(id: id)
    }

    /// Opens the in-place editor over a text card: the
    /// editor shows the card's text at its size and colour,
    /// on its background, with the cursor at the end. The
    /// editor is a subview of the card, so it moves and
    /// resizes with it; the card's own text layer is hidden
    /// while editing, so the text does not draw twice.
    private func startTextEdit(id: Int) {
        guard let item = board.items.first(where: { $0.id == id }),
              case .text(let payload) = item.kind else { return }
        // Remove any editor already open.
        if let editor = noteEditor {
            editor.removeFromSuperview()
            noteEditor = nil
            editingNoteId = nil
        }
        guard let cardView = cardContainer.subviews.compactMap({ $0 as? TextCardView }).first(where: { $0.currentItem?.id == id }) else { return }
        let editor = NoteEditorView()
        editor.string = payload.text
        // The editor is inside the card, which is
        // screen-sized, so the font is the text size scaled
        // by the zoom — the same size the card renders it
        // at — and the text lands where the card drew it.
        let zoom = item.size.w > 0 ? Double(cardView.bounds.width) / item.size.w : 1
        editor.font = NSFont.systemFont(ofSize: CGFloat(payload.size) * CGFloat(zoom), weight: payload.bold ? .bold : .regular)
        editor.textColor = NSColor.fromHex(payload.color) ?? .labelColor
        editor.backgroundColor = NSColor.fromHex(payload.bg ?? "#FFFFFF") ?? .white
        editor.frame = cardView.bounds
        editor.autoresizingMask = [.width, .height]
        editor.onEndEditing = { [weak self] _ in self?.commitTextEdit() }
        cardView.setEditing(true)
        cardView.addSubview(editor)
        noteEditor = editor
        editingNoteId = id
        window?.makeFirstResponder(editor)
        // Cursor at the end of the text.
        editor.setSelectedRange(NSRange(location: editor.string.count, length: 0))
    }

    /// Commits the open editor: the text is saved (with
    /// the card's height re-measured) as one undo step, or
    /// the note is removed when the text is empty or only
    /// whitespace. The editor is removed and the card's
    /// text layer shown again, either way.
    private func commitTextEdit() {
        guard let id = editingNoteId, let editor = noteEditor else { return }
        let text = editor.string
        // Clear the editor references BEFORE removing the
        // view: removing it fires viewWillMove(toWindow:
        // nil), which ends the edit and calls this commit
        // again — with the references already cleared, the
        // re-entrant call returns at once instead of
        // committing twice and removing the view while it
        // is already being removed (which crashed the app
        // on a double-clicked text card).
        noteEditor = nil
        editingNoteId = nil
        editor.removeFromSuperview()
        if let cardView = cardContainer.subviews.compactMap({ $0 as? TextCardView }).first(where: { $0.currentItem?.id == id }) {
            cardView.setEditing(false)
        }
        var next = board
        guard let index = next.items.firstIndex(where: { $0.id == id }) else { return }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // An empty note is not a note: remove it. For a
            // new note (never saved) this leaves no board
            // change and no undo step; for an existing note
            // it is one undo step.
            next.items.remove(at: index)
            board = next
            onBoardMutate?(next)
            return
        }
        guard case .text(var payload) = next.items[index].kind else { return }
        payload.text = text
        next.items[index].kind = .text(payload)
        next.items[index].size.h = TextMeasure.noteHeight(text: text, fontSize: payload.size, width: next.items[index].size.w)
        board = next
        onBoardMutate?(next)
    }

    // MARK: - Note colour bar

    /// Shows, hides and positions the note colour bar. It
    /// appears when at least one selected card is a text
    /// note, beside the first one (in board order), with
    /// the notes' background as the active swatch when they
    /// agree. Placement follows the Electron app's rule:
    /// 8px left of the note, top-aligned, flipping right
    /// when the left side has no room (the toolbar occupies
    /// the left edge) — and hidden when the note is fully
    /// off-screen or neither side is safe.
    private func updateNoteColourBar() {
        let selectedTextNotes = board.items.filter { item in
            guard selected.contains(item.id) else { return false }
            if case .text = item.kind { return true }
            return false
        }
        guard let first = selectedTextNotes.first else {
            noteColourBar?.isHidden = true
            return
        }
        // The note's screen frame, computed from the model
        // and the camera (not the card view's frame, which
        // the host repositions after the camera changes —
        // the bar must follow the note in the same step).
        let zoom = camera.zoom
        let frame = NSRect(
            x: (first.pos.x - camera.x) * zoom,
            y: (first.pos.y - camera.y) * zoom,
            width: first.size.w * zoom,
            height: first.size.h * zoom
        )
        // The note must be at least partly on-screen.
        guard frame.intersects(bounds) else {
            noteColourBar?.isHidden = true
            return
        }
        let size = NoteColourBarView.barSize
        let gap: CGFloat = 8
        // The toolbar occupies x 12..68; the bar on the
        // left must clear it entirely.
        let toolbarRight: CGFloat = 68
        let leftX = frame.minX - gap - size.width
        let rightX = frame.maxX + gap
        // Top-aligned with the note (the view is flipped,
        // so the origin is the top edge; the top is never
        // clamped — the bar may extend past the bottom).
        let y = frame.minY
        let origin: NSPoint?
        if leftX >= toolbarRight {
            origin = NSPoint(x: leftX, y: y)
        } else if rightX + size.width <= bounds.width - gap {
            origin = NSPoint(x: rightX, y: y)
        } else {
            origin = nil
        }
        guard let origin else {
            noteColourBar?.isHidden = true
            return
        }
        if noteColourBar == nil {
            let bar = NoteColourBarView()
            bar.onPick = { [weak self] hex in self?.setNoteBackground(hex) }
            addSubview(bar)
            noteColourBar = bar
        }
        guard let bar = noteColourBar else { return }
        // The active swatch is the notes' background when
        // they agree (a note with no bg is white).
        let bgs = Set(selectedTextNotes.compactMap { item -> String? in
            guard case .text(let payload) = item.kind else { return nil }
            return payload.bg ?? "#FFFFFF"
        })
        bar.activeHex = bgs.count == 1 ? bgs.first : nil
        bar.frame = NSRect(origin: origin, size: size)
        bar.isHidden = false
    }

    /// Sets the background of every selected text note to
    /// this colour, as one undo step.
    private func setNoteBackground(_ hex: String) {
        var next = board
        for index in next.items.indices where selected.contains(next.items[index].id) {
            guard case .text(var payload) = next.items[index].kind else { continue }
            payload.bg = hex
            next.items[index].kind = .text(payload)
        }
        board = next
        onBoardMutate?(next)
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
        // A resize drag: the size follows the pointer from
        // the drag's start size (the Electron app's
        // resizeItem, clamped to 48×48, with a stroke's
        // points scaling with the frame). The board is
        // mutated live so the card follows; the commit is
        // on mouseUp.
        if let resize = resizeDrag {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            if hypot(world.x - resize.startWorld.x, world.y - resize.startWorld.y) > 2 {
                resizeMoved = true
            }
            BoardResize.resize(&board, id: resize.id, newW: resize.origW + (world.x - resize.startWorld.x), newH: resize.origH + (world.y - resize.startWorld.y))
            updateHandles()
            return
        }
        // A rotate drag: the rotation follows the angle from
        // the card's centre to the pointer (Shift snaps to
        // 15°). The board is mutated live so the card
        // follows; the commit is on mouseUp.
        if let rotate = rotateDrag {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            guard let item = board.items.first(where: { $0.id == rotate.id }) else { return }
            let rot = Handles.rotateAngleFor(world: world, item: item, snap: event.modifierFlags.contains(.shift))
            if abs(rot - rotate.origRot) > 1 {
                rotateMoved = true
            }
            BoardRotate.setRotation(&board, id: rotate.id, rotation: rot)
            updateHandles()
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
        // A stroke: a point is appended only once the
        // pointer has moved more than 2 world pixels from
        // the last one (2 / zoom), so a slow drag does not
        // pile up duplicate points. The preview redraws
        // from the points so far.
        if var points = strokePoints {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            let last = points[points.count - 1]
            if hypot(world.x - last.x, world.y - last.y) > 2 / camera.zoom {
                points.append(world)
                strokePoints = points
                if strokePressures != nil {
                    strokePressures?.append(Double(event.pressure))
                }
                updateStrokePreview()
            }
            return
        }
        // An erase sweep: every stroke the eraser touches
        // goes at once, and the ring follows the cursor.
        if eraseActive {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            _ = eraseAt(world)
            updateEraserRing(at: point)
            return
        }
        // A shape drag: the current corner follows the
        // pointer, and the preview redraws at the drag's
        // rect.
        if shapeStart != nil {
            let point = convert(event.locationInWindow, from: nil)
            shapeCurrent = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            updateShapePreview()
            return
        }
        // A connector drag: the target end follows the
        // pointer, and the preview redraws from the source
        // anchor to it.
        if connectorFrom != nil {
            let point = convert(event.locationInWindow, from: nil)
            connectorCurrent = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            updateConnectorPreview()
            return
        }
        // A lasso loop: a point is appended only once the
        // pointer has moved more than 2 world pixels from
        // the last one (2 / zoom), and the preview redraws
        // from the points so far.
        if var points = lassoPoints {
            let point = convert(event.locationInWindow, from: nil)
            let world = CameraMath.screenToWorld(Pt(x: Double(point.x), y: Double(point.y)), camera: camera)
            let last = points[points.count - 1]
            if hypot(world.x - last.x, world.y - last.y) > 2 / camera.zoom {
                points.append(world)
                lassoPoints = points
                updateLassoPreview()
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
        // A resize or rotate drag that moved commits as one
        // undo step and one save. A click on a handle that
        // never moved commits nothing.
        if resizeDrag != nil || rotateDrag != nil {
            if resizeMoved || rotateMoved {
                onBoardMutate?(board)
            }
            resizeDrag = nil
            resizeMoved = false
            rotateDrag = nil
            rotateMoved = false
            updateHandles()
            return
        }
        // A stroke that drew at least two points commits
        // as one item (one undo step, one save). A click
        // that never moved is a single point and commits
        // nothing — BoardStroke.add returns nil for it.
        if let points = strokePoints {
            if points.count >= 2, let tool = strokeTool {
                let style = BoardViewport.strokeStyle(for: tool)
                var next = board
                if BoardStroke.add(
                    &next,
                    points: points,
                    color: toolState?.penColor ?? "#1A1A1A",
                    width: style.width,
                    marker: style.marker,
                    pencil: style.pencil ? true : nil,
                    pressures: strokePressures
                ) != nil {
                    onBoardMutate?(next)
                }
            }
            strokePoints = nil
            strokePressures = nil
            strokeTool = nil
            updateStrokePreview()
            return
        }
        // An erase sweep that erased anything commits as
        // one undo step and one save. A sweep that erased
        // nothing leaves no step behind. The ids are
        // re-applied to the current board, so the commit
        // holds even if the board was refreshed mid-sweep.
        if eraseActive {
            if !eraseIds.isEmpty {
                var next = board
                next.items.removeAll { eraseIds.contains($0.id) }
                onBoardMutate?(next)
            }
            eraseActive = false
            eraseIds = []
            return
        }
        // A shape drag commits as one item (one undo step,
        // one save) when it spans at least 10×10 world
        // pixels on both axes; a smaller drag is a click
        // and commits nothing. The fill is the pen colour
        // and the outline flag comes from the geometry
        // flyout's column.
        if let start = shapeStart, let current = shapeCurrent, let kind = shapeKind {
            var next = board
            if BoardShape.add(
                &next,
                shape: kind,
                from: start,
                to: current,
                fill: toolState?.penColor ?? "#1A1A1A",
                outline: toolState?.shapeOutline ?? false
            ) != nil {
                onBoardMutate?(next)
            }
            shapeStart = nil
            shapeCurrent = nil
            shapeKind = nil
            updateShapePreview()
            return
        }
        // A connector drag commits as one item (one undo
        // step, one save) when it is not degenerate and not
        // a self-connector. The target is the anchorable
        // card under the release point, otherwise the bare
        // point. The drawn connector takes the selected pen
        // colour.
        if let from = connectorFrom, let current = connectorCurrent {
            let to: Anchor
            if let hit = HitTest.hit(board: board, at: current), isAnchorable(hit) {
                to = .item(hit.id)
            } else {
                to = .point(current)
            }
            var next = board
            if BoardConnector.add(&next, from: from, to: to, color: toolState?.penColor ?? "#1A1A1A") != nil {
                onBoardMutate?(next)
            }
            connectorFrom = nil
            connectorCurrent = nil
            updateConnectorPreview()
            return
        }
        // A lasso loop selects on release: a real loop
        // (at least 3 points, spanning at least 4 world
        // pixels on an axis) selects everything it
        // touches; a click, not a loop, selects what is
        // under the cursor, the way the select tool does.
        // Either way it is only a selection change, never
        // an undo step.
        if let points = lassoPoints {
            let xs = points.map(\.x), ys = points.map(\.y)
            let w = (xs.max() ?? 0) - (xs.min() ?? 0)
            let h = (ys.max() ?? 0) - (ys.min() ?? 0)
            if points.count < 3 || (w < 4 && h < 4) {
                let end = points.last ?? Pt(x: 0, y: 0)
                if let hit = HitTest.hit(board: board, at: end) {
                    selected = groupIds(of: hit)
                } else {
                    selected = []
                }
            } else {
                selected = Set(LassoSelection.select(board: board, points: points))
            }
            lassoPoints = nil
            updateLassoPreview()
            return
        }
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

    /// Draws (or hides) the live shape preview: the shape
    /// being dragged, in the pen colour, at the drag's
    /// screen rect. A filled shape is solid at 0.85
    /// opacity (the Electron preview); an outline shape is
    /// a 2px stroke with no fill. A rect is a rounded rect
    /// (12px radius, scaled by the zoom); every other shape
    /// comes from ShapePath.
    private func updateShapePreview() {
        shapeOverlay.frame = bounds
        guard let start = shapeStart, let current = shapeCurrent, let kind = shapeKind else {
            shapeLayer.path = nil
            return
        }
        let x0 = min(start.x, current.x), y0 = min(start.y, current.y)
        let w = abs(current.x - start.x), h = abs(current.y - start.y)
        let rect = CGRect(
            x: (x0 - camera.x) * camera.zoom,
            y: (y0 - camera.y) * camera.zoom,
            width: w * camera.zoom,
            height: h * camera.zoom
        )
        let fill = (NSColor.fromHex(toolState?.penColor ?? "#1A1A1A") ?? .labelColor).cgColor
        let outline = toolState?.shapeOutline ?? false
        CardView.withoutLayerActions {
            if kind == .rect {
                shapeLayer.path = CGPath(
                    roundedRect: rect, cornerWidth: 12 * camera.zoom, cornerHeight: 12 * camera.zoom, transform: nil
                )
            } else {
                shapeLayer.path = ShapePath.path(for: kind, in: rect)
            }
            if outline {
                shapeLayer.fillColor = NSColor.clear.cgColor
                shapeLayer.strokeColor = fill
                shapeLayer.lineWidth = 2 * camera.zoom
                shapeLayer.opacity = 1
            } else {
                shapeLayer.fillColor = fill
                shapeLayer.strokeColor = NSColor.clear.cgColor
                shapeLayer.opacity = 0.85
            }
            shapeLayer.frame = bounds
        }
    }

    /// Draws (or hides) the live connector preview: a line
    /// from the source anchor's point to the pointer, in
    /// the pen colour at 2 world pixels (the Electron
    /// preview's width). The drawn connector takes the
    /// selected pen colour; the toolbar's arrow stays
    /// black.
    private func updateConnectorPreview() {
        connectorOverlay.frame = bounds
        guard let from = connectorFrom, let current = connectorCurrent,
              let a = CameraMath.anchorPoint(board: board, anchor: from) else {
            connectorLayer.path = nil
            return
        }
        let aScreen = Pt(x: (a.x - camera.x) * camera.zoom, y: (a.y - camera.y) * camera.zoom)
        let bScreen = Pt(x: (current.x - camera.x) * camera.zoom, y: (current.y - camera.y) * camera.zoom)
        let line = CGMutablePath()
        line.move(to: CGPoint(x: aScreen.x, y: aScreen.y))
        line.addLine(to: CGPoint(x: bScreen.x, y: bScreen.y))
        CardView.withoutLayerActions {
            connectorLayer.path = line
            connectorLayer.strokeColor = (NSColor.fromHex(toolState?.penColor ?? "#1A1A1A") ?? .labelColor).cgColor
            connectorLayer.lineWidth = 2 * camera.zoom
            connectorLayer.fillColor = NSColor.clear.cgColor
            connectorLayer.frame = bounds
        }
    }

    /// Whether a card can be a connector anchor: anything
    /// except a stroke or another connector (the Electron
    /// app's anchorable rule).
    private func isAnchorable(_ item: Item) -> Bool {
        switch item.kind {
        case .stroke, .connector: return false
        default: return true
        }
    }

    /// Draws (or hides) the live lasso loop: a closed path
    /// through the points so far (the last point joins back
    /// to the first), filled with the accent at 0.08 and
    /// stroked with it at 1 world pixel — the Electron
    /// app's lasso preview. The fill shows the region the
    /// loop will select.
    private func updateLassoPreview() {
        lassoOverlay.frame = bounds
        guard let points = lassoPoints, points.count >= 2 else {
            lassoLayer.path = nil
            return
        }
        let screen = points.map { Pt(x: ($0.x - camera.x) * camera.zoom, y: ($0.y - camera.y) * camera.zoom) }
        let path = CGMutablePath()
        path.move(to: CGPoint(x: screen[0].x, y: screen[0].y))
        for pt in screen.dropFirst() {
            path.addLine(to: CGPoint(x: pt.x, y: pt.y))
        }
        path.closeSubpath()
        CardView.withoutLayerActions {
            lassoLayer.path = path
            lassoLayer.lineWidth = 1 * camera.zoom
            lassoLayer.frame = bounds
        }
    }

    /// Draws (or hides) the resize and rotate handles.
    /// They show only when exactly one item is selected:
    /// the resize grip at the item's bottom-right corner
    /// (never for a connector), and the rotate grip 28
    /// world pixels above its top edge centre, with a stem
    /// pointing back at the card. A handle off-screen is
    /// hidden. The grips are 10 screen pixels across.
    private func updateHandles() {
        handlesOverlay.frame = bounds
        guard selected.count == 1,
              let id = selected.first,
              let item = board.items.first(where: { $0.id == id }) else {
            resizeHandleLayer.path = nil
            rotateStemLayer.path = nil
            rotateGripLayer.path = nil
            return
        }
        let size: CGFloat = 10
        CardView.withoutLayerActions {
            // Resize: a white square with a grey border, at
            // the bottom-right corner (rotated with the
            // item). Hidden for a connector and off-screen.
            if let corner = Handles.cornerWorld(board: board, item: item) {
                let sx = CGFloat((corner.x - camera.x) * camera.zoom)
                let sy = CGFloat((corner.y - camera.y) * camera.zoom)
                if sx >= 0, sy >= 0, sx <= bounds.width, sy <= bounds.height {
                    resizeHandleLayer.path = CGPath(
                        roundedRect: CGRect(x: sx - size / 2, y: sy - size / 2, width: size, height: size),
                        cornerWidth: 2, cornerHeight: 2, transform: nil
                    )
                    resizeHandleLayer.lineWidth = 1
                } else {
                    resizeHandleLayer.path = nil
                }
            } else {
                resizeHandleLayer.path = nil
            }
            // Rotate: a circle above the top edge, with a
            // stem back to the card's top centre (the grip
            // rotates with the card, so the stem always
            // points at it). Hidden when the item is not
            // rotatable, and off-screen.
            if let handle = Handles.rotateHandleWorld(item: item, zoom: camera.zoom) {
                let hx = CGFloat((handle.x - camera.x) * camera.zoom)
                let hy = CGFloat((handle.y - camera.y) * camera.zoom)
                let centre = CameraMath.centre(of: item)
                let top = Handles.rotatePoint(
                    Pt(x: centre.x, y: item.pos.y),
                    around: centre, by: Handles.itemRotation(of: item)
                )
                let tx = CGFloat((top.x - camera.x) * camera.zoom)
                let ty = CGFloat((top.y - camera.y) * camera.zoom)
                if hx >= 0, hy >= 0, hx <= bounds.width, hy <= bounds.height {
                    let stem = CGMutablePath()
                    stem.move(to: CGPoint(x: hx, y: hy))
                    stem.addLine(to: CGPoint(x: tx, y: ty))
                    rotateStemLayer.path = stem
                    rotateStemLayer.lineWidth = 1
                    rotateGripLayer.path = CGPath(
                        ellipseIn: CGRect(x: hx - size / 2, y: hy - size / 2, width: size, height: size),
                        transform: nil
                    )
                    rotateGripLayer.lineWidth = 1
                } else {
                    rotateStemLayer.path = nil
                    rotateGripLayer.path = nil
                }
            } else {
                rotateStemLayer.path = nil
                rotateGripLayer.path = nil
            }
            resizeHandleLayer.frame = bounds
            rotateStemLayer.frame = bounds
            rotateGripLayer.frame = bounds
        }
    }

    private static func strokeStyle(for tool: DrawTool) -> (width: Double, marker: Bool, pencil: Bool) {
        switch tool {
        case .pen: return (3, false, false)
        case .pencil: return (2, false, true)
        case .highlighter: return (12, true, false)
        case .eraser: return (3, false, false)
        }
    }

    /// Draws (or hides) the live stroke preview: the smooth
    /// Catmull-Rom path through the points so far, in the
    /// pen colour at the tool's width (scaled by the zoom),
    /// with the highlighter at 0.45 opacity. The path is
    /// built in world-local coordinates (rebased by the
    /// points' bbox min, like the committed card) and then
    /// mapped to screen coordinates, so the preview is the
    /// same curve the committed stroke will be.
    private func updateStrokePreview() {
        strokeOverlay.frame = bounds
        guard let points = strokePoints, let tool = strokeTool, points.count >= 2 else {
            strokeLayer.path = nil
            return
        }
        let style = BoardViewport.strokeStyle(for: tool)
        let minX = points.map(\.x).min() ?? 0
        let minY = points.map(\.y).min() ?? 0
        let screenMinX = (minX - camera.x) * camera.zoom
        let screenMinY = (minY - camera.y) * camera.zoom
        var transform = CGAffineTransform(
            a: camera.zoom, b: 0, c: 0, d: camera.zoom,
            tx: screenMinX, ty: screenMinY
        )
        CardView.withoutLayerActions {
            strokeLayer.path = StrokePath.path(for: points)?.copy(using: &transform)
            strokeLayer.lineWidth = CGFloat(style.width) * camera.zoom
            strokeLayer.strokeColor = (NSColor.fromHex(toolState?.penColor ?? "#1A1A1A") ?? .labelColor).cgColor
            strokeLayer.opacity = style.marker ? 0.45 : 1
            strokeLayer.frame = bounds
        }
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
