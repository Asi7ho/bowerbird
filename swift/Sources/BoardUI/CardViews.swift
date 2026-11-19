import AppKit
import BowerbirdCore

/// A card view for one board item. The host builds one per
/// visible item and recycles it by kind: a view is
/// reconfigured for its new item through `configure(item:)`,
/// so a view that leaves the viewport can come back for
/// another card of the same kind without being rebuilt.
/// Media kinds that do not have their native view yet
/// (M4/M5) render as a placeholder tile with the kind name
/// — the board still shows every card, and the native view
/// replaces the tile in its milestone.
public enum CardViews {
    /// Build a fresh view for an item, or nil for a
    /// connector (connectors are drawn in the ink layer,
    /// not as cards).
    public static func view(for item: Item) -> CardView? {
        switch item.kind {
        case .text:
            return TextCardView()
        case .shape:
            return ShapeCardView()
        case .stroke:
            return StrokeCardView()
        case .swatch:
            return SwatchCardView()
        case .image:
            return ImageCardView()
        case .urlCard:
            return PlaceholderCardView()
        case .pdfCard:
            return PlaceholderCardView()
        case .fileCard:
            return PlaceholderCardView()
        case .audio:
            return PlaceholderCardView()
        case .video:
            return PlaceholderCardView()
        case .model3D:
            return PlaceholderCardView()
        case .plugin:
            return PlaceholderCardView()
        case .connector:
            return nil
        }
    }

    /// The kind name, used as the recycling pool's key.
    public static func kindName(of item: Item) -> String {
        switch item.kind {
        case .text: return "Text"
        case .shape: return "Shape"
        case .image: return "Image"
        case .urlCard: return "UrlCard"
        case .pdfCard: return "PdfCard"
        case .fileCard: return "FileCard"
        case .swatch: return "Swatch"
        case .audio: return "Audio"
        case .video: return "Video"
        case .model3D: return "Model3D"
        case .stroke: return "Stroke"
        case .connector: return "Connector"
        case .plugin: return "Plugin"
        }
    }
}

/// A text note: the text in the kind's size and colour,
/// 14px padding, line-height 1.55, on the note's background
/// colour (or white). Editing is M3; this view does not
/// edit or select text.
public final class TextCardView: CardView {
    private let field = NSTextField(labelWithString: "")

    override public init() {
        super.init()
        field.isEditable = false
        field.isSelectable = false
        field.usesSingleLineMode = false
        field.lineBreakMode = .byWordWrapping
        field.translatesAutoresizingMaskIntoConstraints = false
        addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            field.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            field.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -14),
        ])
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .text(let text) = item.kind else { return }
        field.stringValue = text.text
        field.font = NSFont.systemFont(ofSize: CGFloat(text.size), weight: text.bold ? .bold : .regular)
        field.textColor = NSColor.fromHex(text.color) ?? .labelColor
        layer?.backgroundColor = (text.bg.flatMap { NSColor.fromHex($0) } ?? NSColor.white).cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("TextCardView is not Interface Builder backed")
    }
}

/// A shape: the fill as a layer (rect is the card itself,
/// ellipse and polygons are a shape layer). An outline shape
/// is stroked, not filled.
public final class ShapeCardView: CardView {
    private let shapeLayer = CAShapeLayer()

    override public init() {
        super.init()
        hasShadow = false
        // The Electron app's shape card is transparent with
        // no hairline border (cards.ts: the outer div is
        // `background:transparent;border:none`), so an
        // ellipse is really an ellipse — a white card behind
        // it would show as a rectangle, which is what the
        // bird's parts did. The fill lives on the shape
        // layer, clipped to the shape.
        showsBorder = false
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.addSublayer(shapeLayer)
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .shape(let shape) = item.kind else { return }
        let fill = NSColor.fromHex(shape.fill) ?? .labelColor
        if shape.shape == .rect {
            // A rect fills the whole card, so the card
            // itself is the fill (12px radius from the base).
            layer?.backgroundColor = fill.cgColor
            shapeLayer.path = nil
        } else {
            layer?.backgroundColor = NSColor.clear.cgColor
            shapeLayer.path = ShapePath.path(for: shape.shape, in: bounds)
            shapeLayer.frame = bounds
            if shape.outline == true {
                shapeLayer.fillColor = NSColor.clear.cgColor
                shapeLayer.strokeColor = fill.cgColor
                shapeLayer.lineWidth = 2
            } else {
                shapeLayer.fillColor = fill.cgColor
                shapeLayer.strokeColor = NSColor.clear.cgColor
            }
        }
    }

    override public func layout() {
        super.layout()
        // The path is built for the current bounds; rebuild
        // it when the view is laid out (its frame is set by
        // the host after the view is created).
        if let item = currentItem, case .shape(let shape) = item.kind, shape.shape != .rect {
            shapeLayer.path = ShapePath.path(for: shape.shape, in: bounds)
            shapeLayer.frame = bounds
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("ShapeCardView is not Interface Builder backed")
    }
}

/// A stroke: the Catmull-Rom smooth path as a shape layer.
/// No shadow, and the content is not clipped (the stroke
/// paints past the card's edge by half its width). A pencil
/// stroke renders as a plain stroke for now — the graphite
/// texture lands with the drawing tools in M3.
public final class StrokeCardView: CardView {
    private let shapeLayer = CAShapeLayer()

    override public init() {
        super.init()
        hasShadow = false
        clipsContent = false
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.addSublayer(shapeLayer)
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .stroke(let stroke) = item.kind else { return }
        shapeLayer.path = StrokePath.path(for: stroke.points)
        shapeLayer.fillColor = NSColor.clear.cgColor
        shapeLayer.strokeColor = (NSColor.fromHex(stroke.color) ?? .labelColor).cgColor
        shapeLayer.lineWidth = CGFloat(stroke.width)
        shapeLayer.lineCap = .round
        shapeLayer.lineJoin = .round
        shapeLayer.opacity = stroke.marker ? 0.45 : 1
        shapeLayer.frame = bounds
    }

    override public func layout() {
        super.layout()
        if let item = currentItem, case .stroke(let stroke) = item.kind {
            shapeLayer.path = StrokePath.path(for: stroke.points)
            shapeLayer.frame = bounds
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("StrokeCardView is not Interface Builder backed")
    }
}

/// A swatch: the card is the colour.
public final class SwatchCardView: CardView {
    override public init() {
        super.init()
        hasShadow = false
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .swatch(let swatch) = item.kind else { return }
        layer?.backgroundColor = (NSColor.fromHex(swatch.hex) ?? .labelColor).cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("SwatchCardView is not Interface Builder backed")
    }
}

/// An image: the file at the path, fitted to the card. A
/// missing file shows a placeholder tile instead of an
/// empty card.
public final class ImageCardView: CardView {
    private let imageView = NSImageView()

    override public init() {
        super.init()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
            imageView.topAnchor.constraint(equalTo: topAnchor),
            imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .image(let image) = item.kind else { return }
        imageView.image = NSImage(contentsOfFile: image.path)
        layer?.backgroundColor = imageView.image == nil
            ? NSColor.systemGray.withAlphaComponent(0.15).cgColor
            : NSColor.white.cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("ImageCardView is not Interface Builder backed")
    }
}

/// A placeholder tile for a kind whose native view has not
/// landed yet (M4/M5/M7). The board still shows the card,
/// with its title and what is coming.
public final class PlaceholderCardView: CardView {
    private let titleField = NSTextField(labelWithString: "")
    private let subtitleField = NSTextField(labelWithString: "")

    override public init() {
        super.init()
        // A placeholder is not a blank card: a light grey
        // background and its kind name, so a media card
        // whose native view has not landed yet (M4/M5)
        // reads as "coming", not as an empty white card.
        layer?.backgroundColor = NSColor.systemGray.withAlphaComponent(0.08).cgColor
        titleField.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        subtitleField.font = NSFont.systemFont(ofSize: 12)
        subtitleField.textColor = .secondaryLabelColor
        for field in [titleField, subtitleField] {
            field.isEditable = false
            field.isSelectable = false
            field.translatesAutoresizingMaskIntoConstraints = false
            addSubview(field)
        }
        NSLayoutConstraint.activate([
            titleField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            titleField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            titleField.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            subtitleField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            subtitleField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            subtitleField.topAnchor.constraint(equalTo: titleField.bottomAnchor, constant: 4),
        ])
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        switch item.kind {
        case .urlCard(let url):
            titleField.stringValue = url.title ?? url.url
            subtitleField.stringValue = "Link"
        case .pdfCard:
            titleField.stringValue = "PDF"
            subtitleField.stringValue = "PDFView in M4"
        case .fileCard(let file):
            titleField.stringValue = file.path
            subtitleField.stringValue = file.format.rawValue.uppercased()
        case .audio(let audio):
            titleField.stringValue = audio.title ?? "Audio"
            subtitleField.stringValue = "AVPlayerView in M5"
        case .video:
            titleField.stringValue = "Video"
            subtitleField.stringValue = "AVPlayerView in M5"
        case .model3D:
            titleField.stringValue = "3D model"
            subtitleField.stringValue = "SceneKit in M5"
        case .plugin(let plugin):
            titleField.stringValue = plugin.kind
            subtitleField.stringValue = "Plugin in M7"
        default:
            titleField.stringValue = ""
            subtitleField.stringValue = ""
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlaceholderCardView is not Interface Builder backed")
    }
}
