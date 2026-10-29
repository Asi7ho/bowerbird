//! Persistence: one JSON file, auto-saved on every change.
//!
//! Default location honours XDG_DATA_HOME, else ~/.local/share/quickboard/.
//! `QB_BOARD_PATH` overrides it (used by tests and by anyone who wants a
//! portable board file). A corrupt file never wipes the board: loading
//! falls back to the welcome board and keeps the bad file untouched.

use crate::model::Board;
use std::path::PathBuf;

pub fn board_path() -> PathBuf {
    if let Ok(p) = std::env::var("QB_BOARD_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".local").join("share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("quickboard").join("board.json")
}

pub fn save(board: &Board) -> anyhow::Result<()> {
    save_to(board, &board_path())
}

pub fn save_to(board: &Board, path: &std::path::Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Write-then-rename so a crash mid-save cannot leave half a board.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, board.to_json()?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load() -> Board {
    load_from(&board_path()).unwrap_or_else(|_| Board::welcome())
}

pub fn load_from(path: &std::path::Path) -> anyhow::Result<Board> {
    let text = std::fs::read_to_string(path)?;
    Board::from_json(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Pt;

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("qb-test-{}", std::process::id()));
        let path = dir.join("board.json");
        let mut b = Board::new();
        b.add_text(Pt::new(1.0, 2.0), "hello");
        save_to(&b, &path).unwrap();
        let back = load_from(&path).unwrap();
        assert_eq!(back.items.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_panic() {
        let dir = std::env::temp_dir().join(format!("qb-test-bad-{}", std::process::id()));
        let path = dir.join("board.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ nope").unwrap();
        assert!(load_from(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
