import AppKit

/// A card's chrome, mirroring the Electron app's `.card`
/// (styles.css): a white background, a 1px hairline border,
/// a 12px radius, and a small shadow. Selected: a blue
/// border and a blue ring. Shape and stroke cards have no
/// shadow; stroke cards do not clip their content (the
/// stroke paints past the card's edge by half its width).
public class CardView: NSView {
    /// Whether the card is selected (blue border + ring).
    public var isSelected: Bool = false {
        didSet { updateChrome() }
    }

    /// Whether the card has a shadow (shape and stroke
    /// cards do not).
    public var hasShadow: Bool = true {
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
            layer.borderColor = NSColor.systemBlue.withAlphaComponent(0.5).cgColor
            layer.shadowColor = NSColor.systemBlue.cgColor
            layer.shadowOpacity = 0.35
            layer.shadowRadius = 2
            layer.shadowOffset = .zero
        } else {
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
