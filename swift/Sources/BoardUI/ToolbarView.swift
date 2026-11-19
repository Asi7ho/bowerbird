import BowerbirdCore
import SwiftUI

/// The floating toolbar, the Electron app's left bar: a
/// vertical column of icon buttons, white and translucent,
/// 16px corners. The select, draw and shape buttons open a
/// flyout with that family's tools; a flyout disappears
/// once a tool is picked. The pen colour swatches sit
/// below the draw button while it is active.
public struct ToolbarView: View {
    @ObservedObject public var tools: ToolState

    public init(tools: ToolState) {
        self.tools = tools
    }

    public var body: some View {
        VStack(spacing: 10) {
            toolButton(icon: selectIcon, label: "Select", active: isSelect) {
                tools.selectShortcut()
            }
            toolButton(icon: drawIcon, label: "Draw", active: isDraw) {
                tools.drawShortcut()
            }
            toolButton(icon: shapeIcon, label: "Shape", active: isShape) {
                tools.shapeShortcut()
            }
            toolButton(icon: "arrow.up.right", label: "Connector", active: isConnector) {
                tools.activate(.connector)
                tools.pickerOpen = nil
            }
            // The colour: a button showing the pen's
            // current colour, opening the palette
            // flyout — like the pen, select and geometry
            // buttons open theirs.
            Button {
                tools.pickerOpen = .color
            } label: {
                Circle()
                    .fill(Color(nsColor: NSColor.fromHex(tools.penColor) ?? .black))
                    .frame(width: 20, height: 20)
                    .frame(width: 40, height: 40)
                    .background(tools.pickerOpen == .color ? Color.black.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .contentShape(Rectangle())
            .accessibilityLabel("Colour")
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .frame(width: 56)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 4)
        // The bar consumes its own background clicks (so
        // they do not fall through to the board, which
        // would close the flyout and clear the selection).
        // This is applied to the bar only, BEFORE the
        // flyout overlay: a content shape here would
        // otherwise shrink the hit area to the bar's own
        // rectangle and the flyout's buttons — offset to
        // the bar's right — would fall through to the
        // board instead of selecting their tool.
        .contentShape(Rectangle())
        .onTapGesture {}
        // The flyout is an overlay, not a sibling: it sits
        // beside the bar without taking part in its layout,
        // so opening or closing it never moves the bar —
        // the bar stays centred and fixed. Its top aligns
        // with the bar's top.
        .overlay(alignment: .topLeading) {
            if let picker = tools.pickerOpen {
                flyout(for: picker)
                    .offset(x: 64)
            }
        }
    }

    private var isSelect: Bool {
        if case .select = tools.tool { return true }
        return false
    }

    private var isDraw: Bool {
        if case .draw = tools.tool { return true }
        return false
    }

    private var isShape: Bool {
        if case .shape = tools.tool { return true }
        return false
    }

    private var isConnector: Bool {
        if case .connector = tools.tool { return true }
        return false
    }

    // Each family button shows the icon of the tool that
    // family is set to — the last one used there — not the
    // family's default. Picking the lasso keeps the lasso
    // on the select button even after switching to another
    // tool, and the same for the pencil and the triangle.
    private var selectIcon: String {
        switch tools.lastSelectMode {
        case .select: return "cursorarrow"
        case .lasso: return "lasso"
        }
    }

    private var drawIcon: String {
        switch tools.lastDrawTool {
        case .pen: return "pencil"
        case .pencil: return "pencil.tip"
        case .highlighter: return "highlighter"
        case .eraser: return "eraser"
        }
    }

    private var shapeIcon: String {
        switch tools.lastShape {
        case .rect: return "square"
        case .ellipse: return "circle"
        case .triangle: return "triangle"
        case .diamond: return "diamond"
        case .hexagon: return "hexagon"
        case .star: return "star"
        case .arrow: return "arrow.up.right"
        }
    }

    private func toolButton(icon: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .frame(width: 40, height: 40)
                .background(active ? Color.black.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(Color.primary)
        }
        .buttonStyle(.plain)
        // The whole 40×40 is the hit area, not just the
        // icon — a click on the button's edge must land.
        .contentShape(Rectangle())
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func flyout(for picker: Picker) -> some View {
        if picker == .color {
            colorFlyout()
        } else if picker == .shape {
            shapeFlyout()
        } else {
            iconFlyout(for: picker)
        }
    }

    /// The geometry flyout: a Filled / Outline switch at
    /// the top, then the six shapes. The switch stays open
    /// when tapped (so the shape can be picked after it);
    /// picking a shape closes the flyout.
    private func shapeFlyout() -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 4) {
                fillModeButton(icon: "square.fill", label: "Filled", active: !tools.shapeOutline) {
                    tools.shapeOutline = false
                }
                fillModeButton(icon: "square", label: "Outline", active: tools.shapeOutline) {
                    tools.shapeOutline = true
                }
            }
            Divider()
            ForEach(ShapeKind.allCases.filter { $0 != .arrow }, id: \.self) { shape in
                toolButton(
                    icon: shapeIcon(for: shape),
                    label: shape.rawValue.capitalized,
                    active: tools.tool == .shape(shape),
                    action: {
                        tools.activate(.shape(shape))
                        tools.pickerOpen = nil
                    }
                )
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .frame(width: 56)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 4)
        // Like the bar, the flyout consumes clicks on its
        // own background so they do not reach the board.
        .contentShape(Rectangle())
        .onTapGesture {}
    }

    private func fillModeButton(icon: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .frame(width: 18, height: 18)
                .background(active ? Color.black.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                .foregroundStyle(Color.primary)
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel(label)
    }

    /// The colour flyout: the palette as coloured circles,
    /// not icons.
    private func colorFlyout() -> some View {
        VStack(spacing: 10) {
            ForEach(ToolState.palette, id: \.self) { hex in
                Button {
                    tools.penColor = hex
                    tools.pickerOpen = nil
                } label: {
                    Circle()
                        .fill(Color(nsColor: NSColor.fromHex(hex) ?? .black))
                        .frame(width: 20, height: 20)
                        .frame(width: 40, height: 40)
                        .background(tools.penColor == hex ? Color.black.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
                .accessibilityLabel(hex)
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .frame(width: 56)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 4)
        // Like the bar, the flyout consumes clicks on its
        // own background so they do not reach the board.
        .contentShape(Rectangle())
        .onTapGesture {}
    }

    /// The icon flyout: the select and draw families, as
    /// icon buttons. (The shape family has its own flyout
    /// with the Filled / Outline switch.)
    private func iconFlyout(for picker: Picker) -> some View {
        let options: [(icon: String, label: String, active: Bool, pick: () -> Void)] = {
            switch picker {
            case .select:
                return [
                    ("cursorarrow", "Select", tools.tool == .select(.select), {
                        tools.activate(.select(.select))
                        tools.pickerOpen = nil
                    }),
                    ("lasso", "Lasso", tools.tool == .select(.lasso), {
                        tools.activate(.select(.lasso))
                        tools.pickerOpen = nil
                    }),
                ]
            case .draw:
                return [
                    ("pencil", "Pen", tools.tool == .draw(.pen), {
                        tools.activate(.draw(.pen))
                        tools.pickerOpen = nil
                    }),
                    ("pencil.tip", "Pencil", tools.tool == .draw(.pencil), {
                        tools.activate(.draw(.pencil))
                        tools.pickerOpen = nil
                    }),
                    ("highlighter", "Highlighter", tools.tool == .draw(.highlighter), {
                        tools.activate(.draw(.highlighter))
                        tools.pickerOpen = nil
                    }),
                    ("eraser", "Eraser", tools.tool == .draw(.eraser), {
                        tools.activate(.draw(.eraser))
                        tools.pickerOpen = nil
                    }),
                ]
            case .shape, .color:
                return []
            }
        }()
        return VStack(spacing: 10) {
            ForEach(options, id: \.label) { option in
                toolButton(icon: option.icon, label: option.label, active: option.active, action: option.pick)
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .frame(width: 56)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 4)
        // Like the bar, the flyout consumes clicks on its
        // own background so they do not reach the board.
        .contentShape(Rectangle())
        .onTapGesture {}
    }

    private func shapeIcon(for shape: ShapeKind) -> String {
        switch shape {
        case .rect: return "square"
        case .ellipse: return "circle"
        case .triangle: return "triangle"
        case .diamond: return "diamond"
        case .hexagon: return "hexagon"
        case .star: return "star"
        case .arrow: return "arrow.up.right"
        }
    }
}
