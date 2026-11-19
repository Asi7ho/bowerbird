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
