import SwiftUI
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
        BoardView(board: board, onCameraChanged: onCameraChanged)
            .frame(minWidth: 800, minHeight: 600)
    }
}
