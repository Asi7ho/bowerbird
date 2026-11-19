import Foundation

/// Camera and board geometry, mirroring `src/backend/model.ts`
/// exactly (same clamps, same padding, same rounding-free
/// math) so the Swift viewport frames a board the same way
/// the Electron app does.
public enum CameraMath {
    /// The grid step in world units (model.ts GRID).
    public static let gridStep: Double = 100
    /// The visible-set margin in world units: cards at the
    /// edge do not pop in and out while panning.
    public static let visibleMargin: Double = 200

    /// The floor is 0.01, not 0.1: fit must reach very wide
    /// boards.
    public static func clampZoom(_ zoom: Double) -> Double {
        max(0.01, min(8, zoom))
    }

    public static func screenToWorld(_ screen: Pt, camera: Camera) -> Pt {
        Pt(x: screen.x / camera.zoom + camera.x, y: screen.y / camera.zoom + camera.y)
    }

    public static func worldToScreen(_ world: Pt, camera: Camera) -> Pt {
        Pt(x: (world.x - camera.x) * camera.zoom, y: (world.y - camera.y) * camera.zoom)
    }

    /// The camera after zooming by a factor around a screen
    /// point: the point stays under the cursor.
    public static func zoomCamera(_ camera: Camera, around screen: Pt, factor: Double) -> Camera {
        let before = screenToWorld(screen, camera: camera)
        let zoom = clampZoom(camera.zoom * factor)
        let after = Pt(x: screen.x / zoom + camera.x, y: screen.y / zoom + camera.y)
        return Camera(x: camera.x + before.x - after.x, y: camera.y + before.y - after.y, zoom: zoom)
    }

    /// The centre of an item (card centre, or stroke
    /// bounding-box centre).
    public static func centre(of item: Item) -> Pt {
        Pt(x: item.pos.x + item.size.w / 2, y: item.pos.y + item.size.h / 2)
    }

    public static func anchorPoint(board: Board, anchor: Anchor) -> Pt? {
        switch anchor {
        case .point(let pt): return pt
        case .item(let id): return board.items.first(where: { $0.id == id }).map { centre(of: $0) }
        }
    }

    /// A connector's bounds are its anchor points' box,
    /// expanded by 8; everything else is its pos/size.
    /// (A stroke's pos/size already is its points' box.)
    public static func itemBounds(board: Board, item: Item) -> WorldRect {
        if case .connector(let payload) = item.kind,
           let a = anchorPoint(board: board, anchor: payload.from),
           let b = anchorPoint(board: board, anchor: payload.to) {
            let margin = 8.0
            let x = min(a.x, b.x) - margin
            let y = min(a.y, b.y) - margin
            return WorldRect(x: x, y: y, w: max(a.x, b.x) - x + margin, h: max(a.y, b.y) - y + margin)
        }
        return WorldRect(x: item.pos.x, y: item.pos.y, w: item.size.w, h: item.size.h)
    }

    /// The bounding box of a set of items, or nil when empty.
    public static func itemsBounds(board: Board, items: [Item]) -> WorldRect? {
        var minX = Double.infinity
        var minY = Double.infinity
        var maxX = -Double.infinity
        var maxY = -Double.infinity
        for item in items {
            let bounds = itemBounds(board: board, item: item)
            minX = min(minX, bounds.minX)
            minY = min(minY, bounds.minY)
            maxX = max(maxX, bounds.maxX)
            maxY = max(maxY, bounds.maxY)
        }
        guard minX.isFinite else { return nil }
        return WorldRect(x: minX, y: minY, w: maxX - minX, h: maxY - minY)
    }

    /// Zoom to fit: the camera that shows every item at once.
    /// The zoom is capped at 1 — a small board is centred,
    /// not blown up — and a margin keeps cards off the edges.
    /// An empty board has nothing to fit, so there is no camera.
    public static func fitCamera(board: Board, viewport: Size, padding: Double = 48) -> Camera? {
        guard let bounds = itemsBounds(board: board, items: board.items) else { return nil }
        let bw = max(1, bounds.w)
        let bh = max(1, bounds.h)
        let availW = max(1, viewport.w - padding * 2)
        let availH = max(1, viewport.h - padding * 2)
        let zoom = min(1, availW / bw, availH / bh)
        return Camera(
            x: bounds.x + bounds.w / 2 - viewport.w / 2 / zoom,
            y: bounds.y + bounds.h / 2 - viewport.h / 2 / zoom,
            zoom: zoom
        )
    }

    /// The visible world rect, with a margin so cards at the
    /// edge do not pop in and out while panning. Everything
    /// else is culled.
    public static func visibleRect(camera: Camera, viewport: Size, margin: Double = visibleMargin) -> WorldRect {
        WorldRect(
            x: camera.x - margin,
            y: camera.y - margin,
            w: viewport.w / camera.zoom + margin * 2,
            h: viewport.h / camera.zoom + margin * 2
        )
    }

    /// The grid step for a viewport: the base step doubles
    /// while the view would show more than 40 cells across,
    /// so a zoomed-out board shows a coarser grid.
    public static func gridStep(for viewport: Size, zoom: Double) -> Double {
        var step = gridStep
        while (viewport.w / zoom) / step > 40 || (viewport.h / zoom) / step > 40 {
            step *= 2
        }
        return step
    }
}
