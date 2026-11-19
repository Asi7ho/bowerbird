import Foundation

/// The app's settings (userData/settings.json): the window
/// corner the peek icon sits in, the dock panel order and
/// width, whether the dock is visible. A missing or invalid
/// file reads as the defaults.
public struct AppSettings: Codable, Equatable {
    public var corner: String
    public var panelOrder: [String]?
    public var panelWidth: Double?
    public var dockVisible: Bool?

    public static let `default` = AppSettings(corner: "bottom-right", panelOrder: nil, panelWidth: nil, dockVisible: nil)

    public init(corner: String, panelOrder: [String]?, panelWidth: Double?, dockVisible: Bool?) {
        self.corner = corner
        self.panelOrder = panelOrder
        self.panelWidth = panelWidth
        self.dockVisible = dockVisible
    }
}

/// The settings store: one JSONStore over the userData dir.
public struct AppSettingsStore {
    private let store: JSONStore<AppSettings>

    public init(userDataDir: URL) {
        self.store = JSONStore(url: userDataDir.appendingPathComponent("settings.json"), defaultValue: .default)
    }

    public func load() -> AppSettings {
        store.load()
    }

    @discardableResult
    public func save(_ settings: AppSettings) -> Bool {
        store.save(settings)
    }
}
