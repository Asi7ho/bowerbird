import AppKit

/// Renders a text card's markdown to an attributed string
/// at the card's font size, for the display layer. The
/// editor stays plain (raw markdown); the card shows the
/// rendered text. Bold, italic, headings, lists, links and
/// code are handled by the system's markdown parser; the
/// fonts are then scaled to the card's size, keeping
/// bold/italic and the headings' relative scale. Plain
/// text is valid markdown, so it renders unchanged.
public enum MarkdownText {
    /// An attributed string for `text` at `fontSize`
    /// (screen points), in `color`, with the card's bold
    /// flag applied throughout.
    public static func attributedString(for text: String, fontSize: CGFloat, bold: Bool, color: NSColor) -> NSAttributedString {
        guard let parsed = try? NSAttributedString(markdown: text, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .full), baseURL: nil) else {
            return plain(text: text, fontSize: fontSize, bold: bold, color: color)
        }
        let mutable = NSMutableAttributedString(attributedString: parsed)
        guard mutable.length > 0 else {
            return plain(text: text, fontSize: fontSize, bold: bold, color: color)
        }
        // The parser's body font size is the reference:
        // scale every font so the body lands on the card's
        // size, keeping headings proportionally larger.
        // The reference is the size covering the most
        // characters (not the most runs — a heading and
        // its body are one run each, and the heading
        // would win the tie and shrink the body).
        let bodySize = referenceBodySize(in: mutable) ?? 13
        let scale = fontSize / bodySize
        let range = NSRange(location: 0, length: mutable.length)
        mutable.enumerateAttribute(NSAttributedString.Key.font, in: range, options: []) { value, fontRange, _ in
            guard let font = value as? NSFont else { return }
            // Rebuild on the system font at the scaled
            // size, keeping bold and italic from the
            // parser's run — the parser's family is not
            // the card's, so converting its size alone
            // keeps the wrong face.
            let traits = font.fontDescriptor.symbolicTraits
            var sized = NSFont.systemFont(ofSize: font.pointSize * scale, weight: traits.contains(.bold) ? .bold : .regular)
            if traits.contains(.italic) {
                sized = NSFontManager.shared.convert(sized, toHaveTrait: .italicFontMask)
            }
            mutable.addAttribute(NSAttributedString.Key.font, value: sized, range: fontRange)
        }
        mutable.addAttribute(NSAttributedString.Key.foregroundColor, value: color, range: range)
        if bold {
            // The card's bold flag: make every run bold,
            // keeping italic where the markdown set it.
            mutable.enumerateAttribute(NSAttributedString.Key.font, in: range, options: []) { value, fontRange, _ in
                guard let font = value as? NSFont else { return }
                let boldFont = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
                mutable.addAttribute(NSAttributedString.Key.font, value: boldFont, range: fontRange)
            }
        }
        return mutable
    }

    /// The plain-text fallback: the text in the card's
    /// font and colour, with no markdown interpretation.
    public static func plain(text: String, fontSize: CGFloat, bold: Bool, color: NSColor) -> NSAttributedString {
        let font = NSFont.systemFont(ofSize: fontSize, weight: bold ? .bold : .regular)
        return NSAttributedString(string: text, attributes: [NSAttributedString.Key.font: font, NSAttributedString.Key.foregroundColor: color])
    }

    /// The font size the parser used for body text — the
    /// size covering the most characters. Headings are
    /// larger, code is usually the same size, so the mode
    /// by character count is the body size.
    private static func referenceBodySize(in string: NSAttributedString) -> CGFloat? {
        var counts: [CGFloat: Int] = [:]
        string.enumerateAttribute(NSAttributedString.Key.font, in: NSRange(location: 0, length: string.length), options: []) { value, range, _ in
            guard let font = value as? NSFont else { return }
            counts[font.pointSize, default: 0] += range.length
        }
        return counts.max(by: { $0.value < $1.value })?.key
    }
}
