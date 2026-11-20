import SwiftUI
import AppKit
import BoardUI
import BowerbirdCore

/// The board window's content: the board viewport, filling
/// the window. The toolbar lives inside the viewport (an
/// AppKit subview, like the note colour bar), and the title
/// bar is SwiftUI above it. The store is observed, so a
/// board change (an edit, an undo, a restore) re-renders
/// the viewport through BoardView.
public struct ContentView: View {
    @ObservedObject public var store: BoardStore
    @StateObject private var tools = ToolState()

    public init(store: BoardStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            // The title bar: a light strip at the top, like
            // the Electron app's #title-bar. The system
            // traffic lights sit in it (hiddenTitleBar), and
            // the board starts below it, so a card can never
            // be panned over the traffic lights or the title.
            // The strip is the board's own background colour,
            // not plain white: the board is drawn by Metal
            // from the same hex, and a plain white strip
            // rendered a visibly different white next to it.
            // It is a drag view, not a plain colour: the
            // whole strip moves the window, not just the
            // title bar area the system recognises.
            TitleBarView(background: NSColor.fromHex(store.board.bg) ?? NSColor.white)
                .frame(height: 28)
            Divider()
            BoardView(store: store, tools: tools)
                .frame(minWidth: 800, minHeight: 600)
        }
    }
}
