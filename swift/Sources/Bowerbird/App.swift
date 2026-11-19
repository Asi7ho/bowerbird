import AppKit
import SwiftUI
import BowerbirdCore

@main
struct BowerbirdApp: App {
    /// The board, owned by the app and observed. The store
    /// is the only thing that writes board.json; the
    /// window's content renders it, and board edits (M3)
    /// go through the store, so undo, save and the view
    /// stay in sync. Save on quit is a synchronous flush
    /// (see BoardStore.saveSync): a board that did not
    /// change is not written, so quitting can never
    /// overwrite a restore with the stale board it replaced.
    @StateObject private var store: BoardStore

    init() {
        let url = BoardPaths.default().boardPath(for: nil)
        // A fresh board gets the welcome board (its assets
        // and board.json) before the store loads it, so the
        // first launch shows the board, not an empty canvas.
        WelcomeBoardSeeder.seedIfNeeded(boardURL: url)
        _store = StateObject(wrappedValue: BoardStore(boardURL: url))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
            // The app is light, like the Electron app: a dark
            // system appearance turned the title bar dark
            // brown, so the window is forced light.
            .preferredColorScheme(.light)
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                _ = store.saveSync()
            }
        }
        // No standard title bar: the Electron app's window
        // is frameless (`frame: false`) with its own title
        // bar drawn in the page, so the Swift window hides
        // the title the same way — the traffic lights stay,
        // the "Bowerbird" title and the dark bar go.
        .windowStyle(.hiddenTitleBar)
    }
}
