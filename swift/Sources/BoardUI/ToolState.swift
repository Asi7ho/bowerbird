import BowerbirdCore
import Combine
import SwiftUI

/// Which flyout is open: the select family's (Select /
/// Lasso), the draw family's (pen / pencil / highlighter /
/// eraser), the shape family's (the six shapes — the arrow
/// lives in the toolbar as the connector, not here) or the
/// colour family's (the pen palette). Transient: a flyout
/// appears only on a tool button click or a tool shortcut,
/// and disappears once a tool is picked or the user clicks
/// anywhere else.
public enum Picker: Equatable {
    case select, draw, shape, color
}

/// The toolbar's state, shared between the SwiftUI toolbar
/// and the AppKit viewport: which tool is active, which
/// colour the pen draws in, and the last tool of each
/// family (a shortcut restores the last one used, it does
/// not reset to the family's first tool). The pen colours
/// are the Electron app's palette; the default is ink.
public final class ToolState: ObservableObject {
    public static let palette = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6a4c93", "#2A9D8F"]

    @Published public var tool: Tool = .select(.select)
    @Published public var penColor: String = "#1A1A1A"
    @Published public var pickerOpen: Picker?
    /// Whether the pointer is over the toolbar or its side
    /// panel. The toolbar sets it on hover; the board reads
    /// it so the tool cursor does not stay in force over
    /// the bar (the board's tracking area covers the bar's
    /// place, so its mouse move would otherwise set the
    /// tool cursor right back over the toolbar).
    @Published public var isHoveringToolbar = false
    /// Whether the next shape drawn is an outline (just
    /// the border, no fill) or filled. The geometry flyout
    /// switches it; the shape drawing reads it.
    @Published public var shapeOutline: Bool = false

    @Published public private(set) var lastSelectMode: SelectMode = .select
    @Published public private(set) var lastDrawTool: DrawTool = .pen
    @Published public private(set) var lastShape: ShapeKind = .rect

    public init() {}

    /// Activate a tool, remembering it as the last of its
    /// family so its shortcut restores it.
    public func activate(_ tool: Tool) {
        switch tool {
        case .select(let mode): lastSelectMode = mode
        case .draw(let draw): lastDrawTool = draw
        case .shape(let shape): lastShape = shape
        case .connector: break
        }
        self.tool = tool
    }

    /// The V shortcut: select, restoring the last select
    /// mode (select or lasso), and open the select flyout.
    public func selectShortcut() {
        activate(.select(lastSelectMode))
        pickerOpen = .select
    }

    /// The P shortcut: draw, restoring the last draw tool
    /// (pen, pencil, highlighter or eraser), and open the
    /// draw flyout.
    public func drawShortcut() {
        activate(.draw(lastDrawTool))
        pickerOpen = .draw
    }

    /// The X shortcut: the eraser, and open the draw
    /// flyout (the eraser lives in the draw family).
    public func eraserShortcut() {
        activate(.draw(.eraser))
        pickerOpen = .draw
    }

    /// The R shortcut: geometry, restoring the last shape,
    /// and open the shape flyout.
    public func shapeShortcut() {
        activate(.shape(lastShape))
        pickerOpen = .shape
    }
}
