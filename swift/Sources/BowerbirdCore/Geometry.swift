import Foundation

/// A point in world coordinates (see BOWERBIRD_SPEC.md).
public struct Pt: Codable, Equatable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// A size in world coordinates.
public struct Size: Codable, Equatable {
    public var w: Double
    public var h: Double

    public init(w: Double, h: Double) {
        self.w = w
        self.h = h
    }
}

/// A rectangle in world coordinates: its top-left corner and
/// its size.
public struct WorldRect: Equatable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    public var minX: Double { x }
    public var minY: Double { y }
    public var maxX: Double { x + w }
    public var maxY: Double { y + h }
    public var centre: Pt { Pt(x: x + w / 2, y: y + h / 2) }

    public func intersects(_ other: WorldRect) -> Bool {
        maxX >= other.minX && minX <= other.maxX && maxY >= other.minY && minY <= other.maxY
    }
}
