import AppKit
import AVFoundation
import BowerbirdCore
import QuickLookThumbnailing

/// Files dropped onto the board, mirroring the Electron
/// app's drops.ts: each file is embedded as a board-owned
/// copy in the board's assets (deleting the original
/// cannot break the card), then lands as a card at the
/// drop point, cascading 24 world pixels per file. One
/// undo step and one save for the whole drop. A .psd or
/// .ai keeps its source file linked (its group records
/// it, so a later live-sync can re-import it), with its
/// artwork rendered once to a preview; a video's poster
/// fills in afterwards as background work, without an
/// undo step. A card whose preview or poster could not
/// be made keeps its format tile (PSD/AI) or dark tile
/// (video). Files the app cannot import (an .svg — the
/// importer is not ported yet — a .gltf, an .ai saved
/// without PDF compatibility, a file over 50 MB) are
/// skipped.
public enum BoardDrop {
    /// What a dropped file becomes, once its bytes are
    /// embedded: the card, the group link for it, and the
    /// background fill to run once the card exists.
    private struct Landed {
        var kind: Kind
        var size: Size
        var link: (label: String, source: ImportSource)?
        var fill: Fill?
    }

    /// Background work for a landed card: a video's
    /// poster frame and duration.
    private enum Fill {
        case videoPoster(source: String)
    }

    /// Imports the files, landing their cards at `world`
    /// on the store's board.
    public static func importFiles(_ urls: [URL], at world: Pt, store: BoardStore) {
        Task {
            let prepared = await prepare(urls: urls, boardDir: store.boardDir)
            guard !prepared.isEmpty else { return }
            let fills = await MainActor.run { () -> [(id: Int, fill: Fill)] in
                var fills: [(id: Int, fill: Fill)] = []
                store.update { board in
                    var at = world
                    for landed in prepared {
                        var group: Int? = nil
                        if let link = landed.link {
                            // next_group is the last
                            // allocated group, like next_id
                            // — a fresh one comes from
                            // bumping first.
                            board.nextGroup += 1
                            group = board.nextGroup
                            board.groups = board.groups ?? [:]
                            if let group {
                                board.groups?[group] = GroupEntry(label: link.label, source: link.source)
                            }
                        }
                        let item = BoardImport.add(&board, kind: landed.kind, size: landed.size, at: at, group: group)
                        if let fill = landed.fill {
                            fills.append((item.id, fill))
                        }
                        at = Pt(x: at.x + 24, y: at.y + 24)
                    }
                }
                store.save()
                return fills
            }
            for (id, fill) in fills {
                await runFill(fill, itemId: id, store: store)
            }
        }
    }

    /// Embeds each file and works out what it lands as.
    /// Runs before the commit, so a slow thumbnail never
    /// holds the board's undo step open.
    private static func prepare(urls: [URL], boardDir: URL) async -> [Landed] {
        let fm = FileManager.default
        let assets = boardDir.appendingPathComponent("assets")
        try? fm.createDirectory(at: assets, withIntermediateDirectories: true)
        var existing = Set((try? fm.contentsOfDirectory(atPath: assets.path)) ?? [])
        var landed: [Landed] = []
        for url in urls {
            guard let kind = BoardImport.kind(forExtension: url.pathExtension) else { continue }
            guard let attributes = try? fm.attributesOfItem(atPath: url.path),
                  let fileSize = attributes[.size] as? NSNumber,
                  fileSize.intValue <= BoardImport.maxEmbedBytes else { continue }
            let size = fileSize.intValue
            let mtimeMs = (attributes[.modificationDate] as? Date).map { $0.timeIntervalSince1970 * 1000 }
            let name = BoardImport.uniqueName(url.lastPathComponent, existing: existing)
            existing.insert(name)
            let stored = assets.appendingPathComponent(name)
            // The copy is the embed: the card points at
            // the board's copy, never at the original.
            guard (try? fm.copyItem(at: url, to: stored)) != nil else { continue }
            let storedPath = stored.path
            switch kind {
            case .image:
                let natural = NSImage(contentsOf: url)?.size
                let cardSize = BoardImport.imageSize(
                    naturalWidth: Double(natural?.width ?? 0),
                    naturalHeight: Double(natural?.height ?? 0)
                )
                landed.append(Landed(kind: .image(ImagePayload(path: storedPath)), size: cardSize, link: nil, fill: nil))
            case .pdf:
                landed.append(Landed(
                    kind: .pdfCard(PdfCardPayload(path: storedPath, sizeBytes: size)),
                    size: BoardImport.size(for: .pdf), link: nil, fill: nil
                ))
            case .audio:
                landed.append(Landed(
                    kind: .audio(AudioPayload(path: storedPath, title: nil, transcript: nil)),
                    size: BoardImport.size(for: .audio), link: nil, fill: nil
                ))
            case .video:
                landed.append(Landed(
                    kind: .video(VideoPayload(source: storedPath, remote: false, sizeBytes: size, poster: nil, duration: nil)),
                    size: BoardImport.size(for: .video), link: nil, fill: .videoPoster(source: storedPath)
                ))
            case .model3d:
                landed.append(Landed(
                    kind: .model3D(Model3DPayload(path: storedPath, sizeBytes: size)),
                    size: BoardImport.size(for: .model3d), link: nil, fill: nil
                ))
            case .fileCard(let format):
                if format == .ai {
                    // An .ai saved without PDF compatibility
                    // is PostScript, which the app cannot
                    // read: the file is not kept as a card.
                    let header = try? Data(contentsOf: url, options: [.alwaysMapped]).prefix(5)
                    guard let header, BoardImport.isPdfCompatible(Data(header)) else {
                        try? fm.removeItem(at: stored)
                        continue
                    }
                }
                let stem = (name as NSString).deletingPathExtension
                let previewName = BoardImport.uniqueName("\(stem)-preview.png", existing: existing)
                existing.insert(previewName)
                let previewURL = assets.appendingPathComponent(previewName)
                let preview = await thumbnailPNG(for: url, maxSize: 672)
                var previewPath: String? = nil
                var artW = 0.0, artH = 0.0
                if let preview, (try? preview.data.write(to: previewURL)) != nil {
                    previewPath = previewURL.path
                    artW = preview.width
                    artH = preview.height
                }
                let source = ImportSource(path: storedPath, kind: format == .psd ? .psd : .ai, size: size, mtimeMs: mtimeMs)
                landed.append(Landed(
                    kind: .fileCard(FileCardPayload(path: storedPath, sizeBytes: size, format: format, preview: previewPath)),
                    size: BoardImport.fileCardSize(artWidth: artW, artHeight: artH),
                    link: (label: url.lastPathComponent, source: source),
                    fill: nil
                ))
            case .text:
                let data = (try? Data(contentsOf: url)) ?? Data()
                let content = String(decoding: data, as: UTF8.self)
                let sliced = String(content.prefix(2000))
                if let hex = BoardImport.normaliseHex(sliced.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    landed.append(Landed(
                        kind: .swatch(SwatchPayload(hex: hex)),
                        size: BoardImport.swatchSize, link: nil, fill: nil
                    ))
                } else {
                    let height = TextMeasure.noteHeight(text: sliced, fontSize: 16, width: BoardImport.textWidth)
                    landed.append(Landed(
                        kind: .text(TextPayload(text: sliced, bold: false, size: 16, color: "#1A1A1A", bg: nil)),
                        size: Size(w: BoardImport.textWidth, h: height), link: nil, fill: nil
                    ))
                }
            case .shortcut:
                let data = (try? Data(contentsOf: url)) ?? Data()
                let content = String(decoding: data, as: UTF8.self)
                guard let link = BoardImport.shortcutURL(in: content) else { continue }
                if BoardImport.isVideoURL(link) {
                    landed.append(Landed(
                        kind: .video(VideoPayload(source: link, remote: true, sizeBytes: 0, poster: nil, duration: nil)),
                        size: BoardImport.size(for: .video), link: nil, fill: nil
                    ))
                } else {
                    landed.append(Landed(
                        kind: .urlCard(UrlCardPayload(url: link, title: nil, description: nil, image: nil, icon: nil, embed: nil)),
                        size: BoardImport.urlCardSize, link: nil, fill: nil
                    ))
                }
            }
        }
        return landed
    }

    /// A file's thumbnail as PNG bytes, with its pixel
    /// size (Quick Look renders PSD and AI artwork, like
    /// Finder does). Nil when Quick Look cannot render it
    /// — the card then keeps its format tile.
    private static func thumbnailPNG(for file: URL, maxSize: CGFloat) async -> (data: Data, width: Double, height: Double)? {
        await withCheckedContinuation { continuation in
            let request = QLThumbnailGenerator.Request(
                fileAt: file,
                size: CGSize(width: maxSize, height: maxSize),
                scale: 1,
                representationTypes: .thumbnail
            )
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, _ in
                guard let cgImage = representation?.cgImage else {
                    continuation.resume(returning: nil)
                    return
                }
                let bitmap = NSBitmapImageRep(cgImage: cgImage)
                guard let data = bitmap.representation(using: .png, properties: [:]) else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: (data, Double(cgImage.width), Double(cgImage.height)))
            }
        }
    }

    /// A video's poster: one frame a quarter of the way
    /// in (at most 1 second in — the Electron app's
    /// poster time), saved as a JPEG next to the video,
    /// with the duration filled into the card. Background
    /// work, not a user change: it saves without an undo
    /// step, and only when the card still names this
    /// source (the card may have been deleted or the
    /// board switched while the frame was captured).
    private static func runFill(_ fill: Fill, itemId: Int, store: BoardStore) async {
        switch fill {
        case .videoPoster(let source):
            let asset = AVURLAsset(url: URL(fileURLWithPath: source))
            guard let duration = try? await asset.load(.duration) else { return }
            let seconds = CMTimeGetSeconds(duration)
            guard seconds.isFinite, seconds > 0 else { return }
            let posterTime = min(1, seconds * 0.25)
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 640, height: 640)
            guard let cgImage = try? generator.copyCGImage(
                at: CMTime(seconds: posterTime, preferredTimescale: 600),
                actualTime: nil
            ) else { return }
            let bitmap = NSBitmapImageRep(cgImage: cgImage)
            guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { return }
            let posterURL = store.boardDir
                .appendingPathComponent("assets")
                .appendingPathComponent(BoardImport.posterName(for: source))
            guard (try? data.write(to: posterURL)) != nil else { return }
            let posterPath = posterURL.path
            await MainActor.run {
                store.updateWithoutUndo { board in
                    guard let index = board.items.firstIndex(where: { $0.id == itemId }),
                          case .video(var payload) = board.items[index].kind,
                          payload.source == source else { return }
                    payload.poster = posterPath
                    payload.duration = seconds
                    board.items[index].kind = .video(payload)
                }
                store.save()
            }
        }
    }
}
