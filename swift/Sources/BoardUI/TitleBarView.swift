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

    override public func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeInKeyWindow],
            owner: self, userInfo: nil
        ))
    }

    override public func mouseMoved(with event: NSEvent) {
        // The resize cursor on the window's top edge, set
        // directly (see BoardViewport.mouseMoved — the
        // cursor rects did not show it). The view is y-up,
        // so the top edge is at bounds.height.
        let location = convert(event.locationInWindow, from: nil)
        let edge: CGFloat = 6
        if location.y > bounds.height - edge {
            if location.x < edge || location.x > bounds.width - edge {
                NSCursor.resizeLeftRight.set()
            } else {
                NSCursor.resizeUpDown.set()
            }
        } else {
            NSCursor.arrow.set()
        }
    }

    override public func resetCursorRects() {
        super.resetCursorRects()
        // The window's top edge and top corners live here
        // (the strip is the top of the window): the resize
        // cursor, explicitly, so dragging the top edge
        // shows the resize arrow instead of the plain
        // pointer. The view is y-up, so the top edge is at
        // bounds.height.
        let edge: CGFloat = 6
        let w = bounds.width, h = bounds.height
        guard w > edge * 2, h > edge else { return }
        addCursorRect(CGRect(x: edge, y: h - edge, width: w - edge * 2, height: edge), cursor: .resizeUpDown)
        // AppKit has no diagonal resize cursor (the
        // diagonal arrow at a corner is drawn by the window
        // server, not exposed as an NSCursor), so the
        // corners take the horizontal resize cursor.
        addCursorRect(CGRect(x: 0, y: h - edge, width: edge, height: edge), cursor: .resizeLeftRight)
        addCursorRect(CGRect(x: w - edge, y: h - edge, width: edge, height: edge), cursor: .resizeLeftRight)
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
