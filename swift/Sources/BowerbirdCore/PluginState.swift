import Foundation

/// Plugin state (userData/plugins.json and
/// plugin-storage.json), mirroring the Electron app:
/// - plugins.json is `{enabled: {"id": true}}` — a plugin
///   is enabled unless its entry is explicitly false;
/// - plugin-storage.json is per-plugin key-value storage,
///   keyed by plugin id, then by key.
public struct PluginState {
    private let enabledStore: JSONStore<EnabledMap>
    private let storageStore: JSONStore<[String: [String: JSONValue]]>

    public struct EnabledMap: Codable, Equatable {
        public var enabled: [String: Bool]

        public init(enabled: [String: Bool] = [:]) {
            self.enabled = enabled
        }
    }

    public init(userDataDir: URL) {
        self.enabledStore = JSONStore(
            url: userDataDir.appendingPathComponent("plugins.json"),
            defaultValue: EnabledMap()
        )
        self.storageStore = JSONStore(
            url: userDataDir.appendingPathComponent("plugin-storage.json"),
            defaultValue: [:]
        )
    }

    /// Whether a plugin is enabled: true unless its entry
    /// is explicitly false. A missing entry is enabled.
    public func isEnabled(_ pluginId: String) -> Bool {
        enabledStore.load().enabled[pluginId] != false
    }

    @discardableResult
    public func setEnabled(_ pluginId: String, enabled: Bool) -> Bool {
        var map = enabledStore.load()
        map.enabled[pluginId] = enabled
        return enabledStore.save(map)
    }

    public func storageGet(pluginId: String, key: String) -> JSONValue? {
        storageStore.load()[pluginId]?[key]
    }

    @discardableResult
    public func storageSet(pluginId: String, key: String, value: JSONValue) -> Bool {
        var all = storageStore.load()
        var plugin = all[pluginId] ?? [:]
        plugin[key] = value
        all[pluginId] = plugin
        return storageStore.save(all)
    }

    @discardableResult
    public func storageDelete(pluginId: String, key: String) -> Bool {
        var all = storageStore.load()
        all[pluginId]?.removeValue(forKey: key)
        return storageStore.save(all)
    }
}
