import AppKit
import SceneKit
import simd

/// Frames a 3D card's camera on its model — the Electron
/// app's fit (distance = radius × 2.4, slightly above,
/// straight on). Shared by the first load and the fit
/// button, and by every format, so a fitted model looks
/// like a fresh one whatever was dropped.
public enum Model3DFrame {
    /// The model's bounding sphere (centre and radius) in
    /// world space, from the scene's geometry. The world
    /// transform is threaded through the walk (not read
    /// off the nodes, which SceneKit only fills in once
    /// the scene has rendered). No geometry, no sphere.
    public static func boundingSphere(of scene: SCNScene) -> (center: SIMD3<Float>, radius: Float)? {
        var minPoint = SIMD3<Float>(Float.greatestFiniteMagnitude, Float.greatestFiniteMagnitude, Float.greatestFiniteMagnitude)
        var maxPoint = SIMD3<Float>(-Float.greatestFiniteMagnitude, -Float.greatestFiniteMagnitude, -Float.greatestFiniteMagnitude)
        var found = false
        func walk(_ node: SCNNode, parent: simd_float4x4) {
            let world = parent * simdMatrix(node.transform)
            if let geometry = node.geometry {
                let (localMin, localMax) = geometry.boundingBox
                let corners = [
                    SIMD3<Float>(Float(localMin.x), Float(localMin.y), Float(localMin.z)),
                    SIMD3<Float>(Float(localMax.x), Float(localMin.y), Float(localMin.z)),
                    SIMD3<Float>(Float(localMin.x), Float(localMax.y), Float(localMin.z)),
                    SIMD3<Float>(Float(localMax.x), Float(localMax.y), Float(localMin.z)),
                    SIMD3<Float>(Float(localMin.x), Float(localMin.y), Float(localMin.z)),
                    SIMD3<Float>(Float(localMax.x), Float(localMin.y), Float(localMin.z)),
                    SIMD3<Float>(Float(localMin.x), Float(localMax.y), Float(localMax.z)),
                    SIMD3<Float>(Float(localMax.x), Float(localMax.y), Float(localMax.z)),
                ]
                for corner in corners {
                    let p = world * SIMD4<Float>(corner, 1)
                    minPoint = SIMD3<Float>(min(minPoint.x, p.x), min(minPoint.y, p.y), min(minPoint.z, p.z))
                    maxPoint = SIMD3<Float>(max(maxPoint.x, p.x), max(maxPoint.y, p.y), max(maxPoint.z, p.z))
                }
                found = true
            }
            for child in node.childNodes { walk(child, parent: world) }
        }
        walk(scene.rootNode, parent: matrix_identity_float4x4)
        guard found else { return nil }
        let center = (minPoint + maxPoint) / 2
        let radius = simd_length(maxPoint - minPoint) / 2
        guard radius > 0 else { return nil }
        return (center, radius)
    }

    /// A camera node positioned to frame the model:
    /// straight on, slightly above (elevation 0.35), at
    /// radius × 2.4.
    public static func makeFramedCamera(center: SIMD3<Float>, radius: Float) -> SCNNode {
        let distance = radius * 2.4
        let direction = SIMD3<Float>(0, sin(0.35), cos(0.35))
        let cameraNode = SCNNode()
        let camera = SCNCamera()
        camera.zNear = Double(distance) / 100
        camera.zFar = Double(distance) * 100
        cameraNode.camera = camera
        cameraNode.position = SCNVector3(
            CGFloat(center.x + direction.x * Float(distance)),
            CGFloat(center.y + direction.y * Float(distance)),
            CGFloat(center.z + direction.z * Float(distance))
        )
        cameraNode.look(at: SCNVector3(CGFloat(center.x), CGFloat(center.y), CGFloat(center.z)))
        return cameraNode
    }

    /// Positions the view's camera on the model's bounding
    /// sphere. Uses the view's camera node when it has
    /// one, and creates one when it does not (a freshly
    /// loaded non-glTF scene has none).
    public static func frame(_ sceneView: SCNView) {
        guard let scene = sceneView.scene,
              let (center, radius) = boundingSphere(of: scene) else { return }
        let cameraNode: SCNNode
        if let existing = sceneView.pointOfView, existing.camera != nil {
            cameraNode = existing
        } else if let existing = scene.rootNode.childNodes.first(where: { $0.camera != nil }) {
            cameraNode = existing
        } else {
            cameraNode = makeFramedCamera(center: center, radius: radius)
            scene.rootNode.addChildNode(cameraNode)
            sceneView.pointOfView = cameraNode
            return
        }
        let framed = makeFramedCamera(center: center, radius: radius)
        if let camera = cameraNode.camera, let framedCamera = framed.camera {
            camera.zNear = framedCamera.zNear
            camera.zFar = framedCamera.zFar
        }
        cameraNode.position = framed.position
        cameraNode.orientation = framed.orientation
        sceneView.pointOfView = cameraNode
    }

    /// A SceneKit matrix as a simd matrix: SCNMatrix4's
    /// members are rows, simd's columns are columns, so
    /// the two transpose.
    private static func simdMatrix(_ m: SCNMatrix4) -> simd_float4x4 {
        simd_float4x4(
            SIMD4<Float>(Float(m.m11), Float(m.m21), Float(m.m31), Float(m.m41)),
            SIMD4<Float>(Float(m.m12), Float(m.m22), Float(m.m32), Float(m.m42)),
            SIMD4<Float>(Float(m.m13), Float(m.m23), Float(m.m33), Float(m.m43)),
            SIMD4<Float>(Float(m.m14), Float(m.m24), Float(m.m34), Float(m.m44))
        )
    }
}
