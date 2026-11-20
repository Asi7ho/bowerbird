import AppKit
import BowerbirdCore
import ModelIO
import SceneKit

/// A 3D model card, rendered natively with SceneKit. Quick
/// Look was the first attempt — it is what the system uses
/// to preview these files — but it does not render .glb on
/// the user's Mac, so the welcome cube and every dropped
/// model showed an empty card. SceneKit reads no glTF
/// either, so .glb geometry comes from GLTFDocument (core)
/// and is built into a scene here; other formats load
/// natively (Collada, SceneKit, USDZ) or through ModelIO
/// (Wavefront, FBX, STL). A file no loader understands
/// keeps its file tile (title and size), never a blank
/// card. The view renders on demand (no loop at rest)
/// and the user can orbit the model (camera control); the
/// fit button re-frames the camera on the whole model.
public final class Model3DCardView: CardView {
    private let sceneView = SCNView()
    private let titleLayer = CATextLayer()
    private let subtitleLayer = CATextLayer()
    /// The fit button: re-frames the camera on the whole
    /// model (the Electron app's model3d-fit).
    private let fitButton = NSButton()
    /// The file this view is showing, so a reconfigure
    /// for the same card does not reload the model.
    private var currentPath: String?
    /// Whether the model loaded: a file that exists but
    /// will not parse shows its tile with a note, not a
    /// blank preview.
    private var modelLoaded = false
    /// The zoom the fit button's icon was last sized for,
    /// so the symbol is only rebuilt when the zoom moves.
    private var lastFitButtonZoom: CGFloat = 0

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
        // The fit button: the Electron app's model3d-fit
        // (28px, 8px radius, white, hairline border) with
        // the expand-corners icon. It sits on the
        // preview's top-right corner.
        fitButton.isBordered = false
        fitButton.imagePosition = .imageOnly
        fitButton.target = self
        fitButton.action = #selector(fitModel)
        fitButton.toolTip = "Fit model"
        fitButton.wantsLayer = true
        fitButton.layer?.backgroundColor = NSColor(white: 1, alpha: 0.92).cgColor
        fitButton.layer?.borderColor = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.1).cgColor
        fitButton.layer?.borderWidth = 1
        fitButton.layer?.cornerRadius = 8
        fitButton.layer?.shadowColor = NSColor.black.cgColor
        fitButton.layer?.shadowOpacity = 0.08
        fitButton.layer?.shadowRadius = 4
        fitButton.layer?.shadowOffset = CGSize(width: 0, height: -1)
        addSubview(fitButton)
    }

    /// Re-frames the camera on the whole model.
    @objc private func fitModel() {
        Model3DFrame.frame(sceneView)
    }

    /// Loads a 3D scene from a file, by extension. glTF
    /// binary goes through the app's own glTF reader (its
    /// textures are not loaded, base colour only);
    /// Collada, SceneKit and USDZ scenes load natively;
    /// Wavefront, FBX and STL go through ModelIO. A file
    /// no loader understands returns nil, so the card
    /// keeps its tile.
    private static func loadScene(from url: URL) -> SCNScene? {
        switch url.pathExtension.lowercased() {
        case "glb", "gltf":
            guard let data = try? Data(contentsOf: url),
                  let doc = GLTFDocument.parse(data: data) else { return nil }
            return GLTFSceneKit.scene(from: doc)
        case "dae", "scn", "usdz":
            return SCNScene(url: url, options: nil)
        case "obj", "fbx", "stl":
            let asset = MDLAsset(url: url)
            guard asset.count > 0 else { return nil }
            return SCNScene(mdlAsset: asset)
        default:
            return nil
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
            if exists, let scene = Model3DCardView.loadScene(from: URL(fileURLWithPath: model.path)) {
                sceneView.scene = scene
                Model3DFrame.frame(sceneView)
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
        fitButton.isHidden = !modelLoaded
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
            // The fit button sits on the preview's
            // top-right corner, 8px in, 28px square (the
            // Electron app's model3d-fit). The card is
            // y-up, so the preview's top is its maxY.
            let buttonSize: CGFloat = 28 * zoom
            let inset: CGFloat = 8 * zoom
            fitButton.frame = CGRect(
                x: sceneView.frame.maxX - inset - buttonSize,
                y: sceneView.frame.maxY - inset - buttonSize,
                width: buttonSize,
                height: buttonSize
            )
            fitButton.layer?.cornerRadius = 8 * zoom
            if abs(lastFitButtonZoom - zoom) > 0.001 {
                lastFitButtonZoom = zoom
                let config = NSImage.SymbolConfiguration(pointSize: 14 * zoom, weight: .regular)
                fitButton.image = NSImage(systemSymbolName: "arrow.up.left.and.arrow.down.right", accessibilityDescription: "Fit model")?.withSymbolConfiguration(config)
            }
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("Model3DCardView is not Interface Builder backed")
    }
}
