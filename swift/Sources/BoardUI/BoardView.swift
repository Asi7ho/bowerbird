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
    @ObservedObject public var tools: ToolState
    @ObservedObject public var editorState: NoteEditorState

    public init(store: BoardStore, tools: ToolState, editorState: NoteEditorState) {
        self.store = store
        self.tools = tools
        self.editorState = editorState
    }

    public func makeNSView(context: Context) -> BoardViewport {
        let viewport = BoardViewport(board: store.board)
        viewport.toolState = tools
        viewport.editorState = editorState
        // The toolbar is SwiftUI, over the board in
        // ContentView — not an AppKit subview of the
        // viewport. The AppKit bar never reliably received
        // clicks on a real Mac.
        let host = CardHost(container: viewport.cardContainer, board: store.board, camera: store.board.camera)
        context.coordinator.host = host
        // The board the viewport last committed to the
        // store, so updateNSView can tell a viewport that
        // is running ahead (a silent add, a live drag)
        // from one that is in step with the store.
        let coordinator = context.coordinator
        coordinator.lastCommitted = store.board
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
        viewport.onBoardMutate = { [weak store, weak coordinator] board in
            coordinator?.lastCommitted = board
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
        viewport.onFilesDropped = { [weak store] files in
            guard let store else { return }
            // The first file lands at the drop point; the
            // importer cascades the rest from it.
            guard let first = files.first else { return }
            BoardDrop.importFiles(files.map { $0.0 }, at: first.1, store: store)
        }
        return viewport
    }

    public func updateNSView(_ viewport: BoardViewport, context: Context) {
        // Only the content (items, ids, groups, background,
        // grid) is pushed as a new board — and only when
        // the viewport has nothing uncommitted. A silent
        // add (a new note waiting for its first text) or a
        // live drag (a resize mutating the board until
        // pointerup) runs ahead of the store, and pushing
        // the store's older board over it would undo the
        // edit in progress: a double-clicked note vanishing
        // before its editor opened. The coordinator
        // remembers the last board the viewport committed;
        // while the viewport matches it, the store is the
        // source of truth (an undo, a restore, a poster
        // fill landing), and a camera-only change must not
        // re-render the cards (the host's reposition
        // handles the camera alone, and a full render on
        // every pan would reconfigure every card).
        // The camera is pushed on its own when it differs.
        let hasUncommitted = context.coordinator.lastCommitted.map {
            BoardSnapshot(board: viewport.board) != BoardSnapshot(board: $0)
        } ?? false
        if !hasUncommitted,
           BoardSnapshot(board: store.board) != BoardSnapshot(board: viewport.board) {
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
        /// The board the viewport last committed to the
        /// store (through onBoardMutate). The viewport's
        /// board can run ahead of it — a silent add, a
        /// live drag — and updateNSView must not push the
        /// store's older board over an edit in progress.
        var lastCommitted: Board?
    }
}
