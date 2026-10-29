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

/// First-run showcase assets, embedded in the binary and installed next to
/// the board file so the welcome board's picture and PDF are real files that
/// open, whatever directory the app was launched from.
fn install_showcase_assets() -> Option<(String, String, u64)> {
    let dir = store::board_path().parent()?.to_path_buf();
    std::fs::create_dir_all(&dir).ok()?;
    let image_path = dir.join("welcome.png");
    if !image_path.exists() {
        std::fs::write(&image_path, include_bytes!("../assets/welcome.png")).ok()?;
    }
    let pdf_path = dir.join("sample.pdf");
    let pdf_bytes = include_bytes!("../assets/sample.pdf");
    if !pdf_path.exists() {
        std::fs::write(&pdf_path, pdf_bytes).ok()?;
    }
    Some((
        image_path.to_string_lossy().to_string(),
        pdf_path.to_string_lossy().to_string(),
        pdf_bytes.len() as u64,
    ))
}

fn main() {
    // A missing board file means a first run: show the showcase board.
    // (A corrupt file still falls back to the plain welcome board.)
    let board = if store::board_path().exists() {
        let mut board = store::load();
        // Boards from before embedded copies get migrated: surviving
        // originals are copied into the board's assets folder and the
        // items repointed, so deleting an original later is safe.
        if store::embed_board_files(&mut board, &store::board_path()) > 0 {
            let _ = store::save(&board);
        }
        board
    } else if let Some((image_path, pdf_path, pdf_bytes)) = install_showcase_assets() {
        quickboard::model::Board::welcome_showcase(&image_path, &pdf_path, pdf_bytes)
    } else {
        store::load()
    };
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
