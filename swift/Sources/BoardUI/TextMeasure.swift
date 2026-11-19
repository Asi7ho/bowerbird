import AppKit

/// Measuring a note's text height, for the card's height
/// when its text is committed. The text is measured at the
/// note's width (less the card's 14px padding on each side)
/// and font size, using the system font — the same font the
/// card renders with.
public enum TextMeasure {
    /// The height of the wrapped text, in points.
    public static func height(text: String, fontSize: Double, width: Double) -> Double {
        let font = NSFont.systemFont(ofSize: CGFloat(fontSize))
        let attr = NSAttributedString(string: text, attributes: [.font: font])
        let rect = attr.boundingRect(
            with: NSSize(width: CGFloat(max(1, width)), height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        return ceil(rect.height)
    }

    /// A note card's height for its text: the text height
    /// plus the card's 14px padding top and bottom, at
    /// least 48 (the height of a new, empty note).
    public static func noteHeight(text: String, fontSize: Double, width: Double) -> Double {
        max(48, height(text: text, fontSize: fontSize, width: width - 28) + 28)
    }
}
