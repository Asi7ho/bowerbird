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
///
/// The text is a `CATextLayer`, not an `NSTextField`: a
/// control does not reliably draw when an ancestor layer
/// carries the camera transform (the notes went blank
/// after the transform landed), while a layer draws
/// exactly where its frame is.
public final class TextCardView: CardView {
    private let textLayer = CATextLayer()

    override public init() {
        super.init()
        textLayer.isWrapped = true
        textLayer.truncationMode = .none
        textLayer.alignmentMode = .left
        textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        layer?.addSublayer(textLayer)
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .text(let text) = item.kind else { return }
        textLayer.string = text.text
        textLayer.foregroundColor = (NSColor.fromHex(text.color) ?? .labelColor).cgColor
        layer?.backgroundColor = (text.bg.flatMap { NSColor.fromHex($0) } ?? NSColor.white).cgColor
        // The font size is set in layout(), once the card
        // has its screen size (it scales with the zoom).
        needsLayout = true
    }

    override public func layout() {
        super.layout()
        // 14px padding on every side. The card is y-up
        // (a plain NSView), so the inset rect is the text
        // area and the layer draws top-down inside it.
        // The layer moves instantly (no implicit animation):
        // a zoom step would otherwise animate the text
        // across the card for a quarter of a second.
        CardView.withoutLayerActions {
            textLayer.frame = bounds.insetBy(dx: 14, dy: 14)
            // The font size is in world units; the card is
            // screen-sized, so it scales by the zoom — the
            // card's screen width over its world width.
            // Without the scale the text drew at world size
            // inside a screen-sized card. But the size never
            // drops below 6pt on screen: below that the text
            // was unreadable and the card read as a blank
            // white card when zoomed out.
            if let item = currentItem, case .text(let text) = item.kind {
                let zoom = item.size.w > 0 ? bounds.width / CGFloat(item.size.w) : 1
                let size = max(CGFloat(text.size) * zoom, 6)
                let font = NSFont.systemFont(ofSize: size, weight: text.bold ? .bold : .regular)
                textLayer.font = font
                textLayer.fontSize = size
            }
        }
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
        // the host after the view is created). The layer
        // moves instantly (no implicit animation).
        if let item = currentItem, case .shape(let shape) = item.kind, shape.shape != .rect {
            CardView.withoutLayerActions {
                shapeLayer.path = ShapePath.path(for: shape.shape, in: bounds)
                shapeLayer.frame = bounds
            }
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
        shapeLayer.fillColor = NSColor.clear.cgColor
        shapeLayer.strokeColor = (NSColor.fromHex(stroke.color) ?? .labelColor).cgColor
        shapeLayer.lineCap = .round
        shapeLayer.lineJoin = .round
        shapeLayer.opacity = stroke.marker ? 0.45 : 1
        // The path and its width are set in layout(), once
        // the card has its screen size (they scale with
        // the zoom).
        needsLayout = true
    }

    override public func layout() {
        super.layout()
        guard let item = currentItem, case .stroke(let stroke) = item.kind else { return }
        // The path is in world units (the points are
        // absolute, rebased by their bbox min); the card is
        // screen-sized, so the path and the stroke width are
        // scaled by the zoom — the card's screen size over
        // its world size. Without the scale the stroke drew
        // at world size inside a screen-sized card, which is
        // why the red circle and the branch looked huge and
        // offset at any zoom other than 1. The layer moves
        // instantly (no implicit animation).
        CardView.withoutLayerActions {
            let zoomX = item.size.w > 0 ? bounds.width / CGFloat(item.size.w) : 1
            let zoomY = item.size.h > 0 ? bounds.height / CGFloat(item.size.h) : 1
            if let path = StrokePath.path(for: stroke.points) {
                var transform = CGAffineTransform(scaleX: zoomX, y: zoomY)
                shapeLayer.path = path.copy(using: &transform)
            } else {
                shapeLayer.path = nil
            }
            shapeLayer.lineWidth = CGFloat(stroke.width) * zoomX
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
///
/// The text is two `CATextLayer`s, not `NSTextField`s: a
/// control does not reliably draw when an ancestor layer
/// carries the camera transform (the placeholders went
/// blank after the transform landed), while a layer draws
/// exactly where its frame is.
public final class PlaceholderCardView: CardView {
    private let titleLayer = CATextLayer()
    private let subtitleLayer = CATextLayer()

    override public init() {
        super.init()
        // A placeholder is not a blank card: a light grey
        // background and its kind name, so a media card
        // whose native view has not landed yet (M4/M5)
        // reads as "coming", not as an empty white card.
        layer?.backgroundColor = NSColor.systemGray.withAlphaComponent(0.08).cgColor
        // Explicit colours, not the semantic label colours:
        // a `CATextLayer`'s foreground is a fixed CGColor,
        // resolved once when it is set, and the semantic
        // colours resolved to white here (the AppKit side
        // is in Dark Mode even though the SwiftUI side is
        // forced light) — white text on the light grey tile
        // read as blank. The Electron app's ink is #1d1d1f.
        titleLayer.foregroundColor = NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).cgColor
        subtitleLayer.foregroundColor = NSColor(srgbRed: 0.42, green: 0.42, blue: 0.44, alpha: 1).cgColor
        titleLayer.truncationMode = .end
        titleLayer.alignmentMode = .left
        subtitleLayer.truncationMode = .end
        subtitleLayer.alignmentMode = .left
        for textLayer in [titleLayer, subtitleLayer] {
            textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            layer?.addSublayer(textLayer)
        }
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        switch item.kind {
        case .urlCard(let url):
            titleLayer.string = url.title ?? url.url
            subtitleLayer.string = "Link"
        case .pdfCard:
            titleLayer.string = "PDF"
            subtitleLayer.string = "PDFView in M4"
        case .fileCard(let file):
            titleLayer.string = file.path
            subtitleLayer.string = file.format.rawValue.uppercased()
        case .audio(let audio):
            titleLayer.string = audio.title ?? "Audio"
            subtitleLayer.string = "AVPlayerView in M5"
        case .video:
            titleLayer.string = "Video"
            subtitleLayer.string = "AVPlayerView in M5"
        case .model3D:
            titleLayer.string = "3D model"
            subtitleLayer.string = "SceneKit in M5"
        case .plugin(let plugin):
            titleLayer.string = plugin.kind
            subtitleLayer.string = "Plugin in M7"
        default:
            titleLayer.string = ""
            subtitleLayer.string = ""
        }
        needsLayout = true
    }

    override public func layout() {
        super.layout()
        // 12px in from the left, the title at the top and
        // the subtitle 4px below it. The card is y-up (a
        // plain NSView), so the top is at bounds.height.
        // The font sizes and the padding are in world units
        // (14 and 12, 12 and 4); the card is screen-sized,
        // so they scale by the zoom — the card's screen
        // width over its world width. The layers move
        // instantly (no implicit animation).
        CardView.withoutLayerActions {
            let zoom = (currentItem?.size.w ?? 0) > 0 ? bounds.width / CGFloat(currentItem!.size.w) : 1
            let pad = 12 * zoom
            let width = bounds.width - pad * 2
            // The fonts scale with the zoom, but never below
            // 6pt on screen: below that the title was
            // unreadable and the card read as a blank tile
            // when zoomed out.
            let titleSize = max(14 * zoom, 6)
            let subtitleSize = max(12 * zoom, 6)
            titleLayer.font = NSFont.systemFont(ofSize: titleSize, weight: .semibold)
            titleLayer.fontSize = titleSize
            subtitleLayer.font = NSFont.systemFont(ofSize: subtitleSize)
            subtitleLayer.fontSize = subtitleSize
            titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - 18 * zoom, width: width, height: 18 * zoom)
            subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - 18 * zoom - 4 * zoom - 16 * zoom, width: width, height: 16 * zoom)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlaceholderCardView is not Interface Builder backed")
    }
}
