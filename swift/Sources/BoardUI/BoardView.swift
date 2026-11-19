import SwiftUI
import BowerbirdCore

/// The board, as a SwiftUI view: the AppKit viewport wrapped
/// in `NSViewRepresentable`. SwiftUI is the chrome; the
/// viewport is AppKit (see docs/macos/PLAN.md).
///
/// The board is a snapshot at the time the view is created.
/// The viewport owns the live camera while the user pans
/// and zooms; camera changes flow back through
/// `onCameraChanged` so the store can persist them. Board
/// edits (M3) will drive this view through a shared store
/// instead of a snapshot.
public struct BoardView: NSViewRepresentable {
    public var board: Board
    public var onCameraChanged: ((Camera) -> Void)?

    public init(board: Board, onCameraChanged: ((Camera) -> Void)? = nil) {
        self.board = board
        self.onCameraChanged = onCameraChanged
    }

    public func makeNSView(context: Context) -> BoardViewport {
        let viewport = BoardViewport(board: board)
        let host = CardHost(container: viewport.cardContainer, board: board, camera: board.camera)
        context.coordinator.host = host
        viewport.onCameraChanged = { [weak host] camera in
            host?.camera = camera
            onCameraChanged?(camera)
        }
        viewport.onBoardChanged = { [weak host] board in
            host?.board = board
        }
        viewport.onViewportResized = { [weak host] in
            host?.render()
        }
        return viewport
    }

    public func updateNSView(_ viewport: BoardViewport, context: Context) {
        viewport.board = board
        if viewport.camera != board.camera {
            viewport.camera = board.camera
        }
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    public final class Coordinator {
        var host: CardHost?
    }
}
