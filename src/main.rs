//! QuickBoard entry point.
//!
//! Two windows:
//! - the board itself (a normal window, auto-saved to disk),
//! - a small dark handle in the top-right corner of the primary display.
//!   It is a PopUp window, so it stays visible above other apps: clicking it
//!   brings the board forward, and the board's Hide button (or `h`) minimises
//!   it back to just the handle. That is the v0.1 form of "swipe to a corner /
//!   hotkey / desktop handle reveals the canvas": a system-wide global hotkey
//!   needs OS-level accessibility hooks on macOS and is deliberately not
//!   faked here — see README.md.

mod ui;

use gpui::{App, Application};
use quickboard::store;
use ui::{SharedState, open_board_window, open_handle_window};

fn main() {
    let board = store::load();
    let shared = SharedState::new(board);
    Application::new().run(move |cx: &mut App| {
        match open_board_window(&shared, cx) {
            Ok(_) => {}
            Err(e) => eprintln!("QuickBoard: could not open board window: {}", e),
        }
        if let Err(e) = open_handle_window(&shared, cx) {
            eprintln!("QuickBoard: could not open handle window: {}", e);
        }
        cx.activate(true);
    });
}
