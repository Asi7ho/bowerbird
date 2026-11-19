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
            ContentView(
                board: store?.board ?? BoardStore.emptyBoard(),
                onCameraChanged: { [store] camera in
                    // The camera is part of the board: keep the
                    // store's copy current so a quit flush (or
                    // the next edit's save) persists where the
                    // user was looking. The camera is not saved
                    // on every move — only on quit or on edit.
                    store?.update { $0.camera = camera }
                }
            )
            // The app is light, like the Electron app: a dark
            // system appearance turned the title bar dark
            // brown, so the window is forced light.
            .preferredColorScheme(.light)
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                _ = store?.saveSync()
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
