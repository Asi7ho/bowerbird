import Combine
import SwiftUI

/// Which flyout is open: the select family's (Select /
/// Lasso), the draw family's (pen / pencil / highlighter)
/// or the shape family's (the seven shapes). Transient:
/// a flyout appears only on a tool button click or a tool
/// shortcut, and disappears once a tool is picked or the
/// user clicks anywhere else.
public enum Picker: Equatable {
    case select, draw, shape
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

    public private(set) var lastSelectMode: SelectMode = .select
    public private(set) var lastDrawTool: DrawTool = .pen
    public private(set) var lastShape: ShapeKind = .rect

    public init() {}

    /// Activate a tool, remembering it as the last of its
    /// family so its shortcut restores it.
    public func activate(_ tool: Tool) {
        switch tool {
        case .select(let mode): lastSelectMode = mode
        case .draw(let draw): lastDrawTool = draw
        case .shape(let shape): lastShape = shape
        case .connector, .eraser: break
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
    /// (pen, pencil or highlighter), and open the draw
    /// flyout.
    public func drawShortcut() {
        activate(.draw(lastDrawTool))
        pickerOpen = .draw
    }

    /// The R shortcut: geometry, restoring the last shape,
    /// and open the shape flyout.
    public func shapeShortcut() {
        activate(.shape(lastShape))
        pickerOpen = .shape
    }
}
