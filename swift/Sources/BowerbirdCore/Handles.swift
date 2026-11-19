import Foundation

/// The resize and rotate handles' geometry, ported from
/// the Electron app (`board.ts`: `rotatePoint`,
/// `itemRotation`, `rotateHandleWorld`, `cornerHit`,
/// `rotateHit`, `rotateAngleFor`, `normAngle`). The handles
/// are visual layers; the hit-testing is geometric (a
/// distance from the world point to the handle's world
/// position), so the handles work whatever draws them.
public enum Handles {
    /// Rotates a point around a centre by degrees
    /// (clockwise, the DOM's y-down sense).
    public static func rotatePoint(_ p: Pt, around c: Pt, by deg: Double) -> Pt {
        let r = deg * Double.pi / 180
        let cos = Foundation.cos(r), sin = Foundation.sin(r)
        let dx = p.x - c.x, dy = p.y - c.y
        return Pt(x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos)
    }

    /// An item's rotation in degrees (0 when unset).
    public static func itemRotation(of item: Item) -> Double {
        let r = item.rotation ?? 0
        return r.isFinite ? r : 0
    }

    /// Normalises an angle to (-180, 180].
    public static func normAngle(_ deg: Double) -> Double {
        var d = deg.truncatingRemainder(dividingBy: 360)
        if d > 180 { d -= 360 }
        if d <= -180 { d += 360 }
        return d
    }

    /// The rotation for a pointer at this world point: the
    /// angle from the item's centre to the pointer, plus
    /// 90° (so the handle above the card means 0°). With
    /// Shift held, the angle snaps to 15° increments.
    public static func rotateAngleFor(world: Pt, item: Item, snap: Bool) -> Double {
        let c = CameraMath.centre(of: item)
        var deg = atan2(world.y - c.y, world.x - c.x) * 180 / Double.pi + 90
        if snap { deg = (deg / 15).rounded() * 15 }
        return normAngle(deg)
    }

    /// Whether the item can be rotated: anything except a
    /// connector (and a frame card, which the Swift app
    /// does not have yet).
    public static func isRotatable(_ item: Item) -> Bool {
        if case .connector = item.kind { return false }
        return true
    }

    /// The resize handle's world position: the bottom-right
    /// corner of the item's bounds, rotated around the
    /// item's centre by its rotation. Nil for a connector
    /// (a connector has no resize handle).
    public static func cornerWorld(board: Board, item: Item) -> Pt? {
        if case .connector = item.kind { return nil }
        let bounds = CameraMath.itemBounds(board: board, item: item)
        let c = CameraMath.centre(of: item)
        return rotatePoint(
            Pt(x: bounds.x + bounds.w, y: bounds.y + bounds.h),
            around: c, by: itemRotation(of: item)
        )
    }

    /// The rotate handle's world position: 28 world pixels
    /// above the item's top edge centre, rotated around
    /// the item's centre by its rotation. Nil when the
    /// item is not rotatable.
    public static func rotateHandleWorld(item: Item, zoom: Double) -> Pt? {
        guard isRotatable(item) else { return nil }
        let c = CameraMath.centre(of: item)
        let top = Pt(x: c.x, y: item.pos.y - 28 / zoom)
        return rotatePoint(top, around: c, by: itemRotation(of: item))
    }

    /// Whether a world point hits the resize handle (within
    /// 16 world pixels / zoom of the corner).
    public static func cornerHit(board: Board, item: Item, at world: Pt, zoom: Double) -> Bool {
        guard let corner = cornerWorld(board: board, item: item) else { return false }
        return hypot(world.x - corner.x, world.y - corner.y) <= 16 / zoom
    }

    /// Whether a world point hits the rotate handle (within
    /// 18 world pixels / zoom of it).
    public static func rotateHit(item: Item, at world: Pt, zoom: Double) -> Bool {
        guard let handle = rotateHandleWorld(item: item, zoom: zoom) else { return false }
        return hypot(world.x - handle.x, world.y - handle.y) <= 18 / zoom
    }
}
