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
        didSet { render() }
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
    /// which order, and the connector overlay. Cheap enough
    /// to run on every camera move (it only creates views
    /// for cards entering the viewport).
    public func render() {
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
            guard isVisible(item: item, visible: visible) else { continue }
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
        // view is reconfigured for its new item.
        for item in ordered {
            let view = shown[item.id] ?? dequeueView(for: item) ?? CardViews.view(for: item)
            guard let view else { continue }
            view.configure(item: item)
            view.frame = CGRect(
                x: (item.pos.x - camera.x) * camera.zoom,
                y: (item.pos.y - camera.y) * camera.zoom,
                width: item.size.w * camera.zoom,
                height: item.size.h * camera.zoom
            )
            if let rotation = item.rotation {
                view.layer?.transform = CATransform3DMakeRotation(CGFloat(rotation) * .pi / 180, 0, 0, 1)
            } else {
                view.layer?.transform = CATransform3DIdentity
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
        renderConnectors()
        renderGroupFrames()
    }

    private func updateSelection() {
        for (id, view) in shown {
            view.isSelected = selected.contains(id)
        }
        render()
    }

    private func isVisible(item: Item, visible: WorldRect) -> Bool {
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

    private var groupLabels: [Int: NSTextField] = [:]

    private func renderGroupFrames() {
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
        // render, like the connector paths).
        groupFrameOverlay.layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
        for (group, rect, isSelected) in frames {
            let path = CGPath(
                roundedRect: rect,
                cornerWidth: 12, cornerHeight: 12, transform: nil
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
            _ = group
        }
        // The labels: a white chip at the frame's top-left,
        // 12px in and 11px above the top edge (the Electron
        // app's .group-label). Reused across renders, so a
        // pan does not rebuild the text fields. A
        // live-import group (one with a source — the bird,
        // from an SVG) shows NO label: the Electron app
        // treats it as a single imported piece, not a named
        // group, so its frame is bare until it is selected.
        var liveLabels = Set<Int>()
        for (group, rect, _) in frames {
            guard board.groups?[group]?.source == nil,
                  let label = board.groups?[group]?.label, !label.isEmpty else { continue }
            liveLabels.insert(group)
            let field = groupLabels[group] ?? {
                let f = NSTextField(labelWithString: "")
                f.font = NSFont.systemFont(ofSize: 12 * camera.zoom, weight: .semibold)
                f.textColor = NSColor.labelColor
                f.backgroundColor = NSColor.white
                f.drawsBackground = true
                f.isBordered = false
                f.wantsLayer = true
                f.layer?.borderColor = NSColor.separatorColor.cgColor
                f.layer?.borderWidth = 1
                f.layer?.cornerRadius = 6
                groupLabels[group] = f
                return f
            }()
            field.font = NSFont.systemFont(ofSize: 12 * camera.zoom, weight: .semibold)
            field.stringValue = label
            field.sizeToFit()
            // The chip, padded like the Electron app's
            // (2px 8px) and straddling the frame's top edge.
            let chip = CGRect(
                x: rect.origin.x + 12 - 8,
                y: rect.origin.y - 11,
                width: field.frame.width + 16,
                height: field.frame.height + 4
            )
            field.frame = chip
            if field.superview == nil {
                groupFrameOverlay.addSubview(field)
            }
        }
        // Drop the labels of groups that no longer exist.
        for (group, field) in groupLabels where !liveLabels.contains(group) {
            field.removeFromSuperview()
            groupLabels.removeValue(forKey: group)
        }
    }

    // MARK: - Connectors

    private func renderConnectors() {
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
            let width: CGFloat = isSelected ? 3 : 2
            // The endpoints, in screen coordinates.
            let aScreen = Pt(x: (a.x - camera.x) * camera.zoom, y: (a.y - camera.y) * camera.zoom)
            let bScreen = Pt(x: (b.x - camera.x) * camera.zoom, y: (b.y - camera.y) * camera.zoom)
            // The line.
            let line = CGMutablePath()
            line.move(to: CGPoint(x: aScreen.x, y: aScreen.y))
            line.addLine(to: CGPoint(x: bScreen.x, y: bScreen.y))
            paths.append((line, color, width))
            // The arrowhead: two 12px lines at ±0.45 rad from
            // the direction, meeting at the end. The head is
            // 12 screen pixels (the Electron app's 12px
            // head), computed from the screen direction.
            let dx = bScreen.x - aScreen.x, dy = bScreen.y - aScreen.y
            let len = max(1, hypot(dx, dy))
            let ux = dx / len, uy = dy / len
            let head = 12.0, spread = 0.45
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
