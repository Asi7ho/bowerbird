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
    private let connectorOverlay = NSView()
    private var shown: [Int: CardView] = [:]
    private var pool: [String: [CardView]] = [:]

    public init(container: NSView, board: Board, camera: Camera) {
        self.container = container
        self.board = board
        self.camera = camera
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
        // board order, and place it at the item's position.
        // The container's camera transform does the rest.
        // A recycled view is reconfigured for its new item.
        for item in ordered {
            let view = shown[item.id] ?? dequeueView(for: item) ?? CardViews.view(for: item)
            guard let view else { continue }
            view.configure(item: item)
            view.frame = CGRect(x: item.pos.x, y: item.pos.y, width: item.size.w, height: item.size.h)
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
        renderConnectors(visible: visible)
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

    // MARK: - Connectors

    private func renderConnectors(visible: WorldRect) {
        connectorOverlay.frame = CGRect(x: visible.x, y: visible.y, width: visible.w, height: visible.h)
        var paths: [(CGPath, NSColor, CGFloat)] = []
        for item in board.items {
            guard case .connector(let payload) = item.kind,
                  let (a, b) = ConnectorGeometry.clippedEnds(board: board, from: payload.from, to: payload.to) else { continue }
            let isSelected = selected.contains(item.id)
            let color = isSelected ? NSColor.systemBlue : (NSColor.fromHex(payload.color) ?? .labelColor)
            let width: CGFloat = isSelected ? 3 : 2
            // The line, offset into the overlay's local space.
            let line = CGMutablePath()
            line.move(to: CGPoint(x: a.x - visible.x, y: a.y - visible.y))
            line.addLine(to: CGPoint(x: b.x - visible.x, y: b.y - visible.y))
            paths.append((line, color, width))
            // The arrowhead: two 12px lines at ±0.45 rad from
            // the direction, meeting at the end.
            let dx = b.x - a.x, dy = b.y - a.y
            let len = max(1, hypot(dx, dy))
            let ux = dx / len, uy = dy / len
            let head = 12.0, spread = 0.45
            let c1 = cos(spread), s1 = sin(spread), c2 = cos(-spread), s2 = sin(-spread)
            let p1 = Pt(x: b.x - head * (ux * c1 - uy * s1), y: b.y - head * (ux * s1 + uy * c1))
            let p2 = Pt(x: b.x - head * (ux * c2 - uy * s2), y: b.y - head * (ux * s2 + uy * c2))
            let headPath = CGMutablePath()
            headPath.move(to: CGPoint(x: p1.x - visible.x, y: p1.y - visible.y))
            headPath.addLine(to: CGPoint(x: b.x - visible.x, y: b.y - visible.y))
            headPath.addLine(to: CGPoint(x: p2.x - visible.x, y: p2.y - visible.y))
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
