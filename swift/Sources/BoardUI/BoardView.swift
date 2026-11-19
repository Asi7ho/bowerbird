import SwiftUI
import BowerbirdCore

/// The board, as a SwiftUI view: the AppKit viewport wrapped
/// in `NSViewRepresentable`. SwiftUI is the chrome; the
/// viewport is AppKit (see docs/macos/PLAN.md).
///
/// The store is observed, so a board change (an edit, an
/// undo, a restore) re-renders this view and pushes the new
/// board into the viewport. The viewport owns the live
/// camera while the user pans and zooms; camera changes
/// flow back through the store so they persist.
public struct BoardView: NSViewRepresentable {
    @ObservedObject public var store: BoardStore

    public init(store: BoardStore) {
        self.store = store
    }

    public func makeNSView(context: Context) -> BoardViewport {
        let viewport = BoardViewport(board: store.board)
        let host = CardHost(container: viewport.cardContainer, board: store.board, camera: store.board.camera)
        context.coordinator.host = host
        viewport.onCameraChanged = { [weak host, weak store] camera in
            host?.camera = camera
            // The camera is part of the board: keep the
            // store's copy current so a quit flush (or the
            // next edit's save) persists where the user was
            // looking. The camera is not saved on every move
            // — only on quit or on edit — and it is not an
            // undo step (the snapshot excludes it).
            store?.update { $0.camera = camera }
        }
        viewport.onBoardChanged = { [weak host] board in
            host?.board = board
        }
        viewport.onSelectionChanged = { [weak host] selected in
            host?.selected = selected
        }
        viewport.onViewportResized = { [weak host] in
            host?.render()
        }
        viewport.onBoardMutate = { [weak store] board in
            store?.update { $0 = board }
            store?.save()
        }
        viewport.onUndo = { [weak store] in
            _ = store?.undo()
        }
        viewport.onRedo = { [weak store] in
            _ = store?.redo()
        }
        viewport.onDragMove = { [weak host] ids, delta in
            host?.moveViews(ids, by: delta)
        }
        return viewport
    }

    public func updateNSView(_ viewport: BoardViewport, context: Context) {
        // Only the content (items, ids, groups, background,
        // grid) is pushed as a new board: a camera-only
        // change must not re-render the cards (the host's
        // reposition handles the camera alone, and a full
        // render on every pan would reconfigure every card).
        // The camera is pushed on its own when it differs.
        if BoardSnapshot(board: store.board) != BoardSnapshot(board: viewport.board) {
            viewport.board = store.board
        }
        if viewport.camera != store.board.camera {
            viewport.camera = store.board.camera
        }
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    public final class Coordinator {
        var host: CardHost?
    }
}
