import AppKit
import SwiftUI
import BowerbirdCore

@main
struct BowerbirdApp: App {
    /// The board, owned by the app. The store is the only
    /// thing that writes board.json; the window's content
    /// renders it (M2). Save on quit is a synchronous flush
    /// (see BoardStore.saveSync): a board that did not change
    /// is not written, so quitting can never overwrite a
    /// restore with the stale board it replaced.
    private let store: BoardStore?

    init() {
        let url = BoardPaths.default().boardPath(for: nil)
        self.store = try? BoardStore(boardURL: url)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    _ = store?.saveSync()
                }
        }
        .windowStyle(.titleBar)
    }
}
