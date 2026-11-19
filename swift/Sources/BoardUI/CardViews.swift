import AppKit
import BowerbirdCore

/// A card view for one board item. The host builds one per
/// visible item and recycles it by kind. Media kinds that
/// do not have their native view yet (M4/M5) render as a
/// placeholder tile with the kind name — the board still
/// shows every card, and the native view replaces the tile
/// in its milestone.
public enum CardViews {
    /// Build the view for an item, or nil for a connector
    /// (connectors are drawn in the ink layer, not as cards).
    public static func view(for item: Item) -> CardView? {
        switch item.kind {
        case .text(let text):
            return TextCardView(text: text)
        case .shape(let shape):
            return ShapeCardView(shape: shape)
        case .stroke(let stroke):
            return StrokeCardView(stroke: stroke)
        case .swatch(let swatch):
            return SwatchCardView(hex: swatch.hex)
        case .image(let image):
            return ImageCardView(path: image.path)
        case .urlCard(let url):
            return PlaceholderCardView(title: url.title ?? url.url, subtitle: "Link")
        case .pdfCard:
            return PlaceholderCardView(title: "PDF", subtitle: "PDFView in M4")
        case .fileCard(let file):
            return PlaceholderCardView(title: file.path, subtitle: file.format.uppercased())
        case .audio(let audio):
            return PlaceholderCardView(title: audio.title ?? "Audio", subtitle: "AVPlayerView in M5")
        case .video:
            return PlaceholderCardView(title: "Video", subtitle: "AVPlayerView in M5")
        case .model3D:
            return PlaceholderCardView(title: "3D model", subtitle: "SceneKit in M5")
        case .plugin(let plugin):
            return PlaceholderCardView(title: plugin.kind, subtitle: "Plugin in M7")
        case .connector:
            return nil
        }
    }
}

/// A text note: the text in the kind's size and colour,
/// 14px padding, line-height 1.55, on the note's background
/// colour (or white). Editing is M3; this view does not
/// edit or select text.
public final class TextCardView: CardView {
    public init(text: TextPayload) {
        super.init()
        if let bg = text.bg, let color = NSColor.fromHex(bg) {
            layer?.backgroundColor = color.cgColor
        }
        let field = NSTextField(labelWithString: text.text)
        field.isEditable = false
        field.isSelectable = false
        field.usesSingleLineMode = false
        field.lineBreakMode = .byWordWrapping
        field.font = NSFont.systemFont(ofSize: CGFloat(text.size), weight: text.bold ? .bold : .regular)
        field.textColor = NSColor.fromHex(text.color) ?? .labelColor
        field.translatesAutoresizingMaskIntoConstraints = false
        addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            field.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            field.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -14),
        ])
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
    public init(shape: ShapePayload) {
        super.init()
        hasShadow = false
        let fill = NSColor.fromHex(shape.fill) ?? .labelColor
        if shape.shape == .rect {
            layer?.backgroundColor = fill.cgColor
        } else if let path = ShapePath.path(for: shape.shape, in: bounds) {
            let shapeLayer = CAShapeLayer()
            shapeLayer.path = path
            if shape.outline == true {
                shapeLayer.fillColor = NSColor.clear.cgColor
                shapeLayer.strokeColor = fill.cgColor
                shapeLayer.lineWidth = 2
            } else {
                shapeLayer.fillColor = fill.cgColor
            }
            layer?.addSublayer(shapeLayer)
            // The path is built for the current bounds; it is
            // rebuilt when the view is laid out.
            self.shapeLayer = shapeLayer
            self.shape = shape
        }
    }

    private var shapeLayer: CAShapeLayer?
    private var shape: ShapePayload?

    override public func layout() {
        super.layout()
        if let shapeLayer, let shape {
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
    public init(stroke: StrokePayload) {
        super.init()
        hasShadow = false
        clipsContent = false
        layer?.backgroundColor = NSColor.clear.cgColor
        guard let path = StrokePath.path(for: stroke.points) else { return }
        let shapeLayer = CAShapeLayer()
        shapeLayer.path = path
        shapeLayer.fillColor = NSColor.clear.cgColor
        shapeLayer.strokeColor = (NSColor.fromHex(stroke.color) ?? .labelColor).cgColor
        shapeLayer.lineWidth = CGFloat(stroke.width)
        shapeLayer.lineCap = .round
        shapeLayer.lineJoin = .round
        if stroke.marker == "highlighter" {
            shapeLayer.opacity = 0.45
        }
        // The path is in the card's local space (points minus
        // their bbox min); the layer fills the card.
        shapeLayer.frame = bounds
        layer?.addSublayer(shapeLayer)
        self.shapeLayer = shapeLayer
        self.stroke = stroke
    }

    private var shapeLayer: CAShapeLayer?
    private var stroke: StrokePayload?

    override public func layout() {
        super.layout()
        if let shapeLayer, let stroke {
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
    public init(hex: String) {
        super.init()
        hasShadow = false
        layer?.backgroundColor = (NSColor.fromHex(hex) ?? .labelColor).cgColor
        layer?.borderWidth = 0
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
    public init(path: String) {
        super.init()
        let imageView = NSImageView()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        if let image = NSImage(contentsOfFile: path) {
            imageView.image = image
        }
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
            imageView.topAnchor.constraint(equalTo: topAnchor),
            imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        if imageView.image == nil {
            layer?.backgroundColor = NSColor.systemGray.withAlphaComponent(0.15).cgColor
        }
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
    public init(title: String, subtitle: String) {
        super.init()
        let titleField = NSTextField(labelWithString: title)
        titleField.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        titleField.textColor = .labelColor
        titleField.lineBreakMode = .byTruncatingTail
        let subtitleField = NSTextField(labelWithString: subtitle)
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

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlaceholderCardView is not Interface Builder backed")
    }
}
