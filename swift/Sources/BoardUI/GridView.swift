import AppKit
import Metal
import MetalKit
import BowerbirdCore

/// The background grid: one full-screen Metal layer drawing
/// an infinite procedural dot/line grid in a fragment shader
/// — zero memory cost at any canvas size or zoom, and no
/// AppKit view invalidation when the camera moves.
///
/// The grid matches the Electron app's (`applyGrid`):
/// a 100-world-unit step that doubles while the view would
/// show more than 40 cells across, dots of ~1.5 screen px
/// at each intersection (or 1px lines), in #d8d8de on a
/// light background and #55555a on a dark one.
///
/// The view never runs a frame loop: it is paused and
/// redraws only when the camera, grid or background changes
/// (no work at rest).
public final class GridView: MTKView, MTKViewDelegate {
    private var pipelineState: MTLRenderPipelineState?
    private var commandQueue: MTLCommandQueue?

    /// The camera: the world point at the top-left, and the
    /// zoom. Setting it redraws the grid.
    public var camera: Camera = Camera(x: 0, y: 0, zoom: 1) {
        didSet { drawGrid() }
    }

    public var grid: Grid = .dots {
        didSet { drawGrid() }
    }

    /// The canvas background colour, as a hex string
    /// ("#FFFFFF"). Setting it redraws the grid.
    public var backgroundHex: String = "#FFFFFF" {
        didSet { drawGrid() }
    }

    public init() {
        super.init(frame: .zero, device: MTLCreateSystemDefaultDevice())
        isPaused = true
        enableSetNeedsDisplay = true
        framebufferOnly = true
        colorPixelFormat = .bgra8Unorm
        delegate = self
        commandQueue = device?.makeCommandQueue()
        pipelineState = Self.makePipeline(device: device)
        drawGrid()
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("GridView is not Interface Builder backed")
    }

    /// The grid is drawn, never clicked: a click on empty
    /// board must reach the viewport (for selection, the
    /// marquee, a double-click), not die on the grid view
    /// underneath everything.
    override public func hitTest(_ point: NSPoint) -> NSView? { nil }

    public func drawGrid() {
        draw()
    }

    // MARK: - MTKViewDelegate

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    public func draw(in view: MTKView) {
        guard let pipelineState,
              let commandQueue,
              let drawable = currentDrawable,
              let descriptor = currentRenderPassDescriptor,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else { return }
        var uniforms = makeUniforms()
        encoder.setRenderPipelineState(pipelineState)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<GridUniforms>.size, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    // MARK: - Uniforms

    private func makeUniforms() -> GridUniforms {
        let step = CameraMath.gridStep(for: Size(w: Double(bounds.width), h: Double(bounds.height)), zoom: camera.zoom)
        let bg = HexColor.parse(backgroundHex) ?? HexColor(r: 1, g: 1, b: 1)
        let luminance = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b
        let gridHex = luminance > 140.0 / 255.0 ? "#d8d8de" : "#55555a"
        let gridColour = HexColor.parse(gridHex) ?? HexColor(r: 0.85, g: 0.85, b: 0.87)
        let gridType: Float = grid == .off ? 0 : (grid == .dots ? 1 : 2)
        return GridUniforms(
            camera: SIMD2<Float>(Float(camera.x), Float(camera.y)),
            zoom: Float(camera.zoom),
            step: Float(step),
            scale: Float(window?.backingScaleFactor ?? 1),
            gridType: gridType,
            bgColor: SIMD4<Float>(Float(bg.r), Float(bg.g), Float(bg.b), 1),
            gridColor: SIMD4<Float>(Float(gridColour.r), Float(gridColour.g), Float(gridColour.b), 1)
        )
    }

    // MARK: - Pipeline

    private static func makePipeline(device: MTLDevice?) -> MTLRenderPipelineState? {
        guard let device,
              let library = try? device.makeLibrary(source: gridShader, options: nil),
              let vertex = library.makeFunction(name: "gridVertex"),
              let fragment = library.makeFunction(name: "gridFragment") else { return nil }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        return try? device.makeRenderPipelineState(descriptor: descriptor)
    }
}

/// The uniform block. The field order matches the Metal
/// struct exactly (each member aligned to its own size, so
/// the layout is the same on both sides).
private struct GridUniforms {
    var camera: SIMD2<Float>
    var zoom: Float
    var step: Float
    var scale: Float
    var gridType: Float
    var bgColor: SIMD4<Float>
    var gridColor: SIMD4<Float>
}

/// A parsed "#RRGGBB" colour, channels in 0...1.
private struct HexColor {
    var r: Double
    var g: Double
    var b: Double

    static func parse(_ hex: String) -> HexColor? {
        var text = hex
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt64(text, radix: 16) else { return nil }
        return HexColor(
            r: Double((value >> 16) & 0xFF) / 255,
            g: Double((value >> 8) & 0xFF) / 255,
            b: Double(value & 0xFF) / 255
        )
    }
}

private let gridShader = """
#include <metal_stdlib>
using namespace metal;

struct GridUniforms {
    float2 camera;
    float zoom;
    float step;
    float scale;
    float gridType;
    float4 bgColor;
    float4 gridColor;
};

struct VertexOut {
    float4 position [[position]];
};

vertex VertexOut gridVertex(uint vertexID [[vertex_id]]) {
    float2 positions[3] = { float2(-1, -1), float2(3, -1), float2(-1, 3) };
    VertexOut out;
    out.position = float4(positions[vertexID], 0, 1);
    return out;
}

fragment float4 gridFragment(VertexOut in [[stage_in]], constant GridUniforms &u [[buffer(0)]]) {
    if (u.gridType < 0.5) { return u.bgColor; }
    // The fragment position is in pixels; convert to points,
    // then to world coordinates.
    float2 screenPt = in.position.xy / u.scale;
    float2 world = screenPt / u.zoom + u.camera;
    float2 cell = fract(world / u.step);
    // Distance to the nearest grid line in each axis, in
    // screen pixels.
    float2 toLine = min(cell, 1.0 - cell) * u.step * u.zoom;
    if (u.gridType < 1.5) {
        // Dots: a soft disc of ~1.5 screen px around each
        // grid intersection (the distance to the nearest
        // corner of the cell).
        float d = length(toLine);
        float a = 1.0 - smoothstep(1.2, 1.6, d);
        return mix(u.bgColor, u.gridColor, a);
    }
    // Lines: within ~0.5 screen px of a grid line.
    float d = min(toLine.x, toLine.y);
    float a = 1.0 - smoothstep(0.3, 0.7, d);
    return mix(u.bgColor, u.gridColor, a);
}
"""
