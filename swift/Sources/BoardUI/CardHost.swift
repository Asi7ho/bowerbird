import AppKit
import BowerbirdCore

/// The card host: the recycled `NSView`s inside the
/// viewport's card container. Only the visible set is built
/// (the Electron app's 200-world-unit culling margin, so
/// cards at the edge do not pop in and out while panning);
/// a view that leaves the viewport is returned to a pool
/// keyed by kind and reused for the next card of that kind.
///
/// Stacking is visual only, like the Electron app: the
/// subview order is the board order, with the selected cards
/// moved to the front. The model is never reordered by
/// selection.
///
/// LOD: below 25% zoom, heavy live views are swapped for
/// cached snapshots. The native media views land in M4/M5,
/// so for now every media kind is already a static tile —
/// the threshold and the decision point are here, and the
/// snapshot swap replaces the placeholder branch when the
/// live views arrive.
///
/// Connectors are not cards: they are drawn as lines with
/// arrowheads in an overlay behind the cards (the Electron
/// app's #world layer). They move to the Metal ink layer in
/// M3, when the live drawing lands and the ink pipeline
/// exists.
public final class CardHost {
    /// Below this zoom, heavy live views become snapshots.
    public static let lodZoomThreshold: Double = 0.25

    public var board: Board {
        didSet { render() }
    }

    public var camera: Camera {
        didSet { reposition() }
    }

    /// The selected item ids. Setting it updates the rings
    /// and the stacking, without rebuilding the cards.
    public var selected: Set<Int> = [] {
        didSet { updateSelection() }
    }

    private let container: NSView
    // Flipped (y down), like the container: the connector
    // paths are computed in world coordinates, y down, and a
    // plain NSView's layer is y-up, which mirrored the line
    // inside the overlay — and the mirror moved as the
    // overlay's frame (the visible rect) changed with the
    // pan, so the arrow drifted while the cards stayed put.
    private let connectorOverlay = WorldView()
    // The group frames: a dashed rounded rect around each
    // group's members, with the group's label, drawn below
    // the cards (the Electron app's #group-frames layer).
    // Same flipped overlay as the connectors, same visible
    // rect frame.
    private let groupFrameOverlay = WorldView()
    private var shown: [Int: CardView] = [:]
    private var pool: [String: [CardView]] = [:]

    public init(container: NSView, board: Board, camera: Camera) {
        self.container = container
        self.board = board
        self.camera = camera
        groupFrameOverlay.wantsLayer = true
        container.addSubview(groupFrameOverlay)
        connectorOverlay.wantsLayer = true
        container.addSubview(connectorOverlay)
        render()
    }

    /// Rebuild the visible set: which cards are shown, in
    /// which order, and the connector overlay. Called when
    /// the BOARD changes (a card's content moved, was added
    /// or removed): every visible card is reconfigured.
    /// A camera move calls `reposition()` instead, which
    /// only moves the cards — reconfiguring on every zoom
    /// step reloaded the images and rebuilt the text, so
    /// the content visibly shifted inside the card while
    /// zooming.
    public func render() {
        layoutVisible(reconfigure: true, board: board)
    }

    /// A camera move: the visible set is recomputed and the
    /// cards are moved to their new screen positions, but a
    /// card that was already shown keeps its content — it
    /// is not reconfigured, so its text and image do not
    /// rebuild and shift while zooming or panning. Only a
    /// card entering the viewport is configured (once).
    public func reposition() {
        layoutVisible(reconfigure: false, board: board)
    }

    /// The layout, for a given board: the visible set is
    /// recomputed from that board's positions, and the
    /// cards are placed at their screen positions. The
    /// board is a parameter (not always `self.board`) so a
    /// live drag can lay out the dragged positions with
    /// the same code as a camera move — the drag and the
    /// camera share this path, so a dragged card renders
    /// exactly as a panned one does.
    private func layoutVisible(reconfigure: Bool, board: Board) {
        // The viewport size is the container's FRAME (screen
        // points), not its bounds: the bounds are the camera,
        // already in world units (viewport / zoom), and
        // visibleRect divides by the zoom itself — passing
        // the bounds double-divides, so at zoom > 1 cards at
        // the edge were culled and never shown.
        let viewport = Size(w: Double(container.frame.width), h: Double(container.frame.height))
        let visible = CameraMath.visibleRect(camera: camera, viewport: viewport)
        var visibleIds = Set<Int>()
        var ordered: [Item] = []
        for item in board.items {
            guard isVisible(item: item, board: board, visible: visible) else { continue }
            visibleIds.insert(item.id)
            ordered.append(item)
        }
        // Return the views that left the viewport to the pool.
        for (id, view) in shown where !visibleIds.contains(id) {
            view.removeFromSuperview()
            if let item = view.currentItem {
                pool[CardViews.kindName(of: item), default: []].append(view)
            }
            shown.removeValue(forKey: id)
        }
        // Build or reuse a view for each visible card, in
        // board order, and place it at its SCREEN position:
        // screen = (world − camera) × zoom. The card is
        // positioned where it is drawn (there is no camera
        // transform on the container — a layer transform is
        // applied about the layer's centre, which shifted
        // the display away from the hit-test). A recycled
        // view is reconfigured for its new item; a view
        // that was already showing this item is only moved.
        // The frames are set with layer actions disabled:
        // a CALayer animates its frame by default, so a
        // zoom step made the content drift inside the card
        // for a quarter of a second.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        for item in ordered {
            let alreadyShown = shown[item.id] != nil
            let view = shown[item.id] ?? dequeueView(for: item) ?? CardViews.view(for: item)
            guard let view else { continue }
            if reconfigure || !alreadyShown {
                view.configure(item: item)
            }
            // Reset the rotation before setting the frame:
            // a frame is the bounding box of the rotated
            // rect, so setting it while a rotation is still
            // applied computes the wrong bounds — a recycled
            // view that carried a different rotation from
            // its last item landed in the wrong place, and
            // only a later layout, with the right rotation
            // already in place, put it right. That is why
            // the bird's rotated parts sat wrong on load
            // and snapped into place once something moved
            // them. The frame is always set unrotated; the
            // rotation is applied after, about the centre.
            view.layer?.transform = CATransform3DIdentity
            view.frame = CGRect(
                x: (item.pos.x - camera.x) * camera.zoom,
                y: (item.pos.y - camera.y) * camera.zoom,
                width: item.size.w * camera.zoom,
                height: item.size.h * camera.zoom
            )
            if let rotation = item.rotation {
                // Negated: a rotation is clockwise-positive
                // in the board (the DOM, y-down), while the
                // card's layer is y-up, where a positive
                // angle turns counterclockwise on screen —
                // an un-negated rotation turned a card the
                // wrong way, and its handles (computed in
                // world coordinates) no longer sat on its
                // corners.
                view.layer?.transform = CATransform3DMakeRotation(-CGFloat(rotation) * .pi / 180, 0, 0, 1)
            }
            view.isSelected = selected.contains(item.id)
            if view.superview == nil {
                container.addSubview(view)
            }
            shown[item.id] = view
        }
        // Stacking: unselected in board order, then selected
        // in board order, so the selected cards are on top.
        let unselected = ordered.filter { !selected.contains($0.id) }
        let selectedItems = ordered.filter { selected.contains($0.id) }
        for item in unselected + selectedItems {
            if let view = shown[item.id] {
                container.addSubview(view, positioned: .above, relativeTo: nil)
            }
        }
        renderConnectors(board: board)
        renderGroupFrames(board: board)
    }

    /// Move the given items' views by a world delta, without
    /// reconfiguring them and without touching the board: a
    /// live drag moves the views, and the board is committed
    /// on pointerup. The delta is the TOTAL from the drag
    /// start, so each frame is computed from the board's
    /// positions and cannot drift. This is the reposition
    /// path (frames only, like a camera move) run against
    /// the dragged positions — the drag and the camera use
    /// the same layout, so a dragged card renders exactly
    /// as a panned one does.
    public func moveViews(_ ids: Set<Int>, by delta: Pt) {
        var dragged = board
        BoardMove.move(&dragged, ids: ids, by: delta)
        layoutVisible(reconfigure: false, board: dragged)
    }

    private func updateSelection() {
        for (id, view) in shown {
            view.isSelected = selected.contains(id)
        }
        // Re-apply the stacking (selected cards on top)
        // without reconfiguring the content.
        reposition()
    }

    private func isVisible(item: Item, board: Board, visible: WorldRect) -> Bool {
        // Rotated strokes are exempt from the card-loop cull
        // (their bbox does not describe where they paint).
        if case .stroke = item.kind, item.rotation != nil { return true }
        let bounds = CameraMath.itemBounds(board: board, item: item)
        return bounds.intersects(visible)
    }

    /// Dequeue a recycled view of the item's kind, or nil
    /// when the pool is empty. The caller reconfigures it
    /// for the item through `configure(item:)`.
    private func dequeueView(for item: Item) -> CardView? {
        let key = CardViews.kindName(of: item)
        guard var views = pool[key], !views.isEmpty else { return nil }
        let view = views.removeLast()
        pool[key] = views
        return view
    }

    // MARK: - Group frames

    /// The frame sits 24px outside the member union (the
    /// Electron app's GROUP_PAD).
    private static let groupPad: Double = 24

    private func renderGroupFrames(board: Board) {
        // The overlay fills the viewport (screen
        // coordinates); the frame rects and labels are
        // mapped to the screen, so they sit on the cards.
        groupFrameOverlay.frame = CGRect(x: 0, y: 0, width: container.frame.width, height: container.frame.height)
        // One frame per group: the union of the members'
        // bounds, padded. A group with fewer than two
        // members has no frame (the Electron app's
        // renderGroupFrames only draws groups of 2+).
        let groupIds = Set(board.items.compactMap { $0.group })
        var frames: [(group: Int, rect: CGRect, isSelected: Bool)] = []
        for group in groupIds {
            let members = board.items.filter { $0.group == group }
            guard members.count >= 2 else { continue }
            var union: WorldRect?
            for member in members {
                let b = CameraMath.itemBounds(board: board, item: member)
                union = union.map { WorldRect(
                    x: min($0.x, b.x), y: min($0.y, b.y),
                    w: max($0.x + $0.w, b.x + b.w) - min($0.x, b.x),
                    h: max($0.y + $0.h, b.y + b.h) - min($0.y, b.y)
                ) } ?? b
            }
            guard var rect = union else { continue }
            rect = WorldRect(
                x: rect.x - Self.groupPad, y: rect.y - Self.groupPad,
                w: rect.w + Self.groupPad * 2, h: rect.h + Self.groupPad * 2
            )
            // The frame, in screen coordinates.
            let screenRect = CGRect(
                x: (rect.x - camera.x) * camera.zoom,
                y: (rect.y - camera.y) * camera.zoom,
                width: rect.w * camera.zoom,
                height: rect.h * camera.zoom
            )
            let isSelected = members.allSatisfy { selected.contains($0.id) }
            frames.append((group, screenRect, isSelected))
        }
        // The frames, as shape layers (recreated each
        // render, like the connector paths). The label is a
        // text layer in the same pass — a quiet name inside
        // the frame's top-left corner, not a white chip
        // straddling the border: the chip read as a floating
        // box and the name sat on the dashed line. A
        // live-import group (one with a source — the bird,
        // from an SVG) shows NO label: the Electron app
        // treats it as a single imported piece, not a named
        // group, so its frame is bare until it is selected.
        groupFrameOverlay.layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
        for (group, rect, isSelected) in frames {
            let path = CGPath(
                roundedRect: rect,
                // The radius scales with the zoom, like the
                // cards': a fixed 12 screen pixels made the
                // frame a pill or a circle when dezoomed, the
                // frame shrinking while the corners stayed fat.
                cornerWidth: 12 * camera.zoom, cornerHeight: 12 * camera.zoom, transform: nil
            )
            let layer = CAShapeLayer()
            layer.path = path
            layer.fillColor = NSColor.clear.cgColor
            if isSelected {
                layer.strokeColor = NSColor.systemBlue.withAlphaComponent(0.6).cgColor
                layer.lineWidth = 2
                layer.lineDashPattern = nil
            } else {
                layer.strokeColor = NSColor.black.withAlphaComponent(0.20).cgColor
                layer.lineWidth = 2
                layer.lineDashPattern = [6, 4]
            }
            groupFrameOverlay.layer?.addSublayer(layer)
            guard board.groups?[group]?.source == nil,
                  let label = board.groups?[group]?.label, !label.isEmpty else { continue }
            // The name, inside the frame: 12px in from the
            // left edge, 8px down from the top edge, in a
            // muted grey. The font scales with the zoom, so
            // the name stays the same size relative to the
            // frame.
            let textLayer = CATextLayer()
            textLayer.string = label
            let fontSize = 12 * camera.zoom
            textLayer.font = NSFont.systemFont(ofSize: fontSize, weight: .semibold)
            textLayer.fontSize = fontSize
            textLayer.foregroundColor = NSColor.black.withAlphaComponent(0.55).cgColor
            textLayer.alignmentMode = .left
            textLayer.truncationMode = .end
            textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            textLayer.frame = CGRect(
                x: rect.origin.x + 12 * camera.zoom,
                y: rect.origin.y + 8 * camera.zoom,
                width: max(40, rect.width - 24 * camera.zoom),
                height: 18 * camera.zoom
            )
            groupFrameOverlay.layer?.addSublayer(textLayer)
        }
    }

    // MARK: - Connectors

    private func renderConnectors(board: Board) {
        // The overlay fills the viewport (screen
        // coordinates); the connector endpoints are mapped
        // to the screen, so the lines are drawn where the
        // cards are. There is no camera transform on the
        // container, so no visible-rect offset is needed.
        connectorOverlay.frame = CGRect(x: 0, y: 0, width: container.frame.width, height: container.frame.height)
        var paths: [(CGPath, NSColor, CGFloat)] = []
        for item in board.items {
            guard case .connector(let payload) = item.kind,
                  let (a, b) = ConnectorGeometry.clippedEnds(board: board, from: payload.from, to: payload.to) else { continue }
            let isSelected = selected.contains(item.id)
            let color = isSelected ? NSColor.systemBlue : (NSColor.fromHex(payload.color) ?? .labelColor)
            // The line and the head are in world units (the
            // Electron app's 2px/3px line and 12px head), so
            // they scale with the zoom. A fixed screen size
            // left the head the same size while the cards
            // shrank around it.
            let width: CGFloat = (isSelected ? 3 : 2) * camera.zoom
            // The endpoints, in screen coordinates.
            let aScreen = Pt(x: (a.x - camera.x) * camera.zoom, y: (a.y - camera.y) * camera.zoom)
            let bScreen = Pt(x: (b.x - camera.x) * camera.zoom, y: (b.y - camera.y) * camera.zoom)
            // The line.
            let line = CGMutablePath()
            line.move(to: CGPoint(x: aScreen.x, y: aScreen.y))
            line.addLine(to: CGPoint(x: bScreen.x, y: bScreen.y))
            paths.append((line, color, width))
            // The arrowhead: two lines at ±0.45 rad from
            // the direction, meeting at the end. The head is
            // 12 world pixels (the Electron app's 12px head),
            // so it scales with the zoom, computed from the
            // screen direction.
            let dx = bScreen.x - aScreen.x, dy = bScreen.y - aScreen.y
            let len = max(1, hypot(dx, dy))
            let ux = dx / len, uy = dy / len
            let head = 12.0 * camera.zoom, spread = 0.45
            let c1 = cos(spread), s1 = sin(spread), c2 = cos(-spread), s2 = sin(-spread)
            let p1 = Pt(x: bScreen.x - head * (ux * c1 - uy * s1), y: bScreen.y - head * (ux * s1 + uy * c1))
            let p2 = Pt(x: bScreen.x - head * (ux * c2 - uy * s2), y: bScreen.y - head * (ux * s2 + uy * c2))
            let headPath = CGMutablePath()
            headPath.move(to: CGPoint(x: p1.x, y: p1.y))
            headPath.addLine(to: CGPoint(x: bScreen.x, y: bScreen.y))
            headPath.addLine(to: CGPoint(x: p2.x, y: p2.y))
            paths.append((headPath, color, width))
        }
        // One layer per connector path (a handful of paths;
        // the layer count stays small).
        connectorOverlay.layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
        for (subpath, color, width) in paths {
            let layer = CAShapeLayer()
            layer.path = subpath
            layer.fillColor = NSColor.clear.cgColor
            layer.strokeColor = color.cgColor
            layer.lineWidth = width
            layer.lineCap = .round
            layer.lineJoin = .round
            connectorOverlay.layer?.addSublayer(layer)
        }
    }
}
