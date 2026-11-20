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
    @StateObject private var editingState = NoteEditingState()
    @FocusState private var editorFocused: Bool
    @State private var editorWasFocused = false

    public init(store: BoardStore) {
        self.store = store
    }

    /// Commits the open note edit (through the viewport's
    /// callback, which saves or removes the note). Guarded
    /// so a second call after the first commit does nothing.
    private func commitEditor() {
        guard editingState.editingNoteId != nil else { return }
        editingState.onCommit?(editingState.draftText)
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
            ZStack(alignment: .leading) {
                BoardView(store: store, tools: tools, editingState: editingState)
                    .frame(minWidth: 800, minHeight: 600)
                    // The in-place note editor: a text editor
                    // over the card being edited. Its position
                    // comes from the board itself — the note's
                    // place and the camera — so it sits on the
                    // card wherever the card is, and follows it
                    // while panning or zooming. Return is a new
                    // line (notes are multiline); Escape or
                    // clicking away saves it.
                    .overlay(alignment: .topLeading) {
                        if let id = editingState.editingNoteId,
                           let item = store.board.items.first(where: { $0.id == id }),
                           case .text(let payload) = item.kind {
                            let camera = store.board.camera
                            let x = (item.pos.x - camera.x) * camera.zoom
                            let y = (item.pos.y - camera.y) * camera.zoom
                            let w = item.size.w * camera.zoom
                            let h = item.size.h * camera.zoom
                            TextEditor(text: $editingState.draftText)
                                .font(.system(size: CGFloat(payload.size) * CGFloat(camera.zoom), weight: payload.bold ? .bold : .regular))
                                .foregroundColor(Color(hex: payload.color) ?? Color.black)
                                .scrollContentBackground(.hidden)
                                .background(Color(hex: payload.bg ?? "#FFFFFF") ?? Color.white)
                                .padding(14)
                                .cornerRadius(12)
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.black.opacity(0.08), lineWidth: 1))
                                .frame(width: w)
                                .frame(minHeight: h, alignment: .top)
                                .offset(x: x, y: y)
                                .focused($editorFocused)
                                .onAppear { editorFocused = true }
                                .onExitCommand { commitEditor() }
                                .onChange(of: editorFocused) { _, focused in
                                    if focused {
                                        editorWasFocused = true
                                    } else if editorWasFocused {
                                        editorWasFocused = false
                                        commitEditor()
                                    }
                                }
                        }
                    }
                // The toolbar floats over the board's left
                // edge, vertically centred: a SwiftUI view,
                // so its buttons take clicks natively. (An
                // AppKit bar in the viewport never reliably
                // received clicks on a real Mac.)
                SwiftToolbarView(tools: tools)
                    .padding(.leading, 12)
            }
        }
    }
}
