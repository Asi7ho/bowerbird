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

    /// The zoom shown in the title bar. The board passed
    /// in is a snapshot (the store owns the live copy), so
    /// the readout is state of its own, updated from the
    /// viewport's camera changes — otherwise it would show
    /// the launch zoom forever.
    @State private var zoom: Double

    public init(board: Board, onCameraChanged: ((Camera) -> Void)? = nil) {
        self.board = board
        self.onCameraChanged = onCameraChanged
        self._zoom = State(initialValue: board.camera.zoom)
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
            // The zoom readout sits at the right of the
            // strip: the current zoom as a percentage. It is
            // the pinch diagnostic as much as a readout —
            // pinch and watch the number: if it moves, the
            // pinch reaches the app; if it stays put, the
            // gesture never arrives.
            ZStack(alignment: .trailing) {
                TitleBarView(background: NSColor.fromHex(board.bg) ?? NSColor.white)
                Text("\(Int(zoom * 100))%")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color(nsColor: NSColor.black.withAlphaComponent(0.5)))
                    .padding(.trailing, 12)
            }
            .frame(height: 28)
            Divider()
            BoardView(board: board, onCameraChanged: { camera in
                zoom = camera.zoom
                onCameraChanged?(camera)
            })
                .frame(minWidth: 800, minHeight: 600)
        }
    }
}
