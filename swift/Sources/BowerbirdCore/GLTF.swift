import Foundation
import simd

/// A glTF 2.0 model (.glb), parsed into plain data: no
/// SceneKit, no rendering — the card view turns this into
/// a scene. Apple has no native glTF loader (RealityKit
/// and ModelIO read .usdz, not .glb, and Quick Look does
/// not preview .glb on the user's Mac), so the app reads
/// the format itself. The loader is deliberately small:
/// it covers the models the app actually meets — one
/// scene, triangle meshes, a base colour per material,
/// node transforms — and skips the rest (textures, skins,
/// animations, morph targets) rather than failing on them.
/// A file it cannot read at all parses to nil, and the
/// card falls back to its file tile.
public struct GLTFDocument {
    /// One mesh primitive: a triangle list, its material,
    /// and its vertex data, de-interleaved and flat.
    public struct Primitive {
        public var positions: [SIMD3<Float>]
        public var normals: [SIMD3<Float>]?
        public var texcoords: [SIMD2<Float>]?
        /// Triangle indices, or empty for a non-indexed
        /// primitive (draw the vertices in order).
        public var indices: [UInt32]
        /// The material's index, or nil for the default
        /// (white, metallic 1, roughness 1).
        public var material: Int?
    }

    public struct Mesh {
        public var primitives: [Primitive]
    }

    public struct Material {
        public var baseColor: SIMD4<Float>
        public var metallic: Float
        public var roughness: Float
        public var doubleSided: Bool
    }

    public struct Node {
        /// The mesh's index, or nil for a grouping node.
        public var mesh: Int?
        public var children: [Int]
        /// The node's local transform, composed from its
        /// matrix or its translation/rotation/scale.
        public var transform: simd_float4x4
    }

    public var meshes: [Mesh]
    public var materials: [Material]
    public var nodes: [Node]
    /// The scene's root node indices (the file's `scene`,
    /// or scene 0).
    public var roots: [Int]

    /// Parses a .glb file: the 12-byte header, the JSON
    /// chunk, then the binary chunk. Nil when the file is
    /// not a glTF 2.0 binary, when its JSON cannot be
    /// read, or when it holds no renderable triangle
    /// primitive.
    public static func parse(data: Data) -> GLTFDocument? {
        guard let parsed = GLBFile(data: data),
              let json = try? JSONDecoder().decode(GltfJSON.self, from: parsed.json) else { return nil }
        let reader = BinReader(bin: parsed.bin, accessors: json.accessors ?? [], bufferViews: json.bufferViews ?? [])
        var meshes: [Mesh] = []
        for mesh in json.meshes ?? [] {
            var primitives: [Primitive] = []
            for primitive in mesh.primitives {
                guard let parsed = reader.primitive(primitive) else { continue }
                primitives.append(parsed)
            }
            guard !primitives.isEmpty else { continue }
            meshes.append(Mesh(primitives: primitives))
        }
        guard !meshes.isEmpty else { return nil }
        var materials: [Material] = []
        for material in json.materials ?? [] {
            let pbr = material.pbrMetallicRoughness
            let color = pbr?.baseColorFactor ?? [1, 1, 1, 1]
            materials.append(Material(
                baseColor: SIMD4<Float>(
                    color.count > 0 ? color[0] : 1,
                    color.count > 1 ? color[1] : 1,
                    color.count > 2 ? color[2] : 1,
                    color.count > 3 ? color[3] : 1
                ),
                metallic: pbr?.metallicFactor ?? 1,
                roughness: pbr?.roughnessFactor ?? 1,
                doubleSided: material.doubleSided ?? false
            ))
        }
        var nodes: [Node] = []
        for node in json.nodes ?? [] {
            nodes.append(Node(
                mesh: node.mesh.flatMap { $0 >= 0 && $0 < meshes.count ? $0 : nil },
                children: node.children ?? [],
                transform: nodeTransform(node)
            ))
        }
        // The roots are the named scene's nodes; a file
        // with no scene draws every node that is nobody's
        // child, so nothing is drawn twice.
        let sceneIndex = json.scene ?? 0
        var roots: [Int] = []
        if let scenes = json.scenes, sceneIndex >= 0, sceneIndex < scenes.count {
            roots = scenes[sceneIndex].nodes ?? []
        } else {
            let isChild = Set(nodes.flatMap { $0.children })
            roots = nodes.indices.filter { !isChild.contains($0) }
        }
        return GLTFDocument(meshes: meshes, materials: materials, nodes: nodes, roots: roots)
    }

    /// A node's local transform: its 4×4 matrix when it
    /// has one (column-major, as the format stores it),
    /// else translation × rotation × scale, else identity.
    private static func nodeTransform(_ node: GltfNode) -> simd_float4x4 {
        if let matrix = node.matrix, matrix.count == 16 {
            return simd_float4x4(
                SIMD4<Float>(matrix[0], matrix[1], matrix[2], matrix[3]),
                SIMD4<Float>(matrix[4], matrix[5], matrix[6], matrix[7]),
                SIMD4<Float>(matrix[8], matrix[9], matrix[10], matrix[11]),
                SIMD4<Float>(matrix[12], matrix[13], matrix[14], matrix[15])
            )
        }
        let translation = node.translation ?? [0, 0, 0]
        let rotation = node.rotation ?? [0, 0, 0, 1]
        let scale = node.scale ?? [1, 1, 1]
        let t = simd_float4x4(
            SIMD4<Float>(1, 0, 0, 0),
            SIMD4<Float>(0, 1, 0, 0),
            SIMD4<Float>(0, 0, 1, 0),
            SIMD4<Float>(
                translation.count > 0 ? translation[0] : 0,
                translation.count > 1 ? translation[1] : 0,
                translation.count > 2 ? translation[2] : 0,
                1
            )
        )
        let r = rotationMatrix(quaternion: rotation)
        let s = simd_float4x4(
            SIMD4<Float>(scale.count > 0 ? scale[0] : 1, 0, 0, 0),
            SIMD4<Float>(0, scale.count > 1 ? scale[1] : 1, 0, 0),
            SIMD4<Float>(0, 0, scale.count > 2 ? scale[2] : 1, 0),
            SIMD4<Float>(0, 0, 0, 1)
        )
        return t * r * s
    }

    /// A quaternion (x, y, z, w) as a rotation matrix,
    /// written out by hand: the simd module has no direct
    /// quaternion-to-matrix initializer to call.
    private static func rotationMatrix(quaternion q: [Float]) -> simd_float4x4 {
        let x = q.count > 0 ? q[0] : 0
        let y = q.count > 1 ? q[1] : 0
        let z = q.count > 2 ? q[2] : 0
        let w = q.count > 3 ? q[3] : 1
        let x2 = x + x, y2 = y + y, z2 = z + z
        let xx = x * x2, xy = x * y2, xz = x * z2
        let yy = y * y2, yz = y * z2, zz = z * z2
        let wx = w * x2, wy = w * y2, wz = w * z2
        return simd_float4x4(
            SIMD4<Float>(1 - (yy + zz), xy + wz, xz - wy, 0),
            SIMD4<Float>(xy - wz, 1 - (xx + zz), yz + wx, 0),
            SIMD4<Float>(xz + wy, yz - wx, 1 - (xx + yy), 0),
            SIMD4<Float>(0, 0, 0, 1)
        )
    }
}

// MARK: - The .glb container

/// A .glb file split into its JSON and binary chunks.
/// The header is 12 bytes (magic "glTF", version 2,
/// total length); each chunk is a little-endian length
/// plus a type, then the bytes, padded to 4 bytes (spaces
/// for JSON, zeroes for binary).
private struct GLBFile {
    var json: Data
    var bin: Data

    init?(data: Data) {
        guard data.count >= 12,
              data[0] == 0x67, data[1] == 0x6C, data[2] == 0x54, data[3] == 0x46,
              u32(data, at: 4) == 2 else { return nil }
        var offset = 12
        guard let jsonChunk = Self.chunk(data, at: &offset, type: 0x4E4F534A) else { return nil }
        json = jsonChunk
        // The binary chunk is optional (a file with no
        // buffers has no geometry); a missing one reads
        // as empty, and every accessor then fails its
        // bounds check.
        bin = Self.chunk(data, at: &offset, type: 0x004E4942) ?? Data()
    }

    private static func chunk(_ data: Data, at offset: inout Int, type: UInt32) -> Data? {
        guard offset + 8 <= data.count,
              u32(data, at: offset + 4) == type else { return nil }
        let length = Int(u32(data, at: offset))
        guard offset + 8 + length <= data.count else { return nil }
        let chunk = data[(offset + 8)..<(offset + 8 + length)]
        offset += 8 + length
        // Chunks are padded to 4 bytes; the next chunk
        // starts after the padding.
        offset += (4 - length % 4) % 4
        return chunk
    }
}

/// A little-endian 32-bit value at a byte offset, read
/// byte by byte so no alignment is assumed.
private func u32(_ data: Data, at offset: Int) -> UInt32 {
    guard offset + 4 <= data.count else { return 0 }
    return UInt32(data[offset])
        | UInt32(data[offset + 1]) << 8
        | UInt32(data[offset + 2]) << 16
        | UInt32(data[offset + 3]) << 24
}

// MARK: - The binary chunk

/// Reads accessors out of the binary chunk: the floats
/// for positions, normals and texture coordinates, and
/// the unsigned integers for indices. Every read is
/// bounds-checked — a file that overruns its buffers
/// yields no primitive instead of a crash.
private struct BinReader {
    var bin: Data
    var accessors: [GltfAccessor]
    var bufferViews: [GltfBufferView]

    /// One triangle primitive from its JSON: the position
    /// accessor is required, the rest optional; any other
    /// draw mode than triangles (4) is skipped, and a
    /// primitive whose data overruns its buffers is
    /// skipped too.
    func primitive(_ json: GltfPrimitive) -> GLTFDocument.Primitive? {
        if let mode = json.mode, mode != 4 { return nil }
        guard let positionIndex = json.attributes["POSITION"],
              let positions = vec3s(accessor: positionIndex) else { return nil }
        let normals = json.attributes["NORMAL"].flatMap { vec3s(accessor: $0) }
        let texcoords = json.attributes["TEXCOORD_0"].flatMap { vec2s(accessor: $0) }
        let indices = json.indices.flatMap { readIndices(accessor: $0) } ?? []
        return GLTFDocument.Primitive(
            positions: positions,
            normals: normals,
            texcoords: texcoords,
            indices: indices,
            material: json.material
        )
    }

    private func vec3s(accessor index: Int) -> [SIMD3<Float>]? {
        guard let floats = readFloats(accessor: index), floats.count % 3 == 0 else { return nil }
        var out: [SIMD3<Float>] = []
        out.reserveCapacity(floats.count / 3)
        for i in stride(from: 0, to: floats.count, by: 3) {
            out.append(SIMD3<Float>(floats[i], floats[i + 1], floats[i + 2]))
        }
        return out
    }

    private func vec2s(accessor index: Int) -> [SIMD2<Float>]? {
        guard let floats = readFloats(accessor: index), floats.count % 2 == 0 else { return nil }
        var out: [SIMD2<Float>] = []
        out.reserveCapacity(floats.count / 2)
        for i in stride(from: 0, to: floats.count, by: 2) {
            out.append(SIMD2<Float>(floats[i], floats[i + 1]))
        }
        return out
    }

    /// A float accessor (componentType 5126) as flat
    /// floats, honouring the buffer view's stride (an
    /// interleaved buffer packs several attributes per
    /// element; the stride is the element's full width).
    private func readFloats(accessor index: Int) -> [Float]? {
        guard index >= 0, index < accessors.count else { return nil }
        let accessor = accessors[index]
        guard accessor.componentType == 5126,
              let components = componentCount(accessor.type),
              let (base, stride) = elementRange(accessor: accessor, elementSize: 4 * components) else { return nil }
        var out: [Float] = []
        out.reserveCapacity(accessor.count * components)
        for element in 0..<accessor.count {
            let at = base + element * stride
            for component in 0..<components {
                let byteOffset = at + component * 4
                guard byteOffset + 4 <= bin.count else { return nil }
                out.append(bin.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: byteOffset, as: Float.self) })
            }
        }
        return out
    }

    /// An index accessor (componentType 5121, 5123 or
    /// 5125) as unsigned 32-bit indices.
    private func readIndices(accessor index: Int) -> [UInt32]? {
        guard index >= 0, index < accessors.count else { return nil }
        let accessor = accessors[index]
        guard accessor.type == "SCALAR",
              let (base, stride) = elementRange(accessor: accessor, elementSize: componentSize(accessor.componentType)) else { return nil }
        var out: [UInt32] = []
        out.reserveCapacity(accessor.count)
        for element in 0..<accessor.count {
            let byteOffset = base + element * stride
            switch accessor.componentType {
            case 5121:
                guard byteOffset + 1 <= bin.count else { return nil }
                out.append(UInt32(bin[byteOffset]))
            case 5123:
                guard byteOffset + 2 <= bin.count else { return nil }
                out.append(UInt32(bin.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: byteOffset, as: UInt16.self) }))
            case 5125:
                guard byteOffset + 4 <= bin.count else { return nil }
                out.append(bin.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: byteOffset, as: UInt32.self) })
            default:
                return nil
            }
        }
        return out
    }

    /// An accessor's first element and stride, in the
    /// binary chunk: the buffer view's offset plus the
    /// accessor's own, and the view's stride when the
    /// buffer is interleaved (else the element's size).
    /// Nil when the accessor or its view is out of range.
    /// The per-element reads bound-check every component,
    /// so only the stride and a sane base are checked here.
    private func elementRange(accessor: GltfAccessor, elementSize: Int) -> (base: Int, stride: Int)? {
        guard let viewIndex = accessor.bufferView,
              viewIndex >= 0, viewIndex < bufferViews.count,
              elementSize > 0 else { return nil }
        let view = bufferViews[viewIndex]
        guard view.buffer == 0 else { return nil }
        let base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
        let stride = view.byteStride ?? elementSize
        guard stride >= elementSize, base >= 0, accessor.count == 0 || base < bin.count else { return nil }
        return (base, stride)
    }

    private func componentCount(_ type: String) -> Int? {
        switch type {
        case "SCALAR": return 1
        case "VEC2": return 2
        case "VEC3": return 3
        case "VEC4": return 4
        default: return nil
        }
    }

    private func componentSize(_ componentType: Int) -> Int {
        switch componentType {
        case 5120, 5121: return 1
        case 5122, 5123: return 2
        case 5125, 5126: return 4
        default: return 0
        }
    }
}

// MARK: - The JSON chunk

private struct GltfJSON: Decodable {
    var scene: Int?
    var scenes: [GltfScene]?
    var nodes: [GltfNode]?
    var meshes: [GltfMesh]?
    var materials: [GltfMaterial]?
    var accessors: [GltfAccessor]?
    var bufferViews: [GltfBufferView]?
    var buffers: [GltfBuffer]?
}

private struct GltfScene: Decodable {
    var nodes: [Int]?
}

private struct GltfNode: Decodable {
    var mesh: Int?
    var children: [Int]?
    var matrix: [Float]?
    var translation: [Float]?
    var rotation: [Float]?
    var scale: [Float]?
    var name: String?
}

private struct GltfMesh: Decodable {
    var primitives: [GltfPrimitive]
}

private struct GltfPrimitive: Decodable {
    var attributes: [String: Int]
    var indices: Int?
    var material: Int?
    var mode: Int?
}

private struct GltfMaterial: Decodable {
    var pbrMetallicRoughness: GltfPBR?
    var doubleSided: Bool?
}

private struct GltfPBR: Decodable {
    var baseColorFactor: [Float]?
    var metallicFactor: Float?
    var roughnessFactor: Float?
}

private struct GltfAccessor: Decodable {
    var bufferView: Int?
    var byteOffset: Int?
    var componentType: Int
    var count: Int
    var type: String
}

private struct GltfBufferView: Decodable {
    var buffer: Int
    var byteOffset: Int?
    var byteLength: Int
    var byteStride: Int?
}

private struct GltfBuffer: Decodable {
    var byteLength: Int
}
