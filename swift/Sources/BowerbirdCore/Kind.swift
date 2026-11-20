import Foundation

/// The shape a Shape card draws.
public enum ShapeKind: String, Codable, Equatable, CaseIterable {
    case rect, ellipse, triangle, diamond, hexagon, star, arrow
}

/// One end of a connector: a point in the world, or a card.
public enum Anchor: Codable, Equatable {
    case point(Pt)
    case item(Int)

    private enum Key: String, CodingKey {
        case point = "Point"
        case item = "Item"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        guard let key = container.allKeys.first, container.allKeys.count == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .point, in: container, debugDescription: "Anchor must have exactly one key")
        }
        switch key {
        case .point: self = .point(try container.decode(Pt.self, forKey: .point))
        case .item: self = .item(try container.decode(Int.self, forKey: .item))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch self {
        case .point(let pt): try container.encode(pt, forKey: .point)
        case .item(let id): try container.encode(id, forKey: .item)
        }
    }
}

public struct TextPayload: Codable, Equatable {
    public var text: String
    public var bold: Bool
    public var size: Double
    public var color: String
    public var bg: String?

    public init(text: String, bold: Bool, size: Double, color: String, bg: String?) {
        self.text = text
        self.bold = bold
        self.size = size
        self.color = color
        self.bg = bg
    }
}

public struct ShapePayload: Codable, Equatable {
    public var shape: ShapeKind
    public var fill: String
    public var outline: Bool?

    public init(shape: ShapeKind, fill: String, outline: Bool?) {
        self.shape = shape
        self.fill = fill
        self.outline = outline
    }
}

public struct ImagePayload: Codable, Equatable {
    public var path: String

    public init(path: String) {
        self.path = path
    }
}

public struct UrlCardPayload: Codable, Equatable {
    public var url: String
    public var title: String?
    public var description: String?
    public var image: String?
    public var icon: String?
    public var embed: Bool?

    public init(url: String, title: String?, description: String?, image: String?, icon: String?, embed: Bool?) {
        self.url = url
        self.title = title
        self.description = description
        self.image = image
        self.icon = icon
        self.embed = embed
    }
}

public struct PdfCardPayload: Codable, Equatable {
    public var path: String
    public var sizeBytes: Int

    public init(path: String, sizeBytes: Int) {
        self.path = path
        self.sizeBytes = sizeBytes
    }

    private enum CodingKeys: String, CodingKey {
        case path
        case sizeBytes = "size_bytes"
    }
}

public enum FileFormat: String, Codable, Equatable {
    case psd, ai
}

public struct FileCardPayload: Codable, Equatable {
    public var path: String
    public var sizeBytes: Int
    public var format: FileFormat
    public var preview: String?

    public init(path: String, sizeBytes: Int, format: FileFormat, preview: String?) {
        self.path = path
        self.sizeBytes = sizeBytes
        self.format = format
        self.preview = preview
    }

    private enum CodingKeys: String, CodingKey {
        case path
        case sizeBytes = "size_bytes"
        case format
        case preview
    }
}

public struct SwatchPayload: Codable, Equatable {
    public var hex: String

    public init(hex: String) {
        self.hex = hex
    }
}

public struct AudioPayload: Codable, Equatable {
    public var path: String
    public var title: String?
    public var transcript: String?

    public init(path: String, title: String?, transcript: String?) {
        self.path = path
        self.title = title
        self.transcript = transcript
    }
}

public struct VideoPayload: Codable, Equatable {
    public var source: String
    public var remote: Bool
    public var sizeBytes: Int
    public var poster: String?
    public var duration: Double?

    public init(source: String, remote: Bool, sizeBytes: Int, poster: String?, duration: Double?) {
        self.source = source
        self.remote = remote
        self.sizeBytes = sizeBytes
        self.poster = poster
        self.duration = duration
    }

    private enum CodingKeys: String, CodingKey {
        case source
        case remote
        case sizeBytes = "size_bytes"
        case poster
        case duration
    }
}

public struct Model3DPayload: Codable, Equatable {
    public var path: String
    public var sizeBytes: Int

    public init(path: String, sizeBytes: Int) {
        self.path = path
        self.sizeBytes = sizeBytes
    }

    private enum CodingKeys: String, CodingKey {
        case path
        case sizeBytes = "size_bytes"
    }
}

public struct StrokePayload: Codable, Equatable {
    public var points: [Pt]
    public var color: String
    public var width: Double
    public var marker: Bool
    public var pressures: [Double]?
    public var pencil: Bool?

    public init(points: [Pt], color: String, width: Double, marker: Bool, pressures: [Double]?, pencil: Bool?) {
        self.points = points
        self.color = color
        self.width = width
        self.marker = marker
        self.pressures = pressures
        self.pencil = pencil
    }
}

public struct ConnectorPayload: Codable, Equatable {
    public var from: Anchor
    public var to: Anchor
    public var color: String

    public init(from: Anchor, to: Anchor, color: String) {
        self.from = from
        self.to = to
        self.color = color
    }
}

public struct PluginPayload: Codable, Equatable {
    public var plugin: String
    public var kind: String
    public var data: JSONValue
}

/// A card's kind: an externally-tagged enum, exactly one key
/// (see BOWERBIRD_SPEC.md). The payload structs above are the
/// per-kind fields; this enum is the tag.
public enum Kind: Codable, Equatable {
    case text(TextPayload)
    case shape(ShapePayload)
    case image(ImagePayload)
    case urlCard(UrlCardPayload)
    case pdfCard(PdfCardPayload)
    case fileCard(FileCardPayload)
    case swatch(SwatchPayload)
    case audio(AudioPayload)
    case video(VideoPayload)
    case model3D(Model3DPayload)
    case stroke(StrokePayload)
    case connector(ConnectorPayload)
    case plugin(PluginPayload)

    private enum Key: String, CodingKey {
        case text = "Text"
        case shape = "Shape"
        case image = "Image"
        case urlCard = "UrlCard"
        case pdfCard = "PdfCard"
        case fileCard = "FileCard"
        case swatch = "Swatch"
        case audio = "Audio"
        case video = "Video"
        case model3D = "Model3D"
        case stroke = "Stroke"
        case connector = "Connector"
        case plugin = "Plugin"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        guard let key = container.allKeys.first, container.allKeys.count == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .text, in: container, debugDescription: "Kind must have exactly one key")
        }
        switch key {
        case .text: self = .text(try container.decode(TextPayload.self, forKey: .text))
        case .shape: self = .shape(try container.decode(ShapePayload.self, forKey: .shape))
        case .image: self = .image(try container.decode(ImagePayload.self, forKey: .image))
        case .urlCard: self = .urlCard(try container.decode(UrlCardPayload.self, forKey: .urlCard))
        case .pdfCard: self = .pdfCard(try container.decode(PdfCardPayload.self, forKey: .pdfCard))
        case .fileCard: self = .fileCard(try container.decode(FileCardPayload.self, forKey: .fileCard))
        case .swatch: self = .swatch(try container.decode(SwatchPayload.self, forKey: .swatch))
        case .audio: self = .audio(try container.decode(AudioPayload.self, forKey: .audio))
        case .video: self = .video(try container.decode(VideoPayload.self, forKey: .video))
        case .model3D: self = .model3D(try container.decode(Model3DPayload.self, forKey: .model3D))
        case .stroke: self = .stroke(try container.decode(StrokePayload.self, forKey: .stroke))
        case .connector: self = .connector(try container.decode(ConnectorPayload.self, forKey: .connector))
        case .plugin: self = .plugin(try container.decode(PluginPayload.self, forKey: .plugin))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch self {
        case .text(let payload): try container.encode(payload, forKey: .text)
        case .shape(let payload): try container.encode(payload, forKey: .shape)
        case .image(let payload): try container.encode(payload, forKey: .image)
        case .urlCard(let payload): try container.encode(payload, forKey: .urlCard)
        case .pdfCard(let payload): try container.encode(payload, forKey: .pdfCard)
        case .fileCard(let payload): try container.encode(payload, forKey: .fileCard)
        case .swatch(let payload): try container.encode(payload, forKey: .swatch)
        case .audio(let payload): try container.encode(payload, forKey: .audio)
        case .video(let payload): try container.encode(payload, forKey: .video)
        case .model3D(let payload): try container.encode(payload, forKey: .model3D)
        case .stroke(let payload): try container.encode(payload, forKey: .stroke)
        case .connector(let payload): try container.encode(payload, forKey: .connector)
        case .plugin(let payload): try container.encode(payload, forKey: .plugin)
        }
    }
}
