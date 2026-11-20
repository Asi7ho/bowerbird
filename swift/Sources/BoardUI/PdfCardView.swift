import AppKit
import BowerbirdCore
import PDFKit

/// A PDF card, like the Electron app's: the first page
/// rendered on top, the file name and size below it. The
/// page is a real PDFView (PDFKit), so it renders the
/// document instead of a grey tile; a missing file shows
/// the name with "File missing".
public final class PdfCardView: CardView {
    private let pdfView = PDFView()
    private let titleLayer = CATextLayer()
    private let subtitleLayer = CATextLayer()
    /// The file this view is showing, so a reconfigure
    /// for the same card does not reopen the document.
    private var currentPath: String?

    override public init() {
        super.init()
        pdfView.autoScales = true
        pdfView.displayMode = .singlePage
        pdfView.backgroundColor = NSColor.systemGray.withAlphaComponent(0.08)
        pdfView.wantsLayer = true
        pdfView.layer?.masksToBounds = true
        addSubview(pdfView)
        titleLayer.foregroundColor = NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).cgColor
        subtitleLayer.foregroundColor = NSColor(srgbRed: 0.42, green: 0.42, blue: 0.44, alpha: 1).cgColor
        titleLayer.truncationMode = .end
        subtitleLayer.truncationMode = .end
        for textLayer in [titleLayer, subtitleLayer] {
            textLayer.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
            layer?.addSublayer(textLayer)
        }
    }

    override public func configure(item: Item) {
        super.configure(item: item)
        guard case .pdfCard(let pdf) = item.kind else { return }
        titleLayer.string = URL(fileURLWithPath: pdf.path).lastPathComponent
        let kb = Int((Double(pdf.sizeBytes) / 1024).rounded())
        if currentPath != pdf.path {
            currentPath = pdf.path
            pdfView.document = PDFDocument(url: URL(fileURLWithPath: pdf.path))
        }
        let pages = pdfView.document?.pageCount ?? 0
        subtitleLayer.string = pages > 0 ? "\(kb) KB · \(pages) pages" : "\(kb) KB"
        pdfView.isHidden = pdfView.document == nil
        layer?.backgroundColor = NSColor.white.cgColor
        needsLayout = true
    }

    override public func layout() {
        super.layout()
        // Media-card chrome: 12px padding, 10px preview
        // radius, title 14px, subtitle 12px — all in
        // world units, scaled by the zoom. The card is
        // y-up, so the top is at bounds.height: the page
        // sits at the top, the title and subtitle below it.
        guard let item = currentItem, case .pdfCard = item.kind else { return }
        CardView.withoutLayerActions {
            let zoom = item.size.w > 0 ? bounds.width / CGFloat(item.size.w) : 1
            let pad = 12 * zoom
            let width = bounds.width - pad * 2
            titleLayer.font = NSFont.systemFont(ofSize: 14 * zoom, weight: .semibold)
            titleLayer.fontSize = 14 * zoom
            subtitleLayer.font = NSFont.systemFont(ofSize: 12 * zoom)
            subtitleLayer.fontSize = 12 * zoom
            let titleH: CGFloat = 18 * zoom
            let subH: CGFloat = 16 * zoom
            let gap: CGFloat = 4 * zoom
            let textH = titleH + gap + subH
            let mediaH = bounds.height - pad * 2 - textH - gap
            pdfView.frame = CGRect(x: pad, y: bounds.height - pad - mediaH, width: width, height: max(mediaH, 0))
            pdfView.layer?.cornerRadius = 10 * zoom
            titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH, width: width, height: titleH)
            subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH - gap - subH, width: width, height: subH)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PdfCardView is not Interface Builder backed")
    }
}
