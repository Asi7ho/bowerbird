import BowerbirdCore
import Foundation

/// The select tool's mode: a plain click/drag selection,
/// or a freehand loop. V restores the last mode used.
public enum SelectMode: String, Equatable {
    case select, lasso
}

/// The draw tool: pen, pencil (graphite texture) or
/// highlighter (wide, translucent). P restores the last
/// one used.
public enum DrawTool: String, Equatable {
    case pen, pencil, highlighter
}

/// The active tool. The toolbar and the shortcuts both set
/// it; the viewport reads it to decide what a pointer
/// gesture does. The picker (which flyout is open) is
/// transient and lives with the toolbar, not here.
public enum Tool: Equatable {
    case select(SelectMode)
    case draw(DrawTool)
    case shape(ShapeKind)
    case connector
    case eraser

    /// The shortcut that activates this tool, as the
    /// Electron app binds it: V select, P draw, R geometry,
    /// A connector, X eraser.
    public var shortcut: String {
        switch self {
        case .select: return "V"
        case .draw: return "P"
        case .shape: return "R"
        case .connector: return "A"
        case .eraser: return "X"
        }
    }
}
