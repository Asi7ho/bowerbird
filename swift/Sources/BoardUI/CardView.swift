import AppKit
import BowerbirdCore

/// A card's chrome, mirroring the Electron app's `.card`
/// (styles.css): a white background, a 1px hairline border,
/// a 12px radius, and a small shadow. Selected: a blue
/// border and a blue ring. Shape and stroke cards have no
/// shadow; stroke cards do not clip their content (the
/// stroke paints past the card's edge by half its width).
public class CardView: NSView {
    /// The item this view is currently showing. Set by
    /// `configure(item:)`; the host reads it when the view
    /// is laid out (shape and stroke paths are rebuilt for
    /// the frame).
    public private(set) var currentItem: Item?

    /// Reconfigure the view for an item (the recycling
    /// entry point). Subclasses override it, call super
    /// first, then update their content.
    open func configure(item: Item) {
        currentItem = item
    }

    /// Rebuild the card's drawn content for the given
    /// unrotated screen size, at once. The host calls
    /// this right after placing the card, passing the
    /// size it just set — so the shape or stroke is drawn
    /// from the size it has now, not left to the system's
    /// layout pass, and not read back from `bounds`:
    /// the debug file showed the views' frames are right
    /// on load while the parts still draw wrong, so the
    /// path was being built from a bounds that had not
    /// caught up with the new frame yet (a fresh view not
    /// yet in the window, or a recycled one). The size
    /// passed in is the truth; `bounds` is not read.
    /// Most cards draw nothing of their own (the chrome
    /// is in layout()); shape and stroke cards override
    /// this to rebuild their path.
    open func rebuildContent(size: CGSize) {}

    /// Whether the card is selected (blue border + ring).
    public var isSelected: Bool = false {
        didSet { updateChrome() }
    }

    /// Whether the card has a shadow (shape and stroke
    /// cards do not).
    public var hasShadow: Bool = true {
        didSet { updateChrome() }
    }

    /// Whether the card shows a border at all. Shape cards
    /// do not (the Electron app's shape card is
    /// `border:none`); their selection is the ring alone.
    public var showsBorder: Bool = true {
        didSet { updateChrome() }
    }

    /// Whether the card shows its border when it is not
    /// selected. Stroke cards do not (the Electron app's
    /// stroke card has no border — only the selection
    /// ring); a plain 1px border around a stroke reads as
    /// an empty card. A selected stroke still shows the
    /// blue border.
    public var showsUnselectedBorder: Bool = true {
        didSet { updateChrome() }
    }

    /// Whether the card clips its content (stroke cards do
    /// not — the stroke paints past the edge).
    public var clipsContent: Bool = true {
        didSet { layer?.masksToBounds = clipsContent }
    }

    /// Run a block with Core Animation's implicit actions
    /// disabled, so a layout pass (a zoom step, a pan)
    /// moves the layers instantly instead of animating
    /// them over 0.25s. A CALayer animates its frame, path
    /// and font size by default, which made the text and
    /// the strokes visibly drift inside the card while
    /// zooming. The card's own frame (an NSView) is not
    /// animated — only its layers are.
    public static func withoutLayerActions(_ body: () -> Void) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body()
        CATransaction.commit()
    }

    public init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.borderWidth = 1
        layer?.backgroundColor = NSColor.white.cgColor
        updateChrome()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("CardView is not Interface Builder backed")
    }

    /// The zoom the card is drawn at: its screen width
    /// over its world width.
    private var zoom: CGFloat {
        guard let item = currentItem, item.size.w > 0 else { return 1 }
        return bounds.width / CGFloat(item.size.w)
    }

    override public func layout() {
        super.layout()
        // Re-apply the chrome when the frame changes: the
        // border, radius and shadow scale with the zoom.
        updateChrome()
    }

    /// A card is a container for its content, not a click
    /// target: the viewport does the board's hit-testing
    /// geometrically (it walks the cards), so a click on
    /// the card itself must reach the viewport — otherwise
    /// the card could never be selected or dragged. Only
    /// a real subview takes the click: the text editor, a
    /// play button, a PDF or 3D view. A passive image view
    /// is decoration, not a target, so a click on it
    /// passes through too (an NSImageView swallows a click
    /// it does nothing with, which made image cards
    /// unselectable). A card that handles clicks itself —
    /// the audio card's seek track — says so by
    /// overriding this.
    override public func hitTest(_ point: NSPoint) -> NSView? {
        for subview in subviews.reversed() {
            if let hit = subview.hitTest(convert(point, to: subview)) {
                if hit is NSImageView { continue }
                return hit
            }
        }
        return nil
    }

    private func updateChrome() {
        guard let layer else { return }
        layer.masksToBounds = clipsContent
        // The chrome is in world units in the Electron app
        // (the CSS transform scales it), so here it scales
        // by the zoom. Without the scale, a card zoomed out
        // kept a 1px border and a 12px radius, which read
        // as a heavy outline and a pill at small sizes.
        let z = zoom
        layer.cornerRadius = 12 * z
        if isSelected {
            // A clear selection, not a whisper: a 2px blue
            // border (the Electron app's is 1px at half
            // strength, which read as too shy) and a
            // stronger ring around it.
            layer.borderWidth = showsBorder ? max(1, 2 * z) : 0
            layer.borderColor = NSColor.systemBlue.withAlphaComponent(0.9).cgColor
            layer.shadowColor = NSColor.systemBlue.cgColor
            layer.shadowOpacity = 0.5
            layer.shadowRadius = 3 * z
            layer.shadowOffset = .zero
        } else {
            // The Electron app's hairline, exactly:
            // black at 8% opacity, as a fixed colour, not
            // a semantic one — NSColor.separatorColor
            // resolves near-white under Dark Mode, so on a
            // white card over a white board the border
            // vanished entirely. And the width never goes
            // below one screen point: at low zoom 1 * z is
            // sub-pixel, so the edge disappeared and a card
            // melted into the board. A 1pt hairline is the
            // thinnest visible line, not a heavy outline.
            layer.borderWidth = (showsBorder && showsUnselectedBorder) ? max(1, 1 * z) : 0
            layer.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor
            if hasShadow {
                layer.shadowColor = NSColor.black.cgColor
                layer.shadowOpacity = 0.08
                layer.shadowRadius = 4 * z
                layer.shadowOffset = CGSize(width: 0, height: 1 * z)
            } else {
                layer.shadowOpacity = 0
            }
        }
    }
}
