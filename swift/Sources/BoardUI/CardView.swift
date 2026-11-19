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

    /// Whether the card clips its content (stroke cards do
    /// not — the stroke paints past the edge).
    public var clipsContent: Bool = true {
        didSet { layer?.masksToBounds = clipsContent }
    }

    public init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.borderWidth = 1
        layer?.backgroundColor = NSColor.white.cgColor
        updateChrome()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("CardView is not Interface Builder backed")
    }

    private func updateChrome() {
        guard let layer else { return }
        layer.masksToBounds = clipsContent
        if isSelected {
            // A clear selection, not a whisper: a 2px blue
            // border (the Electron app's is 1px at half
            // strength, which read as too shy) and a
            // stronger ring around it.
            layer.borderWidth = showsBorder ? 2 : 0
            layer.borderColor = NSColor.systemBlue.withAlphaComponent(0.9).cgColor
            layer.shadowColor = NSColor.systemBlue.cgColor
            layer.shadowOpacity = 0.5
            layer.shadowRadius = 3
            layer.shadowOffset = .zero
        } else {
            layer.borderWidth = showsBorder ? 1 : 0
            layer.borderColor = NSColor.separatorColor.cgColor
            if hasShadow {
                layer.shadowColor = NSColor.black.cgColor
                layer.shadowOpacity = 0.08
                layer.shadowRadius = 4
                layer.shadowOffset = CGSize(width: 0, height: 1)
            } else {
                layer.shadowOpacity = 0
            }
        }
    }
}
