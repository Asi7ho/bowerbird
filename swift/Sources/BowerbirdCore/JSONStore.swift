import Foundation

/// A JSON file holding one Codable value. Reads return the
/// default when the file is missing or invalid (a corrupt
/// settings file must never stop the app starting); writes
/// go via tmp + rename, like a board save.
public struct JSONStore<Value: Codable> {
    public let url: URL
    public let defaultValue: Value

    public init(url: URL, defaultValue: Value) {
        self.url = url
        self.defaultValue = defaultValue
    }

    public func load() -> Value {
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode(Value.self, from: data) else { return defaultValue }
        return value
    }

    @discardableResult
    public func save(_ value: Value) -> Bool {
        guard let data = try? JSONEncoder().encode(value) else { return false }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let tmp = url.appendingPathExtension("tmp")
            try data.write(to: tmp, options: .atomic)
            try? FileManager.default.removeItem(at: url)
            try FileManager.default.moveItem(at: tmp, to: url)
            return true
        } catch {
            return false
        }
    }
}
