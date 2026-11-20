import SwiftUI

/// Which note (if any) is being edited, shared between
/// the AppKit viewport (which knows when an edit starts
/// and ends) and the SwiftUI overlay (which draws the
/// editor). The overlay positions the editor from the
/// board model itself — the note's world position and the
/// camera — so no AppKit frame has to be converted into
/// SwiftUI coordinates. The draft text lives here too, so
/// typing does not touch the board until the edit commits
/// (one undo step).
public final class NoteEditingState: ObservableObject {
    @Published public var editingNoteId: Int?
    @Published public var draftText = ""

    /// Called with the final text when the edit commits.
    public var onCommit: ((String) -> Void)?

    public init() {}
}
