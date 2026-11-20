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
            return UrlCardView()
        case .pdfCard:
            return PdfCardView()
        case .fileCard:
            return FileCardView()
        case .audio:
            return AudioCardView()
        case .video:
            return VideoCardView()
        case .model3D:
            return Model3DCardView()
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
    /// The editor hosted in the card while it is being
    /// edited (a SwiftUI text editor filling the card),
    /// and the text it is editing.
    private var editorHostingView: NSHostingView<NoteEditorContent>?
    private var editorModel: NoteEditorModel?

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

    /// Hides or shows the card's text layer. While a note
    /// is being edited, the editor in the card shows the
    /// text, so the layer is hidden and the text does not
    /// draw twice.
    public func setEditing(_ editing: Bool) {
        textLayer.isHidden = editing
    }

    /// Opens the editor in the card: a SwiftUI text editor
    /// filling the card, in the note's size and colours.
    /// It is hosted in the card itself, so it is always
    /// exactly on the card. The commit callback receives
    /// the final text when the user presses Escape or
    /// clicks away.
    public func startEditing(text: String, fontSize: CGFloat, isBold: Bool, textColorHex: String, backgroundHex: String, onCommit: @escaping (String) -> Void) {
        endEditing()
        let model = NoteEditorModel(text: text)
        editorModel = model
        let content = NoteEditorContent(text: $model.text, fontSize: fontSize, isBold: isBold, textColorHex: textColorHex, backgroundHex: backgroundHex, onCommit: onCommit)
        let hosting = NSHostingView(rootView: content)
        hosting.frame = bounds
        hosting.autoresizingMask = [.width, .height]
        addSubview(hosting)
        editorHostingView = hosting
        setEditing(true)
    }

    /// Closes the editor in the card, if one is open.
    public func endEditing() {
        editorHostingView?.removeFromSuperview()
        editorHostingView = nil
        editorModel = nil
        setEditing(false)
    }

    /// The text in the open editor, if one is open.
    public var editingText: String? {
        editorModel?.text
    }

    override public func layout() {
        super.layout()
        // 14px padding on every side, in world units — the
        // card is screen-sized, so the padding scales by
        // the zoom. A fixed 14 screen pixels ate the card
        // when dezoomed (a 72px-wide card kept only 44px
        // for text, a 28px card kept none), so the text
        // disappeared. The layer moves instantly (no
        // implicit animation): a zoom step would otherwise
        // animate the text across the card for a quarter
        // of a second.
        CardView.withoutLayerActions {
            // The zoom: the card's screen width over its
            // world width. The font size is in world units,
            // so it scales by the zoom — without the scale
            // the text drew at world size inside a
            // screen-sized card.
            let zoom: CGFloat
            if let item = currentItem, item.size.w > 0 {
                zoom = bounds.width / CGFloat(item.size.w)
            } else {
                zoom = 1
            }
            textLayer.frame = bounds.insetBy(dx: 14 * zoom, dy: 14 * zoom)
            if let item = currentItem, case .text(let text) = item.kind {
                let font = NSFont.systemFont(ofSize: CGFloat(text.size) * zoom, weight: text.bold ? .bold : .regular)
                textLayer.font = font
                textLayer.fontSize = CGFloat(text.size) * zoom
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
        if shape.shape == .rect, shape.outline != true {
            // A filled rect fills the whole card, so the
            // card itself is the fill (12px radius from the
            // base).
            layer?.backgroundColor = fill.cgColor
            shapeLayer.path = nil
        } else {
            layer?.backgroundColor = NSColor.clear.cgColor
            CardView.withoutLayerActions {
                updateShapeLayer()
            }
        }
        needsLayout = true
    }

    override public func layout() {
        super.layout()
        // The path is built for the current bounds; rebuild
        // it when the view is laid out (its frame is set by
        // the host after the view is created). The layer
        // moves instantly (no implicit animation). A filled
        // rect has no path (the card is the fill).
        if let item = currentItem, case .shape(let shape) = item.kind,
           !(shape.shape == .rect && shape.outline != true) {
            CardView.withoutLayerActions {
                updateShapeLayer()
            }
        }
    }

    /// The shape's path and colours for the current bounds.
    /// A rect is a rounded rect (12px radius, scaled by
    /// the zoom like the card chrome); every other shape
    /// comes from ShapePath. An outline shape is a 2px
    /// stroke in the fill colour with no fill; a filled
    /// shape is solid.
    private func updateShapeLayer() {
        guard let item = currentItem, case .shape(let shape) = item.kind else { return }
        let fill = NSColor.fromHex(shape.fill) ?? .labelColor
        let zoom = bounds.width / max(item.size.w, 1)
        if shape.shape == .rect {
            shapeLayer.path = CGPath(
                roundedRect: bounds, cornerWidth: 12 * zoom, cornerHeight: 12 * zoom, transform: nil
            )
        } else {
            shapeLayer.path = ShapePath.path(for: shape.shape, in: bounds)
        }
        // Flip the path about the card's height: the
        // shape's fractions are y-down (world coordinates)
        // and the card is y-up, so an unflipped triangle,
        // star or arrow drew mirrored — the inverse of
        // what was drawn, while the live preview (in the
        // flipped overlay) showed it the right way round.
        // Rects and ellipses are symmetric, so the flip is
        // invisible for them, but it is applied to every
        // shape for the same reason.
        if let path = shapeLayer.path {
            var flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: bounds.height)
            shapeLayer.path = path.copy(using: &flip)
        }
        shapeLayer.frame = bounds
        if shape.outline == true {
            shapeLayer.fillColor = NSColor.clear.cgColor
            shapeLayer.strokeColor = fill.cgColor
            // The Electron app's outline stroke is 4px wide
            // (shapeOutlineSvg), not 2px — a 2px line was
            // hard to see and hard to grab.
            shapeLayer.lineWidth = 4 * zoom
        } else {
            shapeLayer.fillColor = fill.cgColor
            shapeLayer.strokeColor = NSColor.clear.cgColor
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
        // No border when unselected: the card is only the
        // stroke itself, and a 1px border around it reads
        // as an empty card. The blue selection border
        // still shows when the stroke is selected.
        showsUnselectedBorder = false
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
                // The card is y-up (a plain NSView) while
                // the stroke's points are y-down (world
                // coordinates): a path copied straight
                // across draws mirrored top-to-bottom, so
                // the committed stroke was the inverse of
                // what was drawn — while the live preview,
                // drawn in the flipped overlay, showed it
                // the right way round. Flip it about the
                // card's height, so the stroke lands as
                // drawn.
                var transform = CGAffineTransform(a: zoomX, b: 0, c: 0, d: -zoomY, tx: 0, ty: bounds.height)
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
        // background and its kind name, so a card whose
        // native view has not landed yet (plugins, M7)
        // reads as "coming", not as an empty white card.
        // Every media kind now has its own view, so only
        // the plugin case is live here.
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
            titleLayer.font = NSFont.systemFont(ofSize: 14 * zoom, weight: .semibold)
            titleLayer.fontSize = 14 * zoom
            subtitleLayer.font = NSFont.systemFont(ofSize: 12 * zoom)
            subtitleLayer.fontSize = 12 * zoom
            titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - 18 * zoom, width: width, height: 18 * zoom)
            subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - 18 * zoom - 4 * zoom - 16 * zoom, width: width, height: 16 * zoom)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlaceholderCardView is not Interface Builder backed")
    }
}

/// A file card (a .psd or .ai), like the Electron app's:
/// the artwork preview on top, the file name and size
/// below it — not an image card, where the artwork fills
/// the whole card. Without a preview (a file whose
/// artwork could not be rendered) the top is a tile in
/// the format's colour, like the PDF's red tile: blue
/// PSD, orange AI.
public final class FileCardView: CardView {
    private let imageView = NSImageView()
    private let tileLayer = CALayer()
    private let tileTextLayer = CATextLayer()
    private let titleLayer = CATextLayer()
    private let subtitleLayer = CATextLayer()

    override public init() {
        super.init()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.wantsLayer = true
        imageView.layer?.masksToBounds = true
        addSubview(imageView)
        // Explicit colours, not the semantic label colours
        // (see PlaceholderCardView: a CATextLayer's
        // foreground is a fixed CGColor, and the semantic
        // colours resolved to white here).
        titleLayer.foregroundColor = NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).cgColor
        subtitleLayer.foregroundColor = NSColor(srgbRed: 0.42, green: 0.42, blue: 0.44, alpha: 1).cgColor
        titleLayer.truncationMode = .end
        subtitleLayer.truncationMode = .end
        tileTextLayer.alignmentMode = .center
        tileTextLayer.truncationMode = .end
        // The tile background goes in first, so the format
        // label draws on top of it (sublayers added later
        // sit above the earlier ones).
        layer?.addSublayer(tileLayer)
        for textLayer in [titleLayer, subtitleLayer, tileTextLayer] {
            textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            layer?.addSublayer(textLayer)
        }
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .fileCard(let file) = item.kind else { return }
        titleLayer.string = URL(fileURLWithPath: file.path).lastPathComponent
        subtitleLayer.string = "\(Int((Double(file.sizeBytes) / 1024).rounded())) KB · \(file.format.rawValue.uppercased())"
        // The format's colour: PSD blue, AI orange (the
        // Electron app's FileCard tints).
        let tintHex = file.format == .psd ? "#2E86AB" : "#FF6B35"
        let tint = NSColor.fromHex(tintHex) ?? .labelColor
        tileTextLayer.string = file.format.rawValue.uppercased()
        tileTextLayer.foregroundColor = tint.cgColor
        tileLayer.backgroundColor = Self.tinted(tint, amount: 0.88).cgColor
        imageView.image = file.preview.flatMap { NSImage(contentsOfFile: $0) }
        // With a preview the artwork is the tile and the
        // text is the name and size below it; without one,
        // the format tile takes the artwork's place.
        let hasPreview = imageView.image != nil
        tileLayer.isHidden = hasPreview
        tileTextLayer.isHidden = hasPreview
        imageView.isHidden = !hasPreview
        layer?.backgroundColor = NSColor.white.cgColor
        needsLayout = true
    }

    override public func layout() {
        super.layout()
        // Media-card chrome: 12px padding, 10px tile
        // radius, title 14px, subtitle 12px — all in
        // world units, scaled by the zoom. The card is
        // y-up, so the top is at bounds.height: the
        // preview (or the format tile) sits at the top,
        // the title and subtitle below it.
        guard let item = currentItem, case .fileCard = item.kind else { return }
        CardView.withoutLayerActions {
            let zoom = item.size.w > 0 ? bounds.width / CGFloat(item.size.w) : 1
            let pad = 12 * zoom
            let width = bounds.width - pad * 2
            titleLayer.font = NSFont.systemFont(ofSize: 14 * zoom, weight: .semibold)
            titleLayer.fontSize = 14 * zoom
            subtitleLayer.font = NSFont.systemFont(ofSize: 12 * zoom)
            subtitleLayer.fontSize = 12 * zoom
            let titleH: CGFloat = 18 * zoom
            let subH: CGFloat = 16 * zoom
            let gap: CGFloat = 4 * zoom
            let textH = titleH + gap + subH
            let mediaH = bounds.height - pad * 2 - textH - gap
            let mediaRect = CGRect(x: pad, y: bounds.height - pad - mediaH, width: width, height: max(mediaH, 0))
            imageView.frame = mediaRect
            imageView.layer?.cornerRadius = 10 * zoom
            tileLayer.frame = mediaRect
            tileLayer.cornerRadius = 10 * zoom
            tileTextLayer.font = NSFont.systemFont(ofSize: 13 * zoom, weight: .semibold)
            tileTextLayer.fontSize = 13 * zoom
            tileTextLayer.frame = CGRect(x: mediaRect.minX, y: mediaRect.minY + (mediaRect.height - 18 * zoom) / 2, width: mediaRect.width, height: 18 * zoom)
            titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH, width: width, height: titleH)
            subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH - gap - subH, width: width, height: subH)
        }
    }

    /// A colour lightened towards white by `amount` (the
    /// Electron app's `tint`: 0.88 is nearly white, the
    /// format's colour showing through).
    private static func tinted(_ color: NSColor, amount: Double) -> NSColor {
        let rgb = color.usingColorSpace(.sRGB) ?? color
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        rgb.getRed(&r, green: &g, blue: &b, alpha: &a)
        let m = CGFloat(amount)
        return NSColor(srgbRed: r + (1 - r) * m, green: g + (1 - g) * m, blue: b + (1 - b) * m, alpha: 1)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("FileCardView is not Interface Builder backed")
    }
}

/// A web link card: the page's image, title and
/// description, the Electron app's media-card chrome
/// (image on top, title and description below). The image
/// is fetched from its URL and cached in memory; a card
/// whose image has not loaded yet (or has none) still
/// shows its title and description, so a link is never a
/// grey tile. A live web view (WKWebView) is M5; this is
/// the link's preview, not the page.
public final class UrlCardView: CardView {
    /// The fetched link images, by URL, so a card that is
    /// reconfigured (any board change reconfigures every
    /// visible card) does not refetch — and the card never
    /// blanks while it is only being moved.
    private static var imageCache = NSCache<NSString, NSImage>()
    private let imageView = NSImageView()
    private let titleLayer = CATextLayer()
    private let subtitleLayer = CATextLayer()
    /// The image URL this view is showing, so a
    /// reconfigure for the same card keeps its image
    /// instead of fetching it again.
    private var currentImageURL: String?
    /// The image URL this view is loading, so a late
    /// response for a recycled view (now showing another
    /// card) never paints the wrong image.
    private var loadingImageURL: String?

    override public init() {
        super.init()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.wantsLayer = true
        imageView.layer?.masksToBounds = true
        addSubview(imageView)
        titleLayer.foregroundColor = NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).cgColor
        subtitleLayer.foregroundColor = NSColor(srgbRed: 0.42, green: 0.42, blue: 0.44, alpha: 1).cgColor
        titleLayer.truncationMode = .end
        subtitleLayer.truncationMode = .end
        for textLayer in [titleLayer, subtitleLayer] {
            textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            layer?.addSublayer(textLayer)
        }
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .urlCard(let url) = item.kind else { return }
        titleLayer.string = url.title ?? url.url
        subtitleLayer.string = url.description ?? URL(string: url.url)?.host ?? "Link"
        // The image is cached in memory and kept across
        // reconfigures: the host reconfigures every visible
        // card on any board change (a move, a resize, a new
        // card), and blanking the image and fetching it
        // again every time made the link card reload on
        // every movement. A card showing the same image
        // keeps it; only a new image URL fetches.
        guard url.image != currentImageURL else { return }
        currentImageURL = url.image
        loadingImageURL = url.image
        if let imageURLString = url.image, let cached = Self.imageCache.object(forKey: imageURLString as NSString) {
            imageView.image = cached
            needsLayout = true
            return
        }
        imageView.image = nil
        layer?.backgroundColor = NSColor.white.cgColor
        if let imageURLString = url.image, let imageURL = URL(string: imageURLString) {
            URLSession.shared.dataTask(with: imageURL) { [weak self] data, _, _ in
                guard let self, let data, let image = NSImage(data: data) else { return }
                Self.imageCache.setObject(image, forKey: imageURLString as NSString)
                DispatchQueue.main.async {
                    // Only paint when this view still shows
                    // the card that asked for this image.
                    guard self.loadingImageURL == imageURLString else { return }
                    self.imageView.image = image
                    self.needsLayout = true
                }
            }.resume()
        }
        needsLayout = true
    }

    override public func layout() {
        super.layout()
        // Media-card chrome: 12px padding, 10px image
        // radius, title 14px, description 12px — all in
        // world units, scaled by the zoom. The card is
        // y-up, so the top is at bounds.height: the image
        // sits at the top, the title and description below
        // it. Without an image, the text fills the card
        // like the placeholder tile.
        guard let item = currentItem, case .urlCard = item.kind else { return }
        CardView.withoutLayerActions {
            let zoom = item.size.w > 0 ? bounds.width / CGFloat(item.size.w) : 1
            let pad = 12 * zoom
            let width = bounds.width - pad * 2
            titleLayer.font = NSFont.systemFont(ofSize: 14 * zoom, weight: .semibold)
            titleLayer.fontSize = 14 * zoom
            subtitleLayer.font = NSFont.systemFont(ofSize: 12 * zoom)
            subtitleLayer.fontSize = 12 * zoom
            if imageView.image != nil {
                let titleH: CGFloat = 18 * zoom
                let subH: CGFloat = 16 * zoom
                let gap: CGFloat = 4 * zoom
                let textH = titleH + gap + subH
                let imageH = bounds.height - pad * 2 - textH - gap
                imageView.frame = CGRect(x: pad, y: bounds.height - pad - imageH, width: width, height: max(imageH, 0))
                imageView.layer?.cornerRadius = 10 * zoom
                imageView.isHidden = false
                titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - imageH - gap - titleH, width: width, height: titleH)
                subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - imageH - gap - titleH - gap - subH, width: width, height: subH)
            } else {
                imageView.isHidden = true
                titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - 18 * zoom, width: width, height: 18 * zoom)
                subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - 18 * zoom - 4 * zoom - 16 * zoom, width: width, height: 16 * zoom)
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("UrlCardView is not Interface Builder backed")
    }
}
