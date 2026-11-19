import AppKit

/// The note colour bar: the 8 background colours a text
/// note can take, as a vertical column of swatches beside
/// a selected note. Clicking a swatch sets the background
/// of every selected text note, in one undo step. The
/// colours are the Electron app's NOTE_COLOURS.
public final class NoteColourBarView: NSView {
    /// The 8 note background colours (white, yellow, pink,
    /// green, blue, orange, purple, grey).
    public static let colours: [String] = [
        "#FFFFFF", "#FEF3C7", "#FCE7F3", "#DCFCE7",
        "#DBEAFE", "#FFEDD5", "#EDE9FE", "#F3F4F6",
    ]

    /// Called with the hex when a swatch is clicked.
    public var onPick: ((String) -> Void)?

    /// The colour to highlight as active (the selected
    /// notes' background, when they agree).
    public var activeHex: String? {
        didSet { updateActive() }
    }

    private var buttons: [NSButton] = []

    public init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.white.cgColor
        layer?.cornerRadius = 10
        layer?.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor
        layer?.borderWidth = 1
        layer?.shadowColor = NSColor.black.withAlphaComponent(0.15).cgColor
        layer?.shadowRadius = 8
        layer?.shadowOffset = NSSize(width: 0, height: -2)
        for hex in Self.colours {
            let button = NSButton()
            button.title = ""
            button.isBordered = false
            button.wantsLayer = true
            button.layer?.backgroundColor = (NSColor.fromHex(hex) ?? .white).cgColor
            button.layer?.cornerRadius = 6
            button.layer?.borderColor = NSColor.black.withAlphaComponent(0.15).cgColor
            button.layer?.borderWidth = 1
            button.target = self
            button.action = #selector(swatchClicked(_:))
            button.identifier = NSUserInterfaceItemIdentifier(hex)
            addSubview(button)
            buttons.append(button)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("NoteColourBarView is not Interface Builder backed")
    }

    override public func layout() {
        super.layout()
        // 8 swatches, 24px each, 6px gaps, 10px padding.
        let swatch: CGFloat = 24
        let gap: CGFloat = 6
        let pad: CGFloat = 10
        var y = bounds.height - pad - swatch
        for button in buttons {
            button.frame = NSRect(x: pad, y: y, width: swatch, height: swatch)
            y -= swatch + gap
        }
    }

    /// The bar's fixed size: 44 wide, 254 tall.
    public static var barSize: NSSize { NSSize(width: 44, height: 254) }

    private func updateActive() {
        for button in buttons {
            let hex = button.identifier?.rawValue ?? ""
            let active = activeHex.map { $0.uppercased() } == hex.uppercased()
            button.layer?.borderWidth = active ? 2 : 1
            button.layer?.borderColor = active
                ? NSColor.systemBlue.cgColor
                : NSColor.black.withAlphaComponent(0.15).cgColor
        }
    }

    @objc private func swatchClicked(_ sender: NSButton) {
        guard let hex = sender.identifier?.rawValue else { return }
        onPick?(hex)
    }
}
