import AppKit
import BowerbirdCore
import Combine
import SwiftUI

/// The floating toolbar, as AppKit: a vertical column of
/// icon buttons, white and translucent, 16px corners — the
/// same bar as before, with the same flyouts. It used to
/// be SwiftUI Buttons, and taps took several clicks to
/// land, at random; two rounds of gesture fixes did not
/// cure it. Every other button in this app is an AppKit
/// NSButton (the note colour bar's swatches, the media
/// play buttons) and none of them ever missed a click, so
/// the toolbar is one now too. The look and the behaviour
/// are unchanged: the select, draw and shape buttons open
/// a flyout with that family's tools; tapping the same
/// button again closes its flyout; picking a tool closes
/// the flyout; the pen colour is a button showing the
/// current colour, opening the palette flyout.
public final class ToolbarNSView: NSView {
    /// The bar's size: 56 wide, 5 buttons of 40 with 10px
    /// gaps and 12px of vertical padding.
    public static let barSize = NSSize(width: 56, height: 264)
    /// A button's size, and the gap between buttons.
    private static let buttonSize: CGFloat = 40
    private static let gap: CGFloat = 10
    private static let verticalPad: CGFloat = 12
    private static let horizontalPad: CGFloat = 8
    /// The flyout sits 64px to the right of the bar's
    /// left edge, its top aligned with the bar's top.
    private static let flyoutX: CGFloat = 64

    private let tools: ToolState
    private var cancellable: AnyCancellable?

    private let backgroundEffect = NSVisualEffectView()
    private var barButtons: [(button: NSButton, role: String)] = []
    /// The flyout panels, one per picker, built once and
    /// shown or hidden as the picker opens and closes.
    private var flyouts: [Picker: NSView] = [:]
    /// Every button in every flyout, for the active state.
    private var flyoutButtons: [NSButton] = []

    public init(tools: ToolState) {
        self.tools = tools
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor
        layer?.borderWidth = 1
        layer?.shadowColor = NSColor.black.withAlphaComponent(0.15).cgColor
        layer?.shadowRadius = 12
        layer?.shadowOffset = NSSize(width: 0, height: -4)
        backgroundEffect.material = .popover
        backgroundEffect.blendingMode = .withinWindow
        backgroundEffect.state = .active
        backgroundEffect.wantsLayer = true
        backgroundEffect.layer?.cornerRadius = 16
        backgroundEffect.layer?.masksToBounds = true
        addSubview(backgroundEffect)

        barButtons = [
            (makeButton(identifier: "family.select", label: "Select", action: #selector(barClicked(_:))), "family.select"),
            (makeButton(identifier: "family.draw", label: "Draw", action: #selector(barClicked(_:))), "family.draw"),
            (makeButton(identifier: "family.shape", label: "Shape", action: #selector(barClicked(_:))), "family.shape"),
            (makeButton(identifier: "connector", label: "Connector", action: #selector(barClicked(_:))), "connector"),
            (makeButton(identifier: "color", label: "Colour", action: #selector(barClicked(_:))), "color"),
        ]
        for (button, _) in barButtons { addSubview(button) }

        flyouts[.select] = makeIconFlyout(picker: .select, options: [
            ("cursorarrow", "Select", "pick.select.select"),
            ("lasso", "Lasso", "pick.select.lasso"),
        ])
        flyouts[.draw] = makeIconFlyout(picker: .draw, options: [
            ("pencil", "Pen", "pick.draw.pen"),
            ("pencil.tip", "Pencil", "pick.draw.pencil"),
            ("highlighter", "Highlighter", "pick.draw.highlighter"),
            ("eraser", "Eraser", "pick.draw.eraser"),
        ])
        flyouts[.shape] = makeShapeFlyout()
        flyouts[.color] = makeColorFlyout()
        for flyout in flyouts.values {
            flyout.isHidden = true
            addSubview(flyout)
        }

        // The tool can change without a click on the bar
        // (a shortcut), so the bar refreshes whenever the
        // toolbar state changes — on the next runloop turn,
        // once the new tool is in place (objectWillChange
        // fires before the change).
        cancellable = tools.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.refresh() }
        }
        refresh()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("ToolbarNSView is not Interface Builder backed")
    }

    override public func layout() {
        super.layout()
        backgroundEffect.frame = bounds
        var y = bounds.height - Self.verticalPad - Self.buttonSize
        for (button, _) in barButtons {
            button.frame = NSRect(x: Self.horizontalPad, y: y, width: Self.buttonSize, height: Self.buttonSize)
            y -= Self.buttonSize + Self.gap
        }
        for (picker, flyout) in flyouts {
            let height = Self.flyoutHeight(for: picker)
            flyout.frame = NSRect(x: Self.flyoutX, y: bounds.height - height, width: flyout.bounds.width, height: height)
        }
    }

    /// A flyout panel's height: 12px of padding top and
    /// bottom, 40px rows, 10px gaps.
    private static func flyoutHeight(for picker: Picker) -> CGFloat {
        let rows: CGFloat
        switch picker {
        case .select: rows = 2
        case .draw: rows = 4
        case .shape, .color: rows = 6
        }
        return verticalPad * 2 + rows * buttonSize + (rows - 1) * gap
    }

    /// A click on a flyout button sticks out of the bar's
    /// bounds, so the default hit test — which only looks
    /// inside the bar — would miss it and the click would
    /// fall through to the board. The open flyout is
    /// checked first, then the bar itself.
    override public func hitTest(_ point: NSPoint) -> NSView? {
        if let picker = tools.pickerOpen, let flyout = flyouts[picker], !flyout.isHidden {
            let converted = convert(point, to: flyout)
            if let hit = flyout.hitTest(converted) { return hit }
        }
        return super.hitTest(point)
    }

    // MARK: - Building

    /// A 40×40 icon button: no border, the icon centred,
    /// a quiet black fill when active.
    private func makeButton(identifier: String, label: String, action: Selector) -> NSButton {
        let button = NSButton()
        button.title = ""
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 10
        button.imageScaling = .scaleProportionallyDown
        button.contentTintColor = .labelColor
        button.target = self
        button.action = action
        button.identifier = NSUserInterfaceItemIdentifier(identifier)
        button.setAccessibilityLabel(label)
        return button
    }

    /// A system symbol at 18pt, keeping its aspect ratio.
    private static func symbolImage(_ name: String) -> NSImage? {
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
        let size = image.size
        guard size.height > 0 else { return image }
        let scale = 18 / size.height
        image.size = NSSize(width: size.width * scale, height: 18)
        return image
    }

    /// A 20px circle in a hex colour, for the colour
    /// button and the palette flyout.
    private static func colourImage(hex: String) -> NSImage {
        let size = NSSize(width: 20, height: 20)
        let image = NSImage(size: size)
        image.lockFocus()
        (NSColor.fromHex(hex) ?? .black).setFill()
        NSBezierPath(ovalIn: NSRect(origin: .zero, size: size)).fill()
        image.unlockFocus()
        return image
    }

    /// A flyout panel: the same translucent bar treatment
    /// as the toolbar itself, with buttons stacked in it.
    private func makePanel(width: CGFloat) -> NSView {
        let panel = NSView()
        panel.wantsLayer = true
        panel.layer?.cornerRadius = 16
        panel.layer?.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor
        panel.layer?.borderWidth = 1
        panel.layer?.shadowColor = NSColor.black.withAlphaComponent(0.15).cgColor
        panel.layer?.shadowRadius = 12
        panel.layer?.shadowOffset = NSSize(width: 0, height: -4)
        let effect = NSVisualEffectView()
        effect.material = .popover
        effect.blendingMode = .withinWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 16
        effect.layer?.masksToBounds = true
        effect.autoresizingMask = [.width, .height]
        panel.addSubview(effect)
        panel.frame.size.width = width
        return panel
    }

    /// An icon flyout: one column of icon buttons (the
    /// select and draw families).
    private func makeIconFlyout(picker: Picker, options: [(icon: String, label: String, identifier: String)]) -> NSView {
        let panel = makePanel(width: Self.barSize.width)
        var y = Self.flyoutHeight(for: picker) - Self.verticalPad - Self.buttonSize
        for option in options {
            let button = makeButton(identifier: option.identifier, label: option.label, action: #selector(flyoutClicked(_:)))
            button.image = Self.symbolImage(option.icon)
            button.frame = NSRect(x: Self.horizontalPad, y: y, width: Self.buttonSize, height: Self.buttonSize)
            panel.addSubview(button)
            flyoutButtons.append(button)
            y -= Self.buttonSize + Self.gap
        }
        return panel
    }

    /// The geometry flyout: two columns side by side —
    /// the filled version of each shape on the left, the
    /// outline version on the right. Picking a shape sets
    /// the fill mode from its column and closes the flyout.
    private func makeShapeFlyout() -> NSView {
        let width: CGFloat = Self.horizontalPad * 2 + Self.buttonSize * 2 + Self.gap
        let panel = makePanel(width: width)
        let height = Self.flyoutHeight(for: .shape)
        for (column, filled) in [(0, true), (1, false)] {
            var y = height - Self.verticalPad - Self.buttonSize
            for shape in ShapeKind.allCases.filter({ $0 != .arrow }) {
                let identifier = "pick.shape.\(shape.rawValue).\(filled ? "filled" : "outline")"
                let button = makeButton(
                    identifier: identifier,
                    label: shape.rawValue.capitalized + (filled ? " filled" : " outline"),
                    action: #selector(flyoutClicked(_:))
                )
                button.image = Self.symbolImage(shapeIcon(for: shape, filled: filled))
                button.frame = NSRect(
                    x: Self.horizontalPad + CGFloat(column) * (Self.buttonSize + Self.gap),
                    y: y, width: Self.buttonSize, height: Self.buttonSize
                )
                panel.addSubview(button)
                flyoutButtons.append(button)
                y -= Self.buttonSize + Self.gap
            }
        }
        return panel
    }

    /// The colour flyout: the palette as coloured circles.
    private func makeColorFlyout() -> NSView {
        let panel = makePanel(width: Self.barSize.width)
        var y = Self.flyoutHeight(for: .color) - Self.verticalPad - Self.buttonSize
        for hex in ToolState.palette {
            let button = makeButton(identifier: "pick.color.\(hex)", label: hex, action: #selector(flyoutClicked(_:)))
            button.image = Self.colourImage(hex: hex)
            button.frame = NSRect(x: Self.horizontalPad, y: y, width: Self.buttonSize, height: Self.buttonSize)
            panel.addSubview(button)
            flyoutButtons.append(button)
            y -= Self.buttonSize + Self.gap
        }
        return panel
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

    // MARK: - Refresh

    /// Brings the bar up to date with the toolbar state:
    /// the family buttons show their last-used tool's
    /// icon, the active family and the active pick are
    /// filled, the colour button shows the pen colour, and
    /// only the open flyout shows.
    private func refresh() {
        for (button, role) in barButtons {
            switch role {
            case "family.select":
                button.image = Self.symbolImage(tools.lastSelectMode == .lasso ? "lasso" : "cursorarrow")
                setActive(button, active: isSelect)
            case "family.draw":
                button.image = Self.symbolImage(drawIcon(for: tools.lastDrawTool))
                setActive(button, active: isDraw)
            case "family.shape":
                button.image = Self.symbolImage(shapeIcon(for: tools.lastShape, filled: !tools.shapeOutline))
                setActive(button, active: isShape)
            case "connector":
                button.image = Self.symbolImage("arrow.up.right")
                setActive(button, active: isConnector)
            case "color":
                button.image = Self.colourImage(hex: tools.penColor)
                setActive(button, active: tools.pickerOpen == .color)
            default:
                break
            }
        }
        for button in flyoutButtons {
            setActive(button, active: isFlyoutActive(button))
        }
        for (picker, flyout) in flyouts {
            flyout.isHidden = tools.pickerOpen != picker
        }
        needsLayout = true
    }

    private func setActive(_ button: NSButton, active: Bool) {
        button.layer?.backgroundColor = active
            ? NSColor.black.withAlphaComponent(0.08).cgColor
            : NSColor.clear.cgColor
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

    private func drawIcon(for tool: DrawTool) -> String {
        switch tool {
        case .pen: return "pencil"
        case .pencil: return "pencil.tip"
        case .highlighter: return "highlighter"
        case .eraser: return "eraser"
        }
    }

    /// Whether a flyout button is the active pick: the
    /// exact tool, and for a shape the column's fill mode.
    private func isFlyoutActive(_ button: NSButton) -> Bool {
        let id = button.identifier?.rawValue ?? ""
        switch id {
        case "pick.select.select": return tools.tool == .select(.select)
        case "pick.select.lasso": return tools.tool == .select(.lasso)
        case "pick.draw.pen": return tools.tool == .draw(.pen)
        case "pick.draw.pencil": return tools.tool == .draw(.pencil)
        case "pick.draw.highlighter": return tools.tool == .draw(.highlighter)
        case "pick.draw.eraser": return tools.tool == .draw(.eraser)
        default:
            if id.hasPrefix("pick.shape.") {
                let parts = id.split(separator: ".")
                guard parts.count == 4, let shape = ShapeKind(rawValue: String(parts[2])) else { return false }
                return tools.tool == .shape(shape) && tools.shapeOutline == (parts[3] == "outline")
            }
            if id.hasPrefix("pick.color.") {
                return tools.penColor == String(id.dropFirst("pick.color.".count))
            }
            return false
        }
    }

    // MARK: - Actions

    /// A family button tap: if that family's flyout is
    /// already open, close it; otherwise select the
    /// family's last-used tool and open the flyout. A
    /// repeat tap used to be a visible no-op, which read
    /// as "the click didn't work".
    @objc private func barClicked(_ sender: NSButton) {
        switch sender.identifier?.rawValue {
        case "family.select": toggleFamily(.select) { tools.selectShortcut() }
        case "family.draw": toggleFamily(.draw) { tools.drawShortcut() }
        case "family.shape": toggleFamily(.shape) { tools.shapeShortcut() }
        case "connector":
            tools.activate(.connector)
            tools.pickerOpen = nil
        case "color":
            tools.pickerOpen = tools.pickerOpen == .color ? nil : .color
        default:
            break
        }
    }

    private func toggleFamily(_ picker: Picker, activate: () -> Void) {
        if tools.pickerOpen == picker {
            tools.pickerOpen = nil
        } else {
            activate()
        }
    }

    /// A flyout pick: activate the tool and close the
    /// flyout. A shape pick sets the fill mode from its
    /// column first; a colour pick sets the pen colour.
    @objc private func flyoutClicked(_ sender: NSButton) {
        let id = sender.identifier?.rawValue ?? ""
        switch id {
        case "pick.select.select":
            tools.activate(.select(.select))
        case "pick.select.lasso":
            tools.activate(.select(.lasso))
        case "pick.draw.pen":
            tools.activate(.draw(.pen))
        case "pick.draw.pencil":
            tools.activate(.draw(.pencil))
        case "pick.draw.highlighter":
            tools.activate(.draw(.highlighter))
        case "pick.draw.eraser":
            tools.activate(.draw(.eraser))
        default:
            if id.hasPrefix("pick.shape.") {
                let parts = id.split(separator: ".")
                if parts.count == 4, let shape = ShapeKind(rawValue: String(parts[2])) {
                    tools.shapeOutline = parts[3] == "outline"
                    tools.activate(.shape(shape))
                }
            } else if id.hasPrefix("pick.color.") {
                tools.penColor = String(id.dropFirst("pick.color.".count))
            } else {
                return
            }
        }
        tools.pickerOpen = nil
    }
}

/// The toolbar's SwiftUI host: a transparent container
/// exactly big enough to hold the bar and the flyout that
/// sticks out of it (the flyout reaches 64px right of the
/// bar and 50px below it, so the container is 170×364
/// with the bar centred in it), so the bar sits where it
/// always did — centred on the board's left edge, 12px in.
/// Clicks on the container's empty area fall through to
/// the board: the container only claims a click when it
/// lands on the bar or the open flyout.
public struct ToolbarHostView: NSViewRepresentable {
    @ObservedObject public var tools: ToolState

    public init(tools: ToolState) {
        self.tools = tools
    }

    public func makeNSView(context: Context) -> ToolbarContainerView {
        let container = ToolbarContainerView()
        let toolbar = ToolbarNSView(tools: tools)
        container.toolbar = toolbar
        container.addSubview(toolbar)
        // The bar centred in the container: the container
        // is 364 tall, the bar 264, so 50px of flyout
        // overhang sits below it and none above.
        toolbar.frame = NSRect(x: 0, y: 50, width: ToolbarNSView.barSize.width, height: ToolbarNSView.barSize.height)
        return container
    }

    public func updateNSView(_ container: ToolbarContainerView, context: Context) {
        // The toolbar observes the tools itself; nothing
        // to push here.
    }
}

/// The container for the AppKit toolbar: transparent, and
/// click-through everywhere except the bar and the open
/// flyout, so the board under it stays clickable.
public final class ToolbarContainerView: NSView {
    public var toolbar: ToolbarNSView?

    override public func hitTest(_ point: NSPoint) -> NSView? {
        guard let toolbar else { return nil }
        let converted = convert(point, to: toolbar)
        return toolbar.hitTest(converted)
    }
}
