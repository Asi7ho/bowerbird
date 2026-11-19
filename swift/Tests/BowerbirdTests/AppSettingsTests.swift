import XCTest
@testable import BowerbirdCore

final class AppSettingsTests: XCTestCase {
    private func makeUserDataDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bowerbird-settings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testSettingsDefaultAndRoundTrip() throws {
        let dir = try makeUserDataDir()
        let store = AppSettingsStore(userDataDir: dir)
        XCTAssertEqual(store.load(), .default)
        var settings = AppSettings.default
        settings.corner = "top-left"
        settings.panelWidth = 320
        XCTAssertTrue(store.save(settings))
        XCTAssertEqual(store.load(), settings)
    }

    func testCorruptSettingsReadAsDefault() throws {
        let dir = try makeUserDataDir()
        try "not json".write(to: dir.appendingPathComponent("settings.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(AppSettingsStore(userDataDir: dir).load(), .default)
    }

    func testPluginEnabledDefaultsToTrue() throws {
        let dir = try makeUserDataDir()
        let state = PluginState(userDataDir: dir)
        XCTAssertTrue(state.isEnabled("core-board"))
        XCTAssertTrue(state.setEnabled("core-board", enabled: false))
        XCTAssertFalse(state.isEnabled("core-board"))
        XCTAssertTrue(state.isEnabled("core-search"))
    }

    func testPluginStorageRoundTrip() throws {
        let dir = try makeUserDataDir()
        let state = PluginState(userDataDir: dir)
        XCTAssertNil(state.storageGet(pluginId: "p", key: "k"))
        XCTAssertTrue(state.storageSet(pluginId: "p", key: "k", value: .string("v")))
        XCTAssertEqual(state.storageGet(pluginId: "p", key: "k"), .string("v"))
        XCTAssertTrue(state.storageDelete(pluginId: "p", key: "k"))
        XCTAssertNil(state.storageGet(pluginId: "p", key: "k"))
    }
}
