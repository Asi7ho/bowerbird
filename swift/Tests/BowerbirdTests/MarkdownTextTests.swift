import AppKit
import XCTest
@testable import BoardUI

/// The markdown display fix: the body size is the size
/// covering the most characters, not the most runs. A
/// heading and its body are one run each — counting runs
/// lets the heading win the tie and shrinks the body to
/// half the card's size.
final class MarkdownTextTests: XCTestCase {
    func testHeadingPlusLongBodyKeepsBodyAtCardSize() {
        let text = "# Title\nThis is a long body of text that goes on and on and on and on and on."
        let rendered = MarkdownText.attributedString(for: text, fontSize: 20, bold: false, color: .black)
        // The body run is the long one; its font must
        // land on the card's size.
        var bodySize: CGFloat?
        rendered.enumerateAttribute(NSAttributedString.Key.font, in: NSRange(location: 0, length: rendered.length), options: []) { value, range, _ in
            guard let font = value as? NSFont else { return }
            // The body run is the longest run.
            if range.length > 20 { bodySize = font.pointSize }
        }
        guard let size = bodySize else { XCTFail("no body run found"); return }
        XCTAssertEqual(size, 20, accuracy: 0.5)
    }

    func testBoldAndItalicKeepTheirTraits() {
        let text = "plain **bold** *italic*"
        let rendered = MarkdownText.attributedString(for: text, fontSize: 16, bold: false, color: .black)
        var sawBold = false
        var sawItalic = false
        rendered.enumerateAttribute(NSAttributedString.Key.font, in: NSRange(location: 0, length: rendered.length), options: []) { value, _, _ in
            guard let font = value as? NSFont else { return }
            if font.fontDescriptor.symbolicTraits.contains(.bold) { sawBold = true }
            if font.fontDescriptor.symbolicTraits.contains(.italic) { sawItalic = true }
        }
        XCTAssertTrue(sawBold, "bold run lost its trait")
        XCTAssertTrue(sawItalic, "italic run lost its trait")
    }
}
