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
    @ObservedObject var model: NoteEditorModel
    var fontSize: CGFloat
    var isBold: Bool
    var textColorHex: String
    var backgroundHex: String
    /// The padding, in screen points: the card's 14 world
    /// points scaled by the zoom, like the card's own text
    /// layer (its inset is 14 times the zoom). A fixed 14
    /// ate the card when dezoomed — at the user's zoom the
    /// card is only 25 points tall, so 14 top and bottom
    /// left no room at all for the text, and typing in a
    /// new note showed only a white box until the edit was
    /// left and the card's own layer drew the text.
    var padding: CGFloat
    var onCommit: (String) -> Void
    /// Called live as the text changes, so a new note's
    /// card can grow with what is typed.
    var onTextChange: ((String) -> Void)?
    @FocusState private var focused: Bool
    @State private var wasFocused = false

    public init(model: NoteEditorModel, fontSize: CGFloat, isBold: Bool, textColorHex: String, backgroundHex: String, padding: CGFloat, onCommit: @escaping (String) -> Void, onTextChange: ((String) -> Void)? = nil) {
        self.model = model
        self.fontSize = fontSize
        self.isBold = isBold
        self.textColorHex = textColorHex
        self.backgroundHex = backgroundHex
        self.padding = padding
        self.onCommit = onCommit
        self.onTextChange = onTextChange
    }

    public var body: some View {
        TextEditor(text: $model.text)
            .font(.system(size: fontSize, weight: isBold ? .bold : .regular))
            .foregroundColor(Color(hex: textColorHex) ?? Color.black)
            .scrollContentBackground(.hidden)
            .background(Color(hex: backgroundHex) ?? Color.white)
            .padding(padding)
            .focused($focused)
            .onAppear { focused = true }
            .onExitCommand { onCommit(model.text) }
            .onChange(of: focused) { _, newValue in
                if newValue {
                    wasFocused = true
                } else if wasFocused {
                    wasFocused = false
                    onCommit(model.text)
                }
            }
            .onChange(of: model.text) { _, newValue in
                onTextChange?(newValue)
            }
    }
}
