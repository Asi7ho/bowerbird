import AppKit

/// Measuring a note's text height, for the card's height
/// when its text is committed. The text is measured at the
/// note's width (less the card's 14px padding on each side)
/// and font size, using the system font — the same font the
/// card renders with.
///
/// Measured with TextKit (a layout manager and text
/// container), not `boundingRect`: `boundingRect` came up
/// short on wrapped text, so a card that grew to the
/// measured height still cut its text — the top scrolled
/// out of the editor while it grew, and the bottom was
/// clipped once the edit was left. The layout manager is
/// the same layout the editor's text view uses, so the
/// height it reports is the height the text needs.
public enum TextMeasure {
    /// The height of the wrapped text, in points.
    public static func height(text: String, fontSize: Double, width: Double, bold: Bool = false) -> Double {
        let font = NSFont.systemFont(ofSize: CGFloat(fontSize), weight: bold ? .bold : .regular)
        let storage = NSTextStorage(string: text, attributes: [.font: font])
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: CGFloat(max(1, width)), height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        layout.ensureLayout(for: container)
        return ceil(layout.usedRect(for: container).height)
    }

    /// A note card's height for its text: the text height
    /// plus the card's 14px padding top and bottom, at
    /// least 48 (the height of a new, empty note).
    public static func noteHeight(text: String, fontSize: Double, width: Double, bold: Bool = false) -> Double {
        max(48, height(text: text, fontSize: fontSize, width: width - 28, bold: bold) + 28)
    }
}
