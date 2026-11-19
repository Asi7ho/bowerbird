import AppKit
import SwiftUI

/// The title bar strip: a plain view whose only job is to
/// drag the window. A SwiftUI `Color` does not drag — the
/// window's hidden title bar area is draggable in theory,
/// but only the part the system recognises, and the strip's
/// own clicks were not moving the window across its full
/// width. This view calls `performDrag` on mouse down, so
/// the whole strip (the full width of the top bar, not just
/// the title) moves the window.
public final class TitleBarDragView: NSView {
    override public func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

public struct TitleBarView: NSViewRepresentable {
    public var background: NSColor

    public init(background: NSColor) {
        self.background = background
    }

    public func makeNSView(context: Context) -> TitleBarDragView {
        let view = TitleBarDragView()
        view.wantsLayer = true
        view.layer?.backgroundColor = background.cgColor
        return view
    }

    public func updateNSView(_ nsView: TitleBarDragView, context: Context) {
        nsView.layer?.backgroundColor = background.cgColor
    }
}
