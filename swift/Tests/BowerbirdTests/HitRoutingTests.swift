import AppKit
import XCTest
@testable import BoardUI
import BowerbirdCore

/// The click routing: a click must land on the view that
/// handles it, and pass through every view that does not.
/// The board's overlays and grid are drawing surfaces,
/// the cards are containers — only a real control (the
/// text editor, a play button, a PDF or 3D view, the
/// audio seek track) takes a click. Everything else
/// passes through to the viewport, which does the board's
/// hit-testing geometrically. Before this, the overlays
/// and the cards swallowed clicks: the text editor could
/// not be typed in (a click into it never reached it, and
/// the viewport's mouseDown stole the focus instead), the
/// toolbar flyout never opened, and an audio card could
/// not be selected by its body.
final class HitRoutingTests: XCTestCase {
    private func textItem(id: Int = 1) -> Item {
        Item(
            id: id, pos: Pt(x: 100, y: 100), size: Size(w: 260, h: 48), group: nil,
            kind: .text(TextPayload(text: "Hello", bold: false, size: 16, color: "#1A1A1A", bg: nil)),
            rotation: nil
        )
    }

    /// The overlays are full-viewport drawing surfaces:
    /// a click on one must pass through, not die there.
    func testOverlayPassesClicksThrough() {
        let overlay = WorldView()
        overlay.frame = CGRect(x: 0, y: 0, width: 200, height: 200)
        XCTAssertNil(overlay.hitTest(CGPoint(x: 100, y: 100)))
    }

    /// The grid is a drawing surface too: a click on
    /// empty board must reach the viewport, not the grid.
    func testGridPassesClicksThrough() {
        let grid = GridView()
        grid.frame = CGRect(x: 0, y: 0, width: 200, height: 200)
        XCTAssertNil(grid.hitTest(CGPoint(x: 100, y: 100)))
    }

    /// A card's body passes the click through (the
    /// viewport selects and drags it), while a subview
    /// inside the card keeps its own clicks — and a
    /// passive image view is decoration, not a target.
    func testCardPassesBodyClicksThroughButKeepsSubviewClicks() {
        let card = CardView()
        card.frame = CGRect(x: 0, y: 0, width: 200, height: 100)
        XCTAssertNil(card.hitTest(CGPoint(x: 100, y: 50)))
        let button = NSButton(frame: CGRect(x: 10, y: 10, width: 40, height: 40))
        card.addSubview(button)
        XCTAssertTrue(card.hitTest(CGPoint(x: 30, y: 30)) === button)
        let image = NSImageView(frame: CGRect(x: 60, y: 10, width: 40, height: 40))
        card.addSubview(image)
        XCTAssertNil(card.hitTest(CGPoint(x: 80, y: 30)))
    }

    /// The container checks its cards: a click on a card
    /// body passes through the container, and a click on
    /// the text editor inside the card lands on the
    /// editor — so it can be clicked into and typed in.
    func testContainerPassesBoardClicksThroughButKeepsEditorClicks() {
        let container = WorldView()
        container.frame = CGRect(x: 0, y: 0, width: 500, height: 500)
        let card = TextCardView()
        card.configure(item: textItem())
        card.frame = CGRect(x: 100, y: 100, width: 260, height: 48)
        container.addSubview(card)
        XCTAssertNil(container.hitTest(CGPoint(x: 150, y: 120)))
        let editor = NSTextView(frame: card.bounds)
        card.addSubview(editor)
        XCTAssertTrue(container.hitTest(CGPoint(x: 150, y: 120)) === editor)
    }

    /// The toolbar's buttons take the click, and clicking
    /// one opens its flyout at once — the flyout is the
    /// panel holding that family's picks, and it is shown.
    func testToolbarButtonTakesTheClickAndOpensItsFlyout() {
        let tools = ToolState()
        let toolbar = ToolbarNSView(tools: tools)
        toolbar.frame = CGRect(origin: .zero, size: ToolbarNSView.barSize)
        toolbar.layout()
        guard let button = toolbar.subviews.compactMap({ $0 as? NSButton })
            .first(where: { $0.identifier?.rawValue == "family.select" }) else {
            XCTFail("no select family button")
            return
        }
        let centre = CGPoint(x: button.frame.midX, y: button.frame.midY)
        XCTAssertTrue(toolbar.hitTest(centre) === button)
        button.performClick(nil)
        XCTAssertEqual(tools.pickerOpen, .select)
        let flyout = toolbar.subviews.first(where: { view in
            view.subviews.contains(where: { ($0 as? NSButton)?.identifier?.rawValue == "pick.select.select" })
        })
        XCTAssertNotNil(flyout)
        XCTAssertEqual(flyout?.isHidden, false)
    }

    /// The audio card: the seek track takes the click
    /// (the card itself), the play button takes its own,
    /// and the body passes through so the card can still
    /// be selected and dragged.
    func testAudioCardKeepsSeekButtonAndBodyClicks() throws {
        // A file that exists (its content does not matter
        // — only that a player can be created for it), so
        // the seek track is live.
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("bowerbird-hit-test-audio.mp3")
        try Data().write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let card = AudioCardView()
        let item = Item(
            id: 1, pos: Pt(x: 0, y: 0), size: Size(w: 300, h: 104), group: nil,
            kind: .audio(AudioPayload(path: url.path, title: "Test", transcript: nil)),
            rotation: nil
        )
        card.configure(item: item)
        card.frame = CGRect(x: 0, y: 0, width: 300, height: 104)
        card.layout()
        // The track is centred in the tile (y 56...72 at
        // zoom 1); the play button sits at its left.
        XCTAssertTrue(card.hitTest(CGPoint(x: 170, y: 64)) === card)
        guard let playButton = card.subviews.compactMap({ $0 as? NSButton }).first else {
            XCTFail("no play button")
            return
        }
        XCTAssertFalse(playButton.frame.isEmpty, "play button has no frame")
        let buttonHit = card.hitTest(CGPoint(x: playButton.frame.midX, y: playButton.frame.midY))
        XCTAssertTrue(buttonHit === playButton, "button frame \(playButton.frame), card bounds \(card.bounds), hitTest returned \(String(describing: buttonHit))")
        XCTAssertNil(card.hitTest(CGPoint(x: 150, y: 10)))
    }

    /// The card border never goes sub-pixel: at zoom 1 it
    /// is 1pt, and at zoom 0.25 it stays a 1pt hairline
    /// instead of shrinking to a quarter pixel and
    /// vanishing — a card must keep its edge against the
    /// board at any zoom. Selected, it floors at 1pt too
    /// and is the full 2pt at zoom 1.
    func testBorderNeverGoesSubPixel() {
        let card = TextCardView()
        card.configure(item: textItem())
        card.frame = CGRect(x: 0, y: 0, width: 260, height: 48)
        card.layout()
        XCTAssertEqual(card.layer?.borderWidth, 1)
        card.frame = CGRect(x: 0, y: 0, width: 65, height: 12)
        card.layout()
        XCTAssertEqual(card.layer?.borderWidth, 1)
        card.isSelected = true
        card.layout()
        XCTAssertEqual(card.layer?.borderWidth, 1)
        card.frame = CGRect(x: 0, y: 0, width: 260, height: 48)
        card.layout()
        XCTAssertEqual(card.layer?.borderWidth, 2)
    }
}
