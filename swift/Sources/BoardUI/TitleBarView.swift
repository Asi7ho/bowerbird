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

    override public func resetCursorRects() {
        super.resetCursorRects()
        // The resize cursor on the window's top edge, as
        // cursor rects as well as the mouseMoved setting
        // below (see BoardViewport.resetCursorRects — both
        // are here because the hosting view does not
        // reliably forward the rect system). The view is
        // y-up, so the top edge is at bounds.height.
        // AppKit has no diagonal resize cursor, so the
        // corners use the horizontal one.
        let edge: CGFloat = 6
        let w = bounds.width, h = bounds.height
        addCursorRect(NSRect(x: 0, y: h - edge, width: w, height: edge), cursor: .resizeUpDown)
        addCursorRect(NSRect(x: 0, y: 0, width: edge, height: h), cursor: .resizeLeftRight)
        addCursorRect(NSRect(x: w - edge, y: 0, width: edge, height: h), cursor: .resizeLeftRight)
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
        } else if location.x < edge || location.x > bounds.width - edge {
            NSCursor.resizeLeftRight.set()
        } else {
            NSCursor.arrow.set()
        }
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
