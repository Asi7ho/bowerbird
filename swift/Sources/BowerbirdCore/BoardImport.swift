import Foundation

/// What a file dropped onto the board becomes, mirroring
/// the Electron app's `dropKindForExt` and drop sizes in
/// `drops.ts`. Pure: no file access here — the importer in
/// BoardUI reads the files and calls these rules.
///
/// SVG is not here: the SVG importer is not ported yet
/// (M4), so a dropped .svg is left alone rather than
/// landing as a broken card. A .gltf is refused for the
/// Electron app's reason too: it references external
/// buffers and textures that would not be embedded with
/// it.
public enum BoardImport {
    /// What a dropped file lands as.
    public enum DropKind: Equatable {
        case image
        case pdf
        case audio
        case video
        case model3d
        case fileCard(FileFormat)
        case text
        case shortcut
    }

    /// The kind for a file extension (lowercased, without
    /// the dot), or nil when the app does not import it.
    public static func kind(forExtension ext: String) -> DropKind? {
        switch ext.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "bmp": return .image
        case "psd": return .fileCard(.psd)
        case "ai": return .fileCard(.ai)
        case "pdf": return .pdf
        case "mp3", "wav", "flac", "ogg", "m4a": return .audio
        case "mp4", "mov", "webm", "mkv", "avi", "m4v": return .video
        case "glb": return .model3d
        case "txt", "md": return .text
        case "url", "webloc": return .shortcut
        default: return nil
        }
    }

    /// Whether this URL is a file the app imports (for
    /// the drop cursor: a drag with no importable file
    /// offers no drop).
    public static func supports(url: URL) -> Bool {
        kind(forExtension: url.pathExtension) != nil
    }

    /// The card size for a stored kind. Images are sized
    /// by their natural size (see `imageSize`), text by
    /// its measured height (see the importer), FileCards
    /// by their artwork (see `fileCardSize`).
    public static func size(for kind: DropKind) -> Size {
        switch kind {
        case .pdf: return Size(w: 260, h: 360)
        case .audio: return Size(w: 300, h: 104)
        case .video: return Size(w: 360, h: 264)
        case .model3d: return Size(w: 360, h: 300)
        case .text, .image, .fileCard, .shortcut: return Size(w: 320, h: 240)
        }
    }

    /// A link card's size: a plain link is 320×132; a
    /// video link is the video size.
    public static let urlCardSize = Size(w: 320, h: 132)

    /// A text note's width, and a swatch's size, when
    /// dropped text lands as one or the other.
    public static let textWidth: Double = 260
    public static let swatchSize = Size(w: 120, h: 120)

    /// An image card's size from its natural size: capped
    /// at 320 wide, at least 40 on each side, falling back
    /// to 320×240 when the size is unknown.
    public static func imageSize(naturalWidth: Double, naturalHeight: Double) -> Size {
        let nw = naturalWidth > 0 ? naturalWidth : 320
        let nh = naturalHeight > 0 ? naturalHeight : 240
        let scale = nw > 320 ? 320 / nw : 1
        return Size(w: max(40, nw * scale), h: max(40, nh * scale))
    }

    /// A FileCard's size from its artwork's size: the
    /// preview is 336 wide, clamped to 80…360 tall, plus
    /// 70 for the name and size below it; no artwork (or
    /// a zero size) falls back to 360×264.
    public static func fileCardSize(artWidth: Double, artHeight: Double) -> Size {
        guard artWidth > 0, artHeight > 0 else { return Size(w: 360, h: 264) }
        let previewH = min(360, max(80, (artHeight / artWidth) * 336))
        return Size(w: 360, h: (previewH + 70).rounded())
    }

    /// A hex colour from dropped text, or nil: the text
    /// trimmed, a leading # stripped, 3 digits expanded
    /// to 6, and the result uppercased as #RRGGBB.
    public static func normaliseHex(_ text: String) -> String? {
        var hex = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex.removeFirst() }
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6, hex.allSatisfy({ $0.isHexDigit }) else {
            return nil
        }
        return "#" + hex.uppercased()
    }

    /// Whether a file's first bytes are a PDF header
    /// ("%PDF-"): an .ai saved without PDF compatibility
    /// is PostScript, which the app cannot read, so it is
    /// refused rather than landing as a broken card.
    public static func isPdfCompatible(_ bytes: Data) -> Bool {
        bytes.count >= 5
            && bytes[0] == 0x25 // %
            && bytes[1] == 0x50 // P
            && bytes[2] == 0x44 // D
            && bytes[3] == 0x46 // F
            && bytes[4] == 0x2d // -
    }

    /// The URL inside a .url/.webloc shortcut file: a
    /// URL= line first, else the first http(s) link in
    /// the text, cut at the first space, quote or angle
    /// bracket.
    public static func shortcutURL(in content: String) -> String? {
        for line in content.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("URL=") {
                let url = trimmed.dropFirst("URL=".count).trimmingCharacters(in: .whitespaces)
                if url.hasPrefix("http://") || url.hasPrefix("https://") { return String(url) }
            }
        }
        for needle in ["https://", "http://"] {
            guard let range = content.range(of: needle) else { continue }
            let rest = content[range.lowerBound...]
            let end = rest.firstIndex(where: { $0.isWhitespace || $0 == "<" || $0 == "\"" || $0 == "'" }) ?? rest.endIndex
            let url = String(rest[..<end])
            if url.count > needle.count + 1 { return url }
        }
        return nil
    }

    /// Whether a URL should land as a video card: a
    /// YouTube or Vimeo link, or a direct video file.
    public static func isVideoURL(_ url: String) -> Bool {
        let lower = url.lowercased()
        if let host = URL(string: lower)?.host?.replacingOccurrences(of: "www.", with: "", options: .anchored) {
            if ["youtube.com", "youtu.be", "vimeo.com"].contains(host)
                || host.hasSuffix(".youtube.com") || host.hasSuffix(".youtu.be") || host.hasSuffix(".vimeo.com") {
                return true
            }
        }
        let path = lower.split(separator: "?")[0].split(separator: "#")[0]
        return ["mp4", "mov", "webm", "mkv", "avi", "m4v"].contains(where: { path.hasSuffix(".\($0)") })
    }

    /// The poster file name for a video source: the
    /// video's own name with -poster.jpg.
    public static func posterName(for sourcePath: String) -> String {
        let base = sourcePath.split(separator: "/").last.map(String.init) ?? "video"
        let stem = base.split(separator: ".").dropLast().joined(separator: ".")
        return "\(stem.isEmpty ? "video" : stem)-poster.jpg"
    }

    /// An unused file name in the assets folder: the name
    /// sanitised, with -1, -2… before the extension while
    /// a file of that name exists — the Electron app's
    /// embed-file-bytes rule.
    public static func uniqueName(_ name: String, existing: Set<String>) -> String {
        let clean = BoardPaths.sanitise((name as NSString).lastPathComponent)
        guard existing.contains(clean) else { return clean }
        let ext = (clean as NSString).pathExtension
        let stem = (clean as NSString).deletingPathExtension
        var n = 1
        while true {
            let candidate = ext.isEmpty ? "\(stem)-\(n)" : "\(stem)-\(n).\(ext)"
            if !existing.contains(candidate) { return candidate }
            n += 1
        }
    }

    /// The cap on an embedded file: the Electron app's
    /// 50 MB, so an unbounded file cannot fill the disk.
    public static let maxEmbedBytes = 50 * 1024 * 1024

    /// Adds one item to the board at a position, taking
    /// the next id, and returns it.
    @discardableResult
    public static func add(
        _ board: inout Board,
        kind: Kind,
        size: Size,
        at point: Pt,
        group: Int? = nil
    ) -> Item {
        // next_id is the last allocated id — a fresh id
        // comes from allocId (see BoardStroke.add).
        let id = allocId(&board)
        let item = Item(id: id, pos: point, size: size, group: group, kind: kind, rotation: nil)
        board.items.append(item)
        return item
    }
}
