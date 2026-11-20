import SwiftUI

/// The in-place note editor's state, shared between the
/// AppKit viewport (which knows when a note is opened for
/// editing, and where its card is) and the SwiftUI overlay
/// (which draws the text field). The editor is a SwiftUI
/// TextField: an NSTextView nested in the board's
/// layer-backed views never reliably took the keyboard.
/// The viewport sets the text and the card's screen frame
/// when an edit starts; the overlay shows the field there,
/// focuses it, and calls back to commit on Escape or focus
/// loss (Return is a newline — notes are multiline).
public final class NoteEditorState: ObservableObject {
    @Published public var isEditing = false
    @Published public var text = ""
    @Published public var frame: CGRect = .zero
    /// The text size on screen (the note's size scaled by
    /// the zoom), its weight, and the note's colours.
    @Published public var fontSize: CGFloat = 16
    @Published public var isBold = false
    @Published public var textColorHex = "#1A1A1A"
    @Published public var backgroundHex = "#FFFFFF"

    /// Called with the final text when the edit commits.
    public var onCommit: ((String) -> Void)?

    public init() {}
}
