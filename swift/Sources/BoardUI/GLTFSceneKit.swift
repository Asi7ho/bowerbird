import AppKit
import BowerbirdCore
import SceneKit
import simd

/// Turns a parsed glTF document into a SceneKit scene:
/// one node per glTF node (its transform carried over),
/// geometry per primitive, materials from the base colour
/// (metallic and roughness as the format's physically
/// based values). The camera is framed on the model's
/// bounding box — the Electron app's 3D fit (distance =
/// radius × 2.4, slightly above, straight on) — so the
/// model fills the card on first sight; the user can orbit
/// from there (the card's view has camera control).
public enum GLTFSceneKit {
    public static func scene(from doc: GLTFDocument) -> SCNScene {
        let scene = SCNScene()
        var scnNodes: [SCNNode] = []
        for node in doc.nodes {
            let scn = SCNNode()
            scn.transform = scnMatrix(node.transform)
            if let meshIndex = node.mesh {
                for primitive in doc.meshes[meshIndex].primitives {
                    scn.addChildNode(SCNNode(geometry: geometry(from: primitive, materials: doc.materials)))
                }
            }
            scnNodes.append(scn)
        }
        for (index, node) in doc.nodes.enumerated() {
            for child in node.children where child >= 0 && child < scnNodes.count {
                scnNodes[index].addChildNode(scnNodes[child])
            }
        }
        for root in doc.roots where root >= 0 && root < scnNodes.count {
            scene.rootNode.addChildNode(scnNodes[root])
        }
        frameCamera(scene)
        return scene
    }

    /// One triangle primitive as SceneKit geometry:
    /// vertices, normals and texture coordinates as
    /// sources, indices (or the vertices in order when
    /// there are none) as the element, the material from
    /// the primitive's index or the default white.
    private static func geometry(from primitive: GLTFDocument.Primitive, materials: [GLTFDocument.Material]) -> SCNGeometry {
        var sources: [SCNGeometrySource] = [
            SCNGeometrySource(vertices: primitive.positions.map { SCNVector3(x: CGFloat($0.x), y: CGFloat($0.y), z: CGFloat($0.z)) })
        ]
        if let normals = primitive.normals {
            sources.append(SCNGeometrySource(normals: normals.map { SCNVector3(x: CGFloat($0.x), y: CGFloat($0.y), z: CGFloat($0.z)) }))
        }
        if let texcoords = primitive.texcoords {
            sources.append(SCNGeometrySource(textureCoordinates: texcoords.map { CGPoint(x: CGFloat($0.x), y: CGFloat($0.y)) }))
        }
        let element: SCNGeometryElement
        if primitive.indices.isEmpty {
            // No index data: the vertices draw in order.
            element = SCNGeometryElement(data: nil, primitiveType: .triangles, primitiveCount: primitive.positions.count / 3, bytesPerIndex: 4)
        } else {
            var indexData = Data()
            indexData.reserveCapacity(primitive.indices.count * 4)
            for index in primitive.indices {
                var value = index
                indexData.append(Data(bytes: &value, count: 4))
            }
            element = SCNGeometryElement(data: indexData, primitiveType: .triangles, primitiveCount: primitive.indices.count / 3, bytesPerIndex: 4)
        }
        let geometry = SCNGeometry(sources: sources, elements: [element])
        let material = primitive.material.flatMap { $0 >= 0 && $0 < materials.count ? materials[$0] : nil }
        geometry.materials = [scnMaterial(material)]
        return geometry
    }

    private static func scnMaterial(_ material: GLTFDocument.Material?) -> SCNMaterial {
        let scn = SCNMaterial()
        scn.lightingModel = .physicallyBased
        let color = material?.baseColor ?? SIMD4<Float>(1, 1, 1, 1)
        scn.diffuse.contents = NSColor(
            srgbRed: CGFloat(color.x), green: CGFloat(color.y), blue: CGFloat(color.z), alpha: CGFloat(color.w)
        )
        scn.metalness.contents = NSNumber(value: material?.metallic ?? 1)
        scn.roughness.contents = NSNumber(value: material?.roughness ?? 1)
        scn.isDoubleSided = material?.doubleSided ?? false
        return scn
    }

    /// Frames the camera on the model's bounding box —
    /// the shared fit (see Model3DFrame), so the model
    /// fills the card on first sight; the user can orbit
    /// from there (the card's view has camera control).
    private static func frameCamera(_ scene: SCNScene) {
        guard let (center, radius) = Model3DFrame.boundingSphere(of: scene) else { return }
        scene.rootNode.addChildNode(Model3DFrame.makeFramedCamera(center: center, radius: radius))
    }

    /// A simd matrix as a SceneKit matrix: SCNMatrix4's
    /// members are rows (m11..m14 is the first row),
    /// simd's columns are columns, so the two transpose.
    /// (SCNMatrix4's members are CGFloat, simd's are
    /// Float, so the values convert here; SCNVector3's
    /// are CGFloat too, so the geometry code converts
    /// there.)
    private static func scnMatrix(_ t: simd_float4x4) -> SCNMatrix4 {
        SCNMatrix4(
            m11: CGFloat(t.columns.0.x), m12: CGFloat(t.columns.1.x), m13: CGFloat(t.columns.2.x), m14: CGFloat(t.columns.3.x),
            m21: CGFloat(t.columns.0.y), m22: CGFloat(t.columns.1.y), m23: CGFloat(t.columns.2.y), m24: CGFloat(t.columns.3.y),
            m31: CGFloat(t.columns.0.z), m32: CGFloat(t.columns.1.z), m33: CGFloat(t.columns.2.z), m34: CGFloat(t.columns.3.z),
            m41: CGFloat(t.columns.0.w), m42: CGFloat(t.columns.1.w), m43: CGFloat(t.columns.2.w), m44: CGFloat(t.columns.3.w)
        )
    }

}
