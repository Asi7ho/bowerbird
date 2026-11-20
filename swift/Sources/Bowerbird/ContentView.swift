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
    @StateObject private var editorState = NoteEditorState()
    @FocusState private var editorFocused: Bool
    @State private var editorWasFocused = false

    public init(store: BoardStore) {
        self.store = store
    }

    /// Commits the open note edit (through the viewport's
    /// callback, which saves or removes the note). Guarded
    /// so a second call after the first commit does nothing.
    private func commitEditor() {
        guard editorState.isEditing else { return }
        editorState.onCommit?(editorState.text)
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
                BoardView(store: store, tools: tools, editorState: editorState)
                    .frame(minWidth: 800, minHeight: 600)
                    // The in-place note editor: a SwiftUI text
                    // field over the card being edited, at the
                    // card's screen frame, in its size and
                    // colours. It is an overlay on the board
                    // (top-leading, so its top-left is the
                    // card's top-left and it grows downward
                    // as lines are added — a fixed height
                    // clipped the new line, so Return looked
                    // like it did nothing). It is SwiftUI
                    // because an NSTextView nested in the
                    // board's layer-backed views never
                    // reliably took the keyboard. Return is a
                    // newline (notes are multiline); Escape
                    // or clicking away commits. It wears the
                    // card's own chrome (hairline border,
                    // radius) so it reads as the card, not a
                    // floating box.
                    .overlay(alignment: .topLeading) {
                        if editorState.isEditing {
                            TextField("", text: $editorState.text, axis: .vertical)
                                .font(.system(size: editorState.fontSize, weight: editorState.isBold ? .bold : .regular))
                                .foregroundColor(Color(hex: editorState.textColorHex) ?? Color.black)
                                .textFieldStyle(.plain)
                                .padding(14)
                                .background(Color(hex: editorState.backgroundHex) ?? Color.white)
                                .cornerRadius(12)
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.black.opacity(0.08), lineWidth: 1))
                                .frame(width: editorState.frame.width)
                                .frame(minHeight: editorState.frame.height, alignment: .top)
                                .offset(x: editorState.frame.minX, y: editorState.frame.minY)
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
