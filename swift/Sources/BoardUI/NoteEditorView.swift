import AppKit

/// The in-place text editor for a note: an NSTextView placed
/// over the text card, showing its text at its size and
/// colour, on the note's background. Escape commits the
/// edit (it resigns first responder, which ends editing);
/// leaving the field (a click elsewhere) commits it too.
/// The commit carries the text; the viewport decides
/// whether to save it or remove the note when it is empty.
public final class NoteEditorView: NSTextView {
    /// Called once, with the text, when editing ends.
    public var onEndEditing: ((String) -> Void)?
    /// Called whenever the user actually changes the text
    /// (a keystroke, a paste, a delete) — not when the
    /// editor is only opened or closed. The viewport uses
    /// it to tell a note the user emptied from one the
    /// editor never showed: an edit that ends empty
    /// without a single change did not come from the user.
    public var onTextChanged: (() -> Void)?

    private var didEnd = false

    /// The editor's designated initializer, written out
    /// explicitly — it must not be left to the compiler.
    /// The editor used to define only `init()`, which
    /// called `super.init(frame:)`; AppKit's convenience
    /// initializer re-enters the designated
    /// `init(frame:textContainer:)` on the subclass, and
    /// the stub Swift generated for it trapped with
    /// EXC_BREAKPOINT on every double-click that opened
    /// an editor (crash 2026-11-20: startTextEdit →
    /// NoteEditorView.init → the generated stub). Owning
    /// the designated initializer makes the chain one
    /// straight call: `init()` → this → super.
    public override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
        // A plain text editor: no rich text, no
        // substitutions, wrapping at the view's width.
        isRichText = false
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        isFieldEditor = false
        drawsBackground = true
        textContainer?.widthTracksTextView = true
        textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textContainerInset = NSSize(width: 14, height: 14)
        delegate = self
    }

    public convenience init() {
        self.init(frame: .zero, textContainer: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("NoteEditorView is not Interface Builder backed")
    }

    override public func cancelOperation(_ sender: Any?) {
        // Escape commits the edit: resigning first responder
        // ends editing, which calls textDidEndEditing once.
        window?.makeFirstResponder(nil)
    }

    override public func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        // The editor is a subview of its card; when the
        // card is culled (panned off-screen) the editor
        // leaves the window with it. Committing here keeps
        // the typed text instead of losing it.
        if newWindow == nil {
            endEditingOnce()
        }
    }

    private func endEditingOnce() {
        guard !didEnd else { return }
        didEnd = true
        onEndEditing?(string)
    }
}

extension NoteEditorView: NSTextViewDelegate {
    public func textDidEndEditing(_ notification: Notification) {
        endEditingOnce()
    }

    public func textDidChange(_ notification: Notification) {
        onTextChanged?()
    }
}
