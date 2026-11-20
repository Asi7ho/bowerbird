import BowerbirdCore
import SwiftUI

/// The floating toolbar, the Electron app's left bar: a
/// vertical column of icon buttons, white and translucent,
/// 16px corners. The select, draw and shape buttons open a
/// flyout with that family's tools; tapping the same button
/// again closes its flyout. Picking a tool closes the
/// flyout. The pen colour is a button showing the current
/// colour, opening the palette flyout.
public struct ToolbarView: View {
    @ObservedObject public var tools: ToolState

    public init(tools: ToolState) {
        self.tools = tools
    }

    public var body: some View {
        VStack(spacing: 10) {
            toolButton(icon: selectIcon, label: "Select", active: isSelect) {
                toggleFamily(.select) { tools.selectShortcut() }
            }
            toolButton(icon: drawIcon, label: "Draw", active: isDraw) {
                toggleFamily(.draw) { tools.drawShortcut() }
            }
            toolButton(icon: shapeIcon, label: "Shape", active: isShape) {
                toggleFamily(.shape) { tools.shapeShortcut() }
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
                tools.pickerOpen = tools.pickerOpen == .color ? nil : .color
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
        // The background consumes clicks on the bar's empty
        // area so they do not fall through to the board
        // (which would close the flyout and clear the
        // selection). There is no TapGesture anywhere in
        // this toolbar: a gesture on a container competes
        // with the buttons' taps in SwiftUI's arbitration
        // and steals some of them at random — that was the
        // "several clicks to select a tool" bug, twice.
        // The background is a no-op Button behind the
        // buttons instead: a tap on a button hits the
        // button first, and only a tap on the empty
        // background reaches this button.
        .background(barBackground())
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 4)
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

    /// The shape button keeps the icon of the last shape
    /// used, in its filled or outline form, even when
    /// another family is active.
    private var shapeIcon: String {
        shapeIcon(for: tools.lastShape, filled: !tools.shapeOutline)
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

    /// The bar and flyout background: a no-op Button
    /// behind the buttons, claiming taps on the empty
    /// area so they never fall through to the board.
    /// (See the bar above for why this is a Button and
    /// not a TapGesture.)
    private func barBackground() -> some View {
        Button(action: {}) {
            RoundedRectangle(cornerRadius: 16)
                .fill(.ultraThinMaterial)
        }
        .buttonStyle(.plain)
        .accessibilityHidden(true)
    }

    /// A family button tap: if that family's flyout is
    /// already open, close it; otherwise select the
    /// family's last-used tool and open the flyout. A
    /// repeat tap used to be a visible no-op, which read
    /// as "the click didn't work".
    private func toggleFamily(_ picker: Picker, activate: () -> Void) {
        if tools.pickerOpen == picker {
            tools.pickerOpen = nil
        } else {
            activate()
        }
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

    /// The geometry flyout: two columns side by side —
    /// the filled version of each shape on the left, the
    /// outline version on the right. Picking a shape sets
    /// the fill mode from its column and closes the flyout.
    private func shapeFlyout() -> some View {
        HStack(spacing: 10) {
            shapeColumn(filled: true)
            shapeColumn(filled: false)
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .background(barBackground())
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 4)
    }

    private func shapeColumn(filled: Bool) -> some View {
        VStack(spacing: 10) {
            ForEach(ShapeKind.allCases.filter { $0 != .arrow }, id: \.self) { shape in
                toolButton(
                    icon: shapeIcon(for: shape, filled: filled),
                    label: shape.rawValue.capitalized + (filled ? " filled" : " outline"),
                    active: tools.tool == .shape(shape) && tools.shapeOutline == !filled,
                    action: {
                        tools.shapeOutline = !filled
                        tools.activate(.shape(shape))
                        tools.pickerOpen = nil
                    }
                )
            }
        }
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
        .background(barBackground())
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 4)
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
        .background(barBackground())
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 12, x: 0, y: 4)
    }

    private func shapeIcon(for shape: ShapeKind, filled: Bool = false) -> String {
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
