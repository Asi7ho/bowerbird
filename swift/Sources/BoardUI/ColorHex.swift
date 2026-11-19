import AppKit

public extension NSColor {
    /// A colour from a "#RRGGBB" hex string, or nil when the
    /// string is not a hex colour (a board is untrusted
    /// input — a bad colour must never crash the app).
    static func fromHex(_ hex: String) -> NSColor? {
        var text = hex
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt64(text, radix: 16) else { return nil }
        return NSColor(
            srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}
