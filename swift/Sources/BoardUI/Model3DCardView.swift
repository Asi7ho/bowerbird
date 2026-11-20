import AppKit
import BowerbirdCore
import SceneKit

/// A 3D model card, rendered natively with SceneKit from
/// the app's own glTF reader. Quick Look was the first
/// attempt — it is what the system uses to preview these
/// files — but it does not render .glb on the user's Mac,
/// so the welcome cube and every dropped model showed an
/// empty card. SceneKit reads no glTF either, so the
/// geometry comes from GLTFDocument (core) and is built
/// into a scene here. A file the reader cannot parse
/// keeps its file tile (title and size), never a blank
/// card. The view renders on demand (no loop at rest)
/// and the user can orbit the model (camera control).
public final class Model3DCardView: CardView {
    private let sceneView = SCNView()
    private let titleLayer = CATextLayer()
    private let subtitleLayer = CATextLayer()
    /// The file this view is showing, so a reconfigure
    /// for the same card does not reload the model.
    private var currentPath: String?
    /// Whether the model loaded: a file that exists but
    /// will not parse shows its tile with a note, not a
    /// blank preview.
    private var modelLoaded = false

    override public init() {
        super.init()
        sceneView.wantsLayer = true
        sceneView.layer?.masksToBounds = true
        sceneView.allowsCameraControl = true
        sceneView.autoenablesDefaultLighting = true
        sceneView.rendersContinuously = false
        sceneView.backgroundColor = .white
        addSubview(sceneView)
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
        if model.path != currentPath {
            currentPath = model.path
            modelLoaded = false
            sceneView.scene = nil
            sceneView.pointOfView = nil
            if exists,
               let data = try? Data(contentsOf: URL(fileURLWithPath: model.path)),
               let doc = GLTFDocument.parse(data: data) {
                let scene = GLTFSceneKit.scene(from: doc)
                sceneView.scene = scene
                sceneView.pointOfView = scene.rootNode.childNodes.first(where: { $0.camera != nil })
                modelLoaded = true
            }
        }
        if !exists {
            subtitleLayer.string = "File missing"
        } else if !modelLoaded {
            subtitleLayer.string = "\(kb) KB · Could not load"
        } else {
            subtitleLayer.string = "\(kb) KB"
        }
        sceneView.isHidden = !exists || !modelLoaded
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
            sceneView.frame = CGRect(x: pad, y: bounds.height - pad - mediaH, width: width, height: max(mediaH, 0))
            sceneView.layer?.cornerRadius = 10 * zoom
            titleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH, width: width, height: titleH)
            subtitleLayer.frame = CGRect(x: pad, y: bounds.height - pad - mediaH - gap - titleH - gap - subH, width: width, height: subH)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("Model3DCardView is not Interface Builder backed")
    }
}
