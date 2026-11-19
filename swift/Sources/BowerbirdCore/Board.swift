import Foundation

/// One card, stroke or connector on the board.
public struct Item: Codable, Equatable {
    public var id: Int
    public var pos: Pt
    public var size: Size
    public var group: Int?
    public var kind: Kind
    /// Rotation in degrees, clockwise, around the item's
    /// centre. Missing means 0.
    public var rotation: Double?
}

/// The view: `x`/`y` is the world point at the top-left of
/// the board area, `zoom` is clamped to 0.01–8.
public struct Camera: Codable, Equatable {
    public var x: Double
    public var y: Double
    public var zoom: Double
}

public enum Grid: String, Codable, Equatable {
    case lines = "Lines"
    case dots = "Dots"
    case off = "Off"
}

/// The file a live-import group came from: its kind, and the
/// board-local path it was embedded at. `size` and `mtimeMs`
/// are the file as last imported.
public enum ImportKind: String, Codable, Equatable {
    case svg, psd, ai
}

public struct ImportSource: Codable, Equatable {
    public var path: String
    public var kind: ImportKind
    public var size: Int?
    public var mtimeMs: Double?
}

/// One entry of Board.groups: the label its frame shows,
/// and the live-import source when the group came from one.
public struct GroupEntry: Codable, Equatable {
    public var label: String
    public var source: ImportSource?
}

/// The board: the on-disk `board.json` shape, exactly as
/// the Electron app writes it (see BOWERBIRD_SPEC.md).
/// Same fields, same kind tags, same ids — a board made in
/// either app opens in the other with no migration.
public struct Board: Codable, Equatable {
    public var items: [Item]
    public var camera: Camera
    public var nextId: Int
    public var nextGroup: Int
    public var groups: [Int: GroupEntry]?
    public var bg: String
    public var grid: Grid

    private enum CodingKeys: String, CodingKey {
        case items
        case camera
        case nextId = "next_id"
        case nextGroup = "next_group"
        case groups
        case bg
        case grid
    }

    public static func decode(from data: Data) throws -> Board {
        try JSONDecoder().decode(Board.self, from: data)
    }

    public func encode() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}
