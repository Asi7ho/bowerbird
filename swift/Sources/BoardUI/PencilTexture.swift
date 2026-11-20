import AppKit
import CoreImage

/// The pencil's graphite texture, mirroring the Electron
/// app's SVG filter (feTurbulence fractalNoise, base
/// frequency 0.9, 2 octaves, seed 7; feDisplacementMap
/// scale 2.5). In Core Image that is a displacement
/// distortion driven by a tiled noise image: the stroke's
/// edges are pushed around by the noise, which reads as
/// graphite instead of a clean vector line.
public enum PencilTexture {
    /// The noise tile, built once from a seeded generator
    /// so it never changes, tiled to an infinite extent.
    /// Red drives the horizontal push, green the vertical
    /// one; mid-grey is no push.
    private static let noise: CIImage = {
        let size = 128
        var rng = SeededRandom(seed: 7)
        var pixels = [UInt8](repeating: 0, count: size * size * 4)
        for i in 0..<(size * size) {
            pixels[i * 4] = UInt8(rng.next() * 255)
            pixels[i * 4 + 1] = UInt8(rng.next() * 255)
            pixels[i * 4 + 2] = 0
            pixels[i * 4 + 3] = 255
        }
        let data = Data(pixels)
        guard let provider = CGDataProvider(data: data as CFData),
              let cg = CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            return CIImage()
        }
        let image = CIImage(cgImage: cg)
        let tile = CIFilter(name: "CIAffineTile")
        tile?.setValue(image, forKey: kCIInputImageKey)
        return tile?.outputImage ?? image
    }()

    /// A displacement filter for a pencil stroke, at the
    /// given scale in screen points (the Electron scale,
    /// 2.5 world units, scaled by the zoom). Returns nil
    /// when the filter cannot be built, so the stroke
    /// simply draws clean.
    public static func displacementFilter(scale: CGFloat) -> CIFilter? {
        guard let filter = CIFilter(name: "CIDisplacementDistortion") else { return nil }
        let backing = NSScreen.main?.backingScaleFactor ?? 2
        filter.setValue(noise, forKey: kCIInputDisplacementImageKey)
        filter.setValue(scale * backing, forKey: kCIInputScaleKey)
        return filter
    }
}

/// A tiny seeded random generator, so the noise tile is
/// the same every launch.
private struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed == 0 ? 1 : seed }
    mutating func next() -> Double {
        // SplitMix64.
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        z = z ^ (z >> 31)
        return Double(z >> 11) / Double(1 << 53)
    }
}
