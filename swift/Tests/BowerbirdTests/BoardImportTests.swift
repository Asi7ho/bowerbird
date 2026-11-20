import XCTest
@testable import BowerbirdCore

final class BoardImportTests: XCTestCase {
    func testKindForImageExtensions() {
        for ext in ["png", "jpg", "jpeg", "gif", "webp", "bmp", "PNG", "JPG"] {
            XCTAssertEqual(BoardImport.kind(forExtension: ext), .image, ext)
        }
    }

    func testKindForStoredKinds() {
        XCTAssertEqual(BoardImport.kind(forExtension: "pdf"), .pdf)
        XCTAssertEqual(BoardImport.kind(forExtension: "mp3"), .audio)
        XCTAssertEqual(BoardImport.kind(forExtension: "m4a"), .audio)
        XCTAssertEqual(BoardImport.kind(forExtension: "mp4"), .video)
        XCTAssertEqual(BoardImport.kind(forExtension: "mov"), .video)
        XCTAssertEqual(BoardImport.kind(forExtension: "glb"), .model3d)
        XCTAssertEqual(BoardImport.kind(forExtension: "psd"), .fileCard(.psd))
        XCTAssertEqual(BoardImport.kind(forExtension: "ai"), .fileCard(.ai))
        XCTAssertEqual(BoardImport.kind(forExtension: "txt"), .text)
        XCTAssertEqual(BoardImport.kind(forExtension: "md"), .text)
        XCTAssertEqual(BoardImport.kind(forExtension: "url"), .shortcut)
        XCTAssertEqual(BoardImport.kind(forExtension: "webloc"), .shortcut)
    }

    func testKindRefusesSvgAndGltf() {
        // SVG needs the importer (M4); a .gltf references
        // external buffers that would not be embedded.
        XCTAssertNil(BoardImport.kind(forExtension: "svg"))
        XCTAssertNil(BoardImport.kind(forExtension: "gltf"))
        XCTAssertNil(BoardImport.kind(forExtension: "zip"))
        XCTAssertNil(BoardImport.kind(forExtension: ""))
    }

    func testDropSizes() {
        XCTAssertEqual(BoardImport.size(for: .pdf), Size(w: 260, h: 360))
        XCTAssertEqual(BoardImport.size(for: .audio), Size(w: 300, h: 104))
        XCTAssertEqual(BoardImport.size(for: .video), Size(w: 360, h: 264))
        XCTAssertEqual(BoardImport.size(for: .model3d), Size(w: 360, h: 300))
        XCTAssertEqual(BoardImport.urlCardSize, Size(w: 320, h: 132))
        XCTAssertEqual(BoardImport.swatchSize, Size(w: 120, h: 120))
    }

    func testImageSizeCapsAt320Wide() {
        XCTAssertEqual(BoardImport.imageSize(naturalWidth: 640, naturalHeight: 320), Size(w: 320, h: 160))
        XCTAssertEqual(BoardImport.imageSize(naturalWidth: 200, naturalHeight: 100), Size(w: 200, h: 100))
        XCTAssertEqual(BoardImport.imageSize(naturalWidth: 20, naturalHeight: 10), Size(w: 40, h: 40))
        XCTAssertEqual(BoardImport.imageSize(naturalWidth: 0, naturalHeight: 0), Size(w: 320, h: 240))
    }

    func testFileCardSize() {
        XCTAssertEqual(BoardImport.fileCardSize(artWidth: 0, artHeight: 0), Size(w: 360, h: 264))
        // A square artwork: preview 336 tall, plus 70.
        XCTAssertEqual(BoardImport.fileCardSize(artWidth: 400, artHeight: 400), Size(w: 360, h: 406))
        // A very wide artwork: the preview clamps to 80.
        XCTAssertEqual(BoardImport.fileCardSize(artWidth: 1000, artHeight: 100), Size(w: 360, h: 150))
        // A very tall artwork: the preview clamps to 360.
        XCTAssertEqual(BoardImport.fileCardSize(artWidth: 100, artHeight: 1000), Size(w: 360, h: 430))
    }

    func testNormaliseHex() {
        XCTAssertEqual(BoardImport.normaliseHex("#e63946"), "#E63946")
        XCTAssertEqual(BoardImport.normaliseHex("  #abc  "), "#AABBCC")
        XCTAssertEqual(BoardImport.normaliseHex("2A9D8F"), "#2A9D8F")
        XCTAssertNil(BoardImport.normaliseHex("hello"))
        XCTAssertNil(BoardImport.normaliseHex("#12345"))
        XCTAssertNil(BoardImport.normaliseHex("#gggggg"))
    }

    func testIsPdfCompatible() {
        XCTAssertTrue(BoardImport.isPdfCompatible(Data([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])))
        XCTAssertFalse(BoardImport.isPdfCompatible(Data([0x25, 0x21, 0x50, 0x53])))
        XCTAssertFalse(BoardImport.isPdfCompatible(Data()))
    }

    func testShortcutURLPrefersTheURLLine() {
        let content = "[InternetShortcut]\nURL=https://example.com/page\n"
        XCTAssertEqual(BoardImport.shortcutURL(in: content), "https://example.com/page")
    }

    func testShortcutURLFindsALinkInAWebloc() {
        let content = "<?xml version=\"1.0\"?><plist><dict><key>URL</key><string>https://example.com/x</string></dict></plist>"
        XCTAssertEqual(BoardImport.shortcutURL(in: content), "https://example.com/x")
    }

    func testShortcutURLReturnsNilWithoutALink() {
        XCTAssertNil(BoardImport.shortcutURL(in: "no link here"))
    }

    func testIsVideoURL() {
        XCTAssertTrue(BoardImport.isVideoURL("https://www.youtube.com/watch?v=abc"))
        XCTAssertTrue(BoardImport.isVideoURL("https://youtu.be/abc"))
        XCTAssertTrue(BoardImport.isVideoURL("https://vimeo.com/123"))
        XCTAssertTrue(BoardImport.isVideoURL("https://example.com/clip.mp4"))
        XCTAssertFalse(BoardImport.isVideoURL("https://example.com/page"))
        XCTAssertFalse(BoardImport.isVideoURL("https://example.com/image.png"))
    }

    func testPosterName() {
        XCTAssertEqual(BoardImport.posterName(for: "/a/b/clip.mp4"), "clip-poster.jpg")
        XCTAssertEqual(BoardImport.posterName(for: "/a/b/my.clip.mov"), "my.clip-poster.jpg")
    }

    func testUniqueNameDedups() {
        XCTAssertEqual(BoardImport.uniqueName("photo.png", existing: []), "photo.png")
        XCTAssertEqual(BoardImport.uniqueName("photo.png", existing: ["photo.png"]), "photo-1.png")
        XCTAssertEqual(BoardImport.uniqueName("photo.png", existing: ["photo.png", "photo-1.png"]), "photo-2.png")
        XCTAssertEqual(BoardImport.uniqueName("my file.png", existing: []), "my_file.png")
    }

    func testAddTakesTheNextId() {
        var board = Board(items: [], camera: Camera(x: 0, y: 0, zoom: 1), nextId: 0, nextGroup: 1, groups: nil, bg: "#FFFFFF", grid: .dots)
        let item = BoardImport.add(&board, kind: .swatch(SwatchPayload(hex: "#E63946")), size: Size(w: 120, h: 120), at: Pt(x: 10, y: 20))
        XCTAssertEqual(item.id, 1)
        XCTAssertEqual(board.nextId, 1)
        XCTAssertEqual(board.items.count, 1)
        XCTAssertEqual(board.items[0].pos, Pt(x: 10, y: 20))
    }
}
