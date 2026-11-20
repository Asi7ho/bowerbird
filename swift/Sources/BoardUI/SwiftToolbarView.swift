import AppKit
import BowerbirdCore
import SwiftUI

/// The toolbar, as a SwiftUI view over the board: a
/// vertical bar of tool families on the left, with a
/// flyout panel that opens to its right when a family is
/// picked. SwiftUI Buttons take the click natively — the
/// AppKit bar never reliably received clicks on a real
/// Mac (its buttons' hit test missed, the bar swallowed
/// the click, and the board never saw it either), through
/// four rounds of fixes. This is the same bar, the same
/// flyouts, the same ToolState, drawn by SwiftUI instead.
public struct SwiftToolbarView: View {
    @ObservedObject public var tools: ToolState

    public init(tools: ToolState) {
        self.tools = tools
    }

    private static let barWidth: CGFloat = 56
    private static let barHeight: CGFloat = 264
    private static let buttonSize: CGFloat = 40
    private static let pad: CGFloat = 12
    private static let gap: CGFloat = 10

    public var body: some View {
        // The bar and its flyout side by side: the flyout
        // sits in the layout (not offset outside the
        // toolbar's frame), so its buttons and the bar's
        // buttons are all hit-testable. An offset flyout
        // hung outside the toolbar's bounds, and while it
        // was open the bar's family buttons stopped taking
        // clicks — a tap on Select while the Pen panel was
        // open did nothing.
        HStack(alignment: .top, spacing: 8) {
            bar
            if let picker = tools.pickerOpen {
                flyout(for: picker)
                    // The flyout is the toolbar's side panel:
                    // the normal cursor here, like the bar.
                    // (The board decides toolbar-vs-board from
                    // the pointer's place, so no flag is kept.)
                    .onHover { hovering in
                        if hovering { NSCursor.arrow.set() }
                    }
            }
        }
        .frame(height: Self.barHeight, alignment: .topLeading)
        // The normal cursor over the whole bar. The board
        // sets the tool's own cursor (circle, plus,
        // crosshair) by NSCursor.set, which is app-wide and
        // would otherwise stay in force over the bar — the
        // bar must show the normal cursor, and the tool
        // cursor only on the board. (SwiftUI has no .cursor
        // modifier in this SDK, so the bar sets the arrow
        // on hover; moving back onto the board lets the
        // viewport's mouse move set the tool cursor again.)
        .onHover { hovering in
            if hovering { NSCursor.arrow.set() }
        }
    }

    /// The bar: five family buttons in a material pill.
    private var bar: some View {
        VStack(spacing: Self.gap) {
            familyButton(
                icon: tools.lastSelectMode == .lasso ? "lasso" : "cursorarrow",
                active: isSelectTool,
                action: { toggleFamily(.select) { tools.selectShortcut() } }
            )
            familyButton(
                icon: drawIcon(for: tools.lastDrawTool),
                active: isDrawTool,
                action: { toggleFamily(.draw) { tools.drawShortcut() } }
            )
            familyButton(
                icon: shapeIcon(for: tools.lastShape, filled: !tools.shapeOutline),
                active: isShapeTool,
                action: { toggleFamily(.shape) { tools.shapeShortcut() } }
            )
            familyButton(
                icon: "arrow.up.right",
                active: isConnectorTool,
                action: {
                    tools.activate(.connector)
                    tools.pickerOpen = nil
                }
            )
            colourButton
        }
        .padding(.vertical, Self.pad)
        .frame(width: Self.barWidth, height: Self.barHeight)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.15), radius: 12, x: 0, y: 4)
    }

    /// A tap on any toolbar control means the pointer is
    /// over the toolbar, so the cursor is the normal arrow
    /// — not the tool's. This forces it at the tap: the
    /// board refreshes the cursor a turn after a tool
    /// changes, and without this it sets the tool's cursor
    /// (circle, plus, crosshair) the moment a tool is
    /// picked, even though the pointer never left the bar.
    /// The tool's cursor only appears once the pointer is
    /// back on the board.
    private func tappedToolbar() {
        NSCursor.arrow.set()
    }

    /// One family button: a 40pt SF Symbol, with a quiet
    /// fill while its family is the active tool.
    private func familyButton(icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: { tappedToolbar(); action() }) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundColor(.primary)
                .frame(width: Self.buttonSize, height: Self.buttonSize)
                .background(active ? Color.black.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    /// The colour button: a filled circle in the pen
    /// colour, active while the colour flyout is open.
    private var colourButton: some View {
        Button(action: {
            tappedToolbar()
            if tools.pickerOpen == .color {
                tools.pickerOpen = nil
            } else {
                tools.pickerOpen = .color
            }
        }) {
            Circle()
                .fill(Color(hex: tools.penColor) ?? Color.black)
                .frame(width: 20, height: 20)
                .frame(width: Self.buttonSize, height: Self.buttonSize)
                .background(tools.pickerOpen == .color ? Color.black.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    /// A family button toggles its flyout: open it (and
    /// activate the family's last tool) when it is closed,
    /// close it when it is already open.
    private func toggleFamily(_ picker: Picker, activate: () -> Void) {
        if tools.pickerOpen == picker {
            tools.pickerOpen = nil
        } else {
            activate()
        }
    }

    /// The flyout for the open picker: a material panel of
    /// the family's tools, top-aligned with the bar.
    @ViewBuilder
    private func flyout(for picker: Picker) -> some View {
        switch picker {
        case .select:
            iconFlyout(options: [
                ("cursorarrow", "Select", { tools.activate(.select(.select)) }),
                ("lasso", "Lasso", { tools.activate(.select(.lasso)) }),
            ])
        case .draw:
            iconFlyout(options: [
                ("pencil", "Pen", { tools.activate(.draw(.pen)) }),
                ("pencil.tip", "Pencil", { tools.activate(.draw(.pencil)) }),
                ("highlighter", "Highlighter", { tools.activate(.draw(.highlighter)) }),
                ("eraser", "Eraser", { tools.activate(.draw(.eraser)) }),
            ])
        case .shape:
            shapeFlyout
        case .color:
            colorFlyout
        }
    }

    /// A one-column flyout of icon buttons; picking one
    /// activates it and closes the flyout.
    private func iconFlyout(options: [(icon: String, label: String, pick: () -> Void)]) -> some View {
        VStack(spacing: Self.gap) {
            ForEach(options, id: \.label) { option in
                Button(action: {
                    tappedToolbar()
                    option.pick()
                    tools.pickerOpen = nil
                }) {
                    Image(systemName: option.icon)
                        .font(.system(size: 18))
                        .foregroundColor(.primary)
                        .frame(width: Self.buttonSize, height: Self.buttonSize)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.label)
            }
        }
        .padding(.vertical, Self.pad)
        .frame(width: Self.barWidth)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.15), radius: 12, x: 0, y: 4)
    }

    /// The geometry flyout: two columns — filled on the
    /// left, outline on the right. Picking a shape sets
    /// the fill mode from its column and closes the flyout.
    private var shapeFlyout: some View {
        let shapes = ShapeKind.allCases.filter { $0 != .arrow }
        return HStack(spacing: Self.gap) {
            VStack(spacing: Self.gap) {
                ForEach(shapes, id: \.self) { shape in
                    shapeButton(shape: shape, filled: true)
                }
            }
            VStack(spacing: Self.gap) {
                ForEach(shapes, id: \.self) { shape in
                    shapeButton(shape: shape, filled: false)
                }
            }
        }
        .padding(Self.pad)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.15), radius: 12, x: 0, y: 4)
    }

    private func shapeButton(shape: ShapeKind, filled: Bool) -> some View {
        Button(action: {
            tappedToolbar()
            tools.shapeOutline = !filled
            tools.activate(.shape(shape))
            tools.pickerOpen = nil
        }) {
            Image(systemName: shapeIcon(for: shape, filled: filled))
                .font(.system(size: 18))
                .foregroundColor(.primary)
                .frame(width: Self.buttonSize, height: Self.buttonSize)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(shape.rawValue.capitalized + (filled ? " filled" : " outline"))
    }

    /// The colour flyout: the palette as coloured circles.
    private var colorFlyout: some View {
        VStack(spacing: Self.gap) {
            ForEach(ToolState.palette, id: \.self) { hex in
                Button(action: {
                    tappedToolbar()
                    tools.penColor = hex
                    tools.pickerOpen = nil
                }) {
                    Circle()
                        .fill(Color(hex: hex) ?? Color.black)
                        .frame(width: 20, height: 20)
                        .frame(width: Self.buttonSize, height: Self.buttonSize)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(hex)
            }
        }
        .padding(.vertical, Self.pad)
        .frame(width: Self.barWidth)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.15), radius: 12, x: 0, y: 4)
    }

    private var isSelectTool: Bool {
        if case .select = tools.tool { return true }
        return false
    }

    private var isDrawTool: Bool {
        if case .draw = tools.tool { return true }
        return false
    }

    private var isShapeTool: Bool {
        if case .shape = tools.tool { return true }
        return false
    }

    private var isConnectorTool: Bool {
        if case .connector = tools.tool { return true }
        return false
    }

    private func drawIcon(for tool: DrawTool) -> String {
        switch tool {
        case .pen: return "pencil"
        case .pencil: return "pencil.tip"
        case .highlighter: return "highlighter"
        case .eraser: return "eraser"
        }
    }

    private func shapeIcon(for shape: ShapeKind, filled: Bool) -> String {
        switch shape {
        case .rect: return filled ? "square.fill" : "square"
        case .ellipse: return filled ? "circle.fill" : "circle"
        case .triangle: return filled ? "triangle.fill" : "triangle"
        case .diamond: return filled ? "diamond.fill" : "diamond"
        case .hexagon: return filled ? "hexagon.fill" : "hexagon"
        case .star: return filled ? "star.fill" : "star"
        case .arrow: return "arrow.up.right"
        }
    }
}

/// A SwiftUI Color from a hex string ("#1A1A1A" or
/// "1A1A1A"); nil when the hex does not parse.
public extension Color {
    init?(hex: String) {
        let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard cleaned.count == 6, let value = UInt64(cleaned, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255
        let g = Double((value >> 8) & 0xFF) / 255
        let b = Double(value & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}
