import AppKit

/// Renders a text card's markdown to an attributed string
/// at the card's font size, for the display layer. The
/// editor stays plain (raw markdown); the card shows the
/// rendered text. Bold, italic, code, links, headings and
/// list items are handled by a small hand-rolled parser —
/// the system's markdown parser proved unreliable here
/// (its fonts lose bold/italic traits and its runs split
/// unpredictably), so the parser is explicit and
/// deterministic. Plain text is valid markdown, so it
/// renders unchanged.
public enum MarkdownText {
    /// An attributed string for `text` at `fontSize`
    /// (screen points), in `color`, with the card's bold
    /// flag applied throughout.
    public static func attributedString(for text: String, fontSize: CGFloat, bold: Bool, color: NSColor) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let lines = text.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
            if index > 0 {
                result.append(NSAttributedString(string: "\n", attributes: [
                    NSAttributedString.Key.font: NSFont.systemFont(ofSize: fontSize, weight: bold ? .bold : .regular),
                    NSAttributedString.Key.foregroundColor: color,
                ]))
            }
            appendLine(line, fontSize: fontSize, bold: bold, color: color, into: result)
        }
        return result
    }

    /// The plain-text fallback: the text in the card's
    /// font and colour, with no markdown interpretation.
    public static func plain(text: String, fontSize: CGFloat, bold: Bool, color: NSColor) -> NSAttributedString {
        let font = NSFont.systemFont(ofSize: fontSize, weight: bold ? .bold : .regular)
        return NSAttributedString(string: text, attributes: [NSAttributedString.Key.font: font, NSAttributedString.Key.foregroundColor: color])
    }

    // MARK: - Lines

    /// One line: a heading (`#`, `##`, `###`), a list
    /// item (`-` or `*`), or a body line. The heading's
    /// size stays proportionally larger; a list item gets
    /// a bullet. Inline bold, italic, code and links are
    /// parsed inside the line's content.
    private static func appendLine(_ line: String, fontSize: CGFloat, bold: Bool, color: NSColor, into result: NSMutableAttributedString) {
        var content = line
        var size = fontSize
        var lineBold = bold
        var prefix = ""
        if let hashes = headingPrefix(of: line) {
            size = fontSize * [1.0, 1.5, 1.3, 1.15][min(hashes, 3)]
            lineBold = true
            content = String(line.dropFirst(hashes).drop(while: { $0 == " " }))
        } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
            prefix = "• "
            content = String(line.dropFirst(2))
        }
        if !prefix.isEmpty {
            result.append(NSAttributedString(string: prefix, attributes: [
                NSAttributedString.Key.font: NSFont.systemFont(ofSize: size, weight: lineBold ? .bold : .regular),
                NSAttributedString.Key.foregroundColor: color,
            ]))
        }
        appendInline(content, size: size, bold: lineBold, color: color, into: result)
    }

    /// The number of leading `#` (1–3) if the line is a
    /// heading (`# `, `## `, `### `), else nil.
    private static func headingPrefix(of line: String) -> Int? {
        var count = 0
        for ch in line {
            if ch == "#" { count += 1 } else { break }
        }
        guard count >= 1 && count <= 3 else { return nil }
        let rest = line.dropFirst(count)
        guard rest.hasPrefix(" ") else { return nil }
        return count
    }

    // MARK: - Inline

    /// Inline bold (`**…**`), italic (`*…*`), code
    /// (`` `…` ``) and links (`[…](…)`) inside a line.
    /// Unmatched markers are left as plain text.
    private static func appendInline(_ text: String, size: CGFloat, bold: Bool, color: NSColor, into result: NSMutableAttributedString) {
        let chars = Array(text)
        var i = 0
        while i < chars.count {
            // Bold: **…**
            if chars[i] == "*", i + 1 < chars.count, chars[i + 1] == "*",
               let end = find(chars, marker: "**", from: i + 2) {
                let inner = String(chars[(i + 2)..<end])
                appendRun(inner, size: size, bold: true, italic: false, code: false, color: color, into: result)
                i = end + 2
                continue
            }
            // Italic: *…*
            if chars[i] == "*",
               let end = find(chars, marker: "*", from: i + 1) {
                let inner = String(chars[(i + 1)..<end])
                appendRun(inner, size: size, bold: bold, italic: true, code: false, color: color, into: result)
                i = end + 1
                continue
            }
            // Code: `…`
            if chars[i] == "`",
               let end = find(chars, marker: "`", from: i + 1) {
                let inner = String(chars[(i + 1)..<end])
                appendRun(inner, size: size, bold: bold, italic: false, code: true, color: color, into: result)
                i = end + 1
                continue
            }
            // Link: […](…)
            if chars[i] == "[",
               let closeBracket = find(chars, marker: "]", from: i + 1),
               closeBracket + 1 < chars.count, chars[closeBracket + 1] == "(",
               let closeParen = find(chars, marker: ")", from: closeBracket + 2) {
                let label = String(chars[(i + 1)..<closeBracket])
                let urlString = String(chars[(closeBracket + 2)..<closeParen])
                appendRun(label, size: size, bold: bold, italic: false, code: false, color: color, into: result, link: urlString)
                i = closeParen + 1
                continue
            }
            // Plain run up to the next marker — or the
            // unmatched marker itself as plain text, so a
            // lone * does not stall the scan.
            var j = i
            while j < chars.count, chars[j] != "*", chars[j] != "`", chars[j] != "[" {
                j += 1
            }
            if j == i {
                appendRun(String(chars[i]), size: size, bold: bold, italic: false, code: false, color: color, into: result)
                i += 1
            } else {
                let plain = String(chars[i..<j])
                appendRun(plain, size: size, bold: bold, italic: false, code: false, color: color, into: result)
                i = j
            }
        }
    }

    /// The index of the next occurrence of `marker`
    /// (one or two characters) at or after `from`, or nil.
    private static func find(_ chars: [Character], marker: String, from: Int) -> Int? {
        let mark = Array(marker)
        guard mark.count >= 1 else { return nil }
        var i = from
        while i + mark.count <= chars.count {
            if Array(chars[i..<(i + mark.count)]) == mark { return i }
            i += 1
        }
        return nil
    }

    /// One run of text, in the system font at `size`,
    /// with bold, italic and code (monospace) applied.
    private static func appendRun(_ text: String, size: CGFloat, bold: Bool, italic: Bool, code: Bool, color: NSColor, into result: NSMutableAttributedString, link: String? = nil) {
        guard !text.isEmpty else { return }
        let font: NSFont
        if code {
            font = NSFont.monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
        } else {
            var f = NSFont.systemFont(ofSize: size, weight: bold ? .bold : .regular)
            if italic {
                f = NSFontManager.shared.convert(f, toHaveTrait: .italicFontMask)
            }
            font = f
        }
        var attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key.font: font,
            NSAttributedString.Key.foregroundColor: color,
        ]
        if let link = link, let url = URL(string: link) {
            attributes[NSAttributedString.Key.link] = url
        }
        result.append(NSAttributedString(string: text, attributes: attributes))
    }
}
