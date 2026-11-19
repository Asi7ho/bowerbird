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
        HStack(alignment: .top, spacing: 8) {
            VStack(spacing: 10) {
                toolButton(icon: "cursorarrow", label: "Select", active: isSelect) {
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

            if let picker = tools.pickerOpen {
                flyout(for: picker)
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

    private var drawIcon: String {
        guard case .draw(let draw) = tools.tool else { return "pencil" }
        switch draw {
        case .pen: return "pencil"
        case .pencil: return "pencil.tip"
        case .highlighter: return "highlighter"
        case .eraser: return "eraser"
        }
    }

    private var shapeIcon: String {
        guard case .shape(let shape) = tools.tool else { return "square" }
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

    private func toolButton(icon: String, label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .frame(width: 40, height: 40)
                .background(active ? Color.black.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func flyout(for picker: Picker) -> some View {
        // The colour flyout shows the palette as coloured
        // circles, not icons — it is rendered on its own.
        if picker == .color {
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
            return
        }
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
            case .shape:
                // The arrow is not offered here: the
                // toolbar already has it as the connector
                // (the A tool), so the shape family is the
                // six shapes.
                return ShapeKind.allCases.filter { $0 != .arrow }.map { shape in
                    (shapeIcon(for: shape), shape.rawValue.capitalized, tools.tool == .shape(shape), {
                        tools.activate(.shape(shape))
                        tools.pickerOpen = nil
                    })
                }
            case .color:
                return []
            }
        }()
        VStack(spacing: 10) {
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
