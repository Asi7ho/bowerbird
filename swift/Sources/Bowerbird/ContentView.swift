import SwiftUI
import AppKit
import BoardUI
import BowerbirdCore

/// The board window's content: the board viewport, filling
/// the window. Toolbars, panels and the palette (M2/M3/M6)
/// are SwiftUI around it.
public struct ContentView: View {
    public var board: Board
    public var onCameraChanged: ((Camera) -> Void)?

    public init(board: Board, onCameraChanged: ((Camera) -> Void)? = nil) {
        self.board = board
        self.onCameraChanged = onCameraChanged
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
            TitleBarView(background: NSColor.fromHex(board.bg) ?? NSColor.white)
                .frame(height: 28)
            Divider()
            BoardView(board: board, onCameraChanged: onCameraChanged)
                .frame(minWidth: 800, minHeight: 600)
        }
    }
}
