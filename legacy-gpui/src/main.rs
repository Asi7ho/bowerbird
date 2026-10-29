//! Bowerbird entry point.
//!
//! One window: the board itself (a normal window, auto-saved to disk).
//! `h` (or the OS minimise control) hides it; it stays alive in the
//! Dock / taskbar, which brings it back. A corner-swipe reveal would
//! need a system-wide mouse monitor (OS accessibility hooks on macOS),
//! which GPUI does not provide, so it is deliberately not faked here.

mod ui;

use gpui::{App, Application};
use bowerbird::store;
use ui::{SharedState, open_board_window};

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
        bowerbird::model::Board::welcome_showcase(&image_path, &pdf_path, pdf_bytes)
    } else {
        store::load()
    };
    let shared = SharedState::new(board);
    Application::new().run(move |cx: &mut App| {
        if let Err(e) = open_board_window(&shared, cx) {
            eprintln!("Bowerbird: could not open board window: {}", e);
        }
        cx.activate(true);
    });
}
