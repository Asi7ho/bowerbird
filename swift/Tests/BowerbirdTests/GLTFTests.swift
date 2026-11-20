import Foundation
import simd
import XCTest
@testable import BowerbirdCore

final class GLTFTests: XCTestCase {
    func testParsesTheWelcomeCube() {
        let url = Bundle.module.url(forResource: "welcome-cube", withExtension: "glb", subdirectory: "Fixtures")!
        let data = try! Data(contentsOf: url)
        let doc = GLTFDocument.parse(data: data)
        XCTAssertNotNil(doc)
        guard let doc else { return }
        XCTAssertEqual(doc.meshes.count, 1)
        XCTAssertEqual(doc.meshes[0].primitives.count, 1)
        let primitive = doc.meshes[0].primitives[0]
        XCTAssertEqual(primitive.positions.count, 24)
        XCTAssertEqual(primitive.normals?.count, 24)
        XCTAssertEqual(primitive.indices.count, 36)
        XCTAssertEqual(primitive.material, 0)
        XCTAssertEqual(doc.materials.count, 1)
        XCTAssertEqual(doc.materials[0].baseColor, SIMD4<Float>(0.2, 0.5, 0.8, 1.0))
        XCTAssertEqual(doc.materials[0].metallic, 0)
        XCTAssertEqual(doc.materials[0].roughness, 0.8)
        XCTAssertEqual(doc.nodes.count, 1)
        XCTAssertEqual(doc.nodes[0].mesh, 0)
        XCTAssertEqual(doc.roots, [0])
    }

    func testParsesATriangleBuiltInCode() {
        let doc = GLTFDocument.parse(data: triangleGLB())
        XCTAssertNotNil(doc)
        guard let doc else { return }
        XCTAssertEqual(doc.meshes.count, 1)
        let primitive = doc.meshes[0].primitives[0]
        XCTAssertEqual(primitive.positions, [SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0), SIMD3<Float>(0, 1, 0)])
        XCTAssertEqual(primitive.indices, [0, 1, 2])
        XCTAssertEqual(doc.materials[0].baseColor, SIMD4<Float>(1, 0, 0, 1))
        XCTAssertEqual(doc.materials[0].metallic, 0.5)
        XCTAssertEqual(doc.materials[0].roughness, 0.25)
        // The node is translated by (1, 2, 3): the
        // transform's last column is the translation.
        XCTAssertEqual(doc.nodes[0].transform.columns.3, SIMD4<Float>(1, 2, 3, 1))
        XCTAssertEqual(doc.roots, [0])
    }

    func testReadsInterleavedPositionsAndNormals() {
        // One buffer view, 24 bytes per element: the
        // position at offset 0, the normal at offset 12.
        var bin = Data()
        bin.append(floats([0, 0, 0, 0, 0, 1]))
        bin.append(floats([1, 0, 0, 0, 1, 0]))
        let json: [String: Any] = [
            "asset": ["version": "2.0"],
            "scene": 0,
            "scenes": [["nodes": [0]]],
            "nodes": [["mesh": 0]],
            "meshes": [["primitives": [[
                "attributes": ["POSITION": 0, "NORMAL": 1],
                "mode": 4
            ]]]],
            "accessors": [
                ["bufferView": 0, "byteOffset": 0, "componentType": 5126, "count": 2, "type": "VEC3"],
                ["bufferView": 0, "byteOffset": 12, "componentType": 5126, "count": 2, "type": "VEC3"]
            ],
            "bufferViews": [["buffer": 0, "byteOffset": 0, "byteLength": 48, "byteStride": 24]],
            "buffers": [["byteLength": 48]]
        ]
        let doc = GLTFDocument.parse(data: makeGLB(json: json, bin: bin))
        XCTAssertNotNil(doc)
        guard let doc else { return }
        let primitive = doc.meshes[0].primitives[0]
        XCTAssertEqual(primitive.positions, [SIMD3<Float>(0, 0, 0), SIMD3<Float>(1, 0, 0)])
        XCTAssertEqual(primitive.normals, [SIMD3<Float>(0, 0, 1), SIMD3<Float>(0, 1, 0)])
    }

    func testRejectsBadFiles() {
        XCTAssertNil(GLTFDocument.parse(data: Data()))
        XCTAssertNil(GLTFDocument.parse(data: Data("not a glb at all".utf8)))
        // Version 1 is not glTF 2.0.
        XCTAssertNil(GLTFDocument.parse(data: makeGLB(json: triangleJSON(), bin: triangleBIN(), version: 1)))
        // Truncated: the header promises more than the
        // file holds.
        let full = triangleGLB()
        XCTAssertNil(GLTFDocument.parse(data: full.prefix(full.count - 10)))
        // A mesh with no binary chunk has no geometry.
        XCTAssertNil(GLTFDocument.parse(data: makeGLB(json: triangleJSON(), bin: nil)))
    }

    func testSkipsNonTrianglePrimitives() {
        var json = triangleJSON()
        var meshes = json["meshes"] as! [[String: Any]]
        var primitives = meshes[0]["primitives"] as! [[String: Any]]
        primitives[0]["mode"] = 1
        meshes[0]["primitives"] = primitives
        json["meshes"] = meshes
        XCTAssertNil(GLTFDocument.parse(data: makeGLB(json: json, bin: triangleBIN())))
    }

    func testNodeMatrixIsUsedVerbatim() {
        var json = triangleJSON()
        var nodes = json["nodes"] as! [[String: Any]]
        nodes[0].removeValue(forKey: "translation")
        // A translation by (4, 5, 6) as a column-major
        // matrix: the last column carries it.
        nodes[0]["matrix"] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]
        json["nodes"] = nodes
        let doc = GLTFDocument.parse(data: makeGLB(json: json, bin: triangleBIN()))
        XCTAssertNotNil(doc)
        XCTAssertEqual(doc?.nodes[0].transform.columns.3, SIMD4<Float>(4, 5, 6, 1))
    }

    // MARK: - A triangle .glb, built in code

    private func triangleJSON() -> [String: Any] {
        [
            "asset": ["version": "2.0"],
            "scene": 0,
            "scenes": [["nodes": [0]]],
            "nodes": [["mesh": 0, "name": "Tri", "translation": [1, 2, 3]]],
            "meshes": [["primitives": [[
                "attributes": ["POSITION": 0],
                "indices": 1,
                "material": 0
            ]]]],
            "materials": [["pbrMetallicRoughness": [
                "baseColorFactor": [1, 0, 0, 1],
                "metallicFactor": 0.5,
                "roughnessFactor": 0.25
            ]]],
            "accessors": [
                ["bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"],
                ["bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"]
            ],
            "bufferViews": [
                ["buffer": 0, "byteOffset": 0, "byteLength": 36],
                ["buffer": 0, "byteOffset": 36, "byteLength": 6]
            ],
            "buffers": [["byteLength": 42]]
        ]
    }

    private func triangleBIN() -> Data {
        var bin = Data()
        bin.append(floats([0, 0, 0, 1, 0, 0, 0, 1, 0]))
        bin.append(u16s([0, 1, 2]))
        return bin
    }

    private func triangleGLB() -> Data {
        makeGLB(json: triangleJSON(), bin: triangleBIN())
    }

    /// A .glb from its JSON and binary chunk (nil binary
    /// chunk: a JSON-only file). The JSON chunk is padded
    /// with spaces and the binary chunk with zeroes, to
    /// 4-byte alignment, as the format requires.
    private func makeGLB(json: [String: Any], bin: Data?, version: UInt32 = 2) -> Data {
        let jsonData = try! JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
        let jsonPadded = jsonData + Data(repeating: 0x20, count: (4 - jsonData.count % 4) % 4)
        let binPadded = (bin ?? Data()) + Data(repeating: 0, count: (4 - (bin ?? Data()).count % 4) % 4)
        var out = Data()
        out.append(contentsOf: [0x67, 0x6C, 0x54, 0x46])
        out.append(u32(version))
        let binLength = bin == nil ? 0 : 8 + binPadded.count
        out.append(u32(UInt32(12 + 8 + jsonPadded.count + binLength)))
        out.append(u32(UInt32(jsonPadded.count)))
        out.append(u32(0x4E4F534A))
        out.append(jsonPadded)
        if bin != nil {
            out.append(u32(UInt32(binPadded.count)))
            out.append(u32(0x004E4942))
            out.append(binPadded)
        }
        return out
    }

    private func u32(_ value: UInt32) -> Data {
        Data([UInt8(value & 0xFF), UInt8((value >> 8) & 0xFF), UInt8((value >> 16) & 0xFF), UInt8((value >> 24) & 0xFF)])
    }

    private func floats(_ values: [Float]) -> Data {
        var out = Data()
        for value in values {
            var v = value
            out.append(Data(bytes: &v, count: 4))
        }
        return out
    }

    private func u16s(_ values: [UInt16]) -> Data {
        var out = Data()
        for value in values {
            var v = value
            out.append(Data(bytes: &v, count: 2))
        }
        return out
    }
}
