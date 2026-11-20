import SwiftUI

/// The text being edited, held in an object so the card
/// (AppKit) can hand a binding to the SwiftUI editor and
/// read the final text back on commit.
public final class NoteEditorModel: ObservableObject {
    @Published public var text: String
    public init(text: String) { self.text = text }
}

/// The in-place note editor, as a SwiftUI view: a text
/// editor filling its card. It is hosted in the card
/// itself (an NSHostingView over the card's bounds), so it
/// is always exactly on the card — no screen coordinates
/// to get wrong. Return is a newline (notes are multiline);
/// Escape or clicking away commits. An NSTextView nested
/// in the board's layer-backed views never reliably took
/// the keyboard, and a SwiftUI field floated over the board
/// never landed on the card, so the editor lives in the
/// card now.
public struct NoteEditorContent: View {
    @Binding var text: String
    var fontSize: CGFloat
    var isBold: Bool
    var textColorHex: String
    var backgroundHex: String
    var onCommit: (String) -> Void
    @FocusState private var focused: Bool
    @State private var wasFocused = false

    public init(text: Binding<String>, fontSize: CGFloat, isBold: Bool, textColorHex: String, backgroundHex: String, onCommit: @escaping (String) -> Void) {
        self._text = text
        self.fontSize = fontSize
        self.isBold = isBold
        self.textColorHex = textColorHex
        self.backgroundHex = backgroundHex
        self.onCommit = onCommit
    }

    public var body: some View {
        TextEditor(text: $text)
            .font(.system(size: fontSize, weight: isBold ? .bold : .regular))
            .foregroundColor(Color(hex: textColorHex) ?? Color.black)
            .scrollContentBackground(.hidden)
            .background(Color(hex: backgroundHex) ?? Color.white)
            .padding(14)
            .focused($focused)
            .onAppear { focused = true }
            .onExitCommand { onCommit(text) }
            .onChange(of: focused) { _, newValue in
                if newValue {
                    wasFocused = true
                } else if wasFocused {
                    wasFocused = false
                    onCommit(text)
                }
            }
    }
}
