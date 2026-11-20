import AppKit
import BowerbirdCore
import QuickLookUI

/// A 3D model card, shown through the system's Quick
/// Look preview. Apple has no native glTF (.glb/.gltf)
/// loader — neither RealityKit nor ModelIO reads it — so
/// a third-party loader would be the only other route,
/// and Quick Look is what the system itself uses to
/// preview these files (Finder, Mail). If Quick Look
/// does not render the welcome cube on the user's Mac,
/// that is the decision to make: a third-party GLTF
/// loader, or keep Quick Look. A missing file shows its
/// name with "File missing".
public final class Model3DCardView: CardView {
    /// Quick Look's preview view. The styled initializer
    /// is failable — it returns nil when Quick Look cannot
    /// start, which does not happen on a Mac — so the one
    /// unwrap is here, at creation, and the property is a
    /// plain view everywhere else.
    private let previewView = QLPreviewView(frame: .zero, style: .normal)!
    private let titleLayer = CATextLayer()
    private let subtitleLayer = CATextLayer()
    /// The file this view is showing, so a reconfigure
    /// for the same card does not reload the preview.
    private var currentPath: String?

    override public init() {
        super.init()
        previewView.wantsLayer = true
        previewView.layer?.masksToBounds = true
        addSubview(previewView)
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
        guard case .model3D(let model) = item.kind else { return }
        titleLayer.string = URL(fileURLWithPath: model.path).lastPathComponent
        let kb = Int((Double(model.sizeBytes) / 1024).rounded())
        let exists = FileManager.default.fileExists(atPath: model.path)
        subtitleLayer.string = exists ? "\(kb) KB" : "File missing"
        if model.path != currentPath {
            currentPath = model.path
            previewView.previewItem = exists ? URL(fileURLWithPath: model.path) as QLPreviewItem : nil
        }
        previewView.isHidden = !exists
        layer?.backgroundColor = NSColor.white.cgColor
        needsLayout = true
    }

    override public func layout() {
        super.layout()
        // Media-card chrome: 12px padding, 10px preview
        // radius, title 14px, subtitle 12px — all in
        // world units, scaled by the zoom. The card is
        // y-up, so the top is at bounds.height: the
        // preview sits at the top, the title and subtitle
        // below it.
        guard let item = currentItem, case .model3D = item.kind else { return }
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
            previewView.frame = CGRect(x: pad, y: bounds.height - pad - mediaH, width: width, height: max(mediaH, 0))
            previewView.layer?.cornerRadius = 10 * zoom
            titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH, width: width, height: titleH)
            subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH - gap - subH, width: width, height: subH)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("Model3DCardView is not Interface Builder backed")
    }
}
