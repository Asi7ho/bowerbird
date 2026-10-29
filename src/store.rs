//! Persistence: one JSON file, auto-saved on every change.
//!
//! Default location honours XDG_DATA_HOME, else ~/.local/share/bowerbird/.
//! `BOWERBIRD_BOARD_PATH` overrides it (used by tests and by anyone who
//! wants a portable board file); the old `QB_BOARD_PATH` still works.
//! A board left in the pre-rename `quickboard` folder is still read
//! from there, so renaming never orphans an existing board. A corrupt
//! file never wipes the board: loading falls back to the welcome board
//! and keeps the bad file untouched.

use crate::model::{Board, Kind};
use std::path::{Path, PathBuf};

/// Folder next to the board file holding the board's own copies of
/// dropped files. Items point at these copies, never at the user's
/// originals, so deleting an original cannot break the board.
pub fn assets_dir_for(board_path: &Path) -> PathBuf {
    board_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("assets")
}

/// Copy `source` into the board's assets folder and return the copy's
/// path. A file already inside the folder is returned as-is. Names are
/// sanitised and made unique (`name`, `name-2`, `name-3`, ...) so two
/// drops of the same filename never overwrite each other.
pub fn embed_file(board_path: &Path, source: &Path) -> anyhow::Result<PathBuf> {
    let dir = assets_dir_for(board_path);
    if source.starts_with(&dir) {
        return Ok(source.to_path_buf());
    }
    std::fs::create_dir_all(&dir)?;
    let raw_name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let stem = sanitise_asset_name(
        Path::new(&raw_name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string()),
    );
    let ext = Path::new(&raw_name)
        .extension()
        .map(|e| sanitise_asset_name(e.to_string_lossy().to_string()))
        .filter(|e| !e.is_empty());
    let mut candidate = match &ext {
        Some(ext) => dir.join(format!("{stem}.{ext}")),
        None => dir.join(&stem),
    };
    let mut n = 2;
    while candidate.exists() {
        candidate = match &ext {
            Some(ext) => dir.join(format!("{stem}-{n}.{ext}")),
            None => dir.join(format!("{stem}-{n}")),
        };
        n += 1;
    }
    std::fs::copy(source, &candidate)?;
    Ok(candidate)
}

fn sanitise_asset_name(name: String) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    while out.starts_with('.') {
        out.remove(0);
    }
    // ASCII-only by construction, so byte truncation is safe.
    out.truncate(64);
    if out.is_empty() {
        out = "file".to_string();
    }
    out
}

/// Migrate a loaded board: every image/PDF/audio/local-video item
/// pointing at a file outside the assets folder is copied in and
/// repointed. Returns how many items moved. Missing files are left
/// alone — already broken, nothing to copy.
pub fn embed_board_files(board: &mut Board, board_path: &Path) -> usize {
    let dir = assets_dir_for(board_path);
    let mut migrated = 0;
    for item in &mut board.items {
        let slot = match &mut item.kind {
            Kind::Image { path } => Some(path),
            Kind::PdfCard { path, .. } => Some(path),
            Kind::Audio { path } => Some(path),
            Kind::Video { source, remote, .. } => {
                if *remote {
                    None
                } else {
                    Some(source)
                }
            }
            _ => None,
        };
        if let Some(path_str) = slot {
            let src = PathBuf::from(path_str.clone());
            if src.starts_with(&dir) || !src.is_file() {
                continue;
            }
            if let Ok(stored) = embed_file(board_path, &src) {
                *path_str = stored.to_string_lossy().to_string();
                migrated += 1;
            }
        }
    }
    migrated
}

pub fn board_path() -> PathBuf {
    for var in ["BOWERBIRD_BOARD_PATH", "QB_BOARD_PATH"] {
        if let Ok(p) = std::env::var(var) {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".local").join("share")))
        .unwrap_or_else(|| PathBuf::from("."));
    let new = base.join("bowerbird").join("board.json");
    let old = base.join("quickboard").join("board.json");
    // Prefer the new folder, but keep reading a pre-rename board from
    // the old one rather than starting fresh and orphaning it.
    if !new.exists() && old.exists() {
        return old;
    }
    new
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

    #[test]
    fn embed_file_copies_sanitises_and_uniquifies() {
        let dir = std::env::temp_dir().join(format!("qb-test-embed-{}", std::process::id()));
        let board_path = dir.join("board.json");
        let orig = dir.join("orig");
        std::fs::create_dir_all(&orig).unwrap();
        let src = orig.join("my photo!.png");
        std::fs::write(&src, [1, 2, 3]).unwrap();
        let stored = embed_file(&board_path, &src).unwrap();
        assert!(stored.starts_with(dir.join("assets")));
        assert_eq!(stored.file_name().unwrap(), "my_photo_.png");
        assert_eq!(std::fs::read(&stored).unwrap(), vec![1, 2, 3]);
        // Same filename from elsewhere gets a -2 suffix, never an overwrite.
        let orig2 = dir.join("orig2");
        std::fs::create_dir_all(&orig2).unwrap();
        let src2 = orig2.join("my photo!.png");
        std::fs::write(&src2, [4, 5]).unwrap();
        let stored2 = embed_file(&board_path, &src2).unwrap();
        assert_eq!(stored2.file_name().unwrap(), "my_photo_-2.png");
        assert_eq!(std::fs::read(&stored2).unwrap(), vec![4, 5]);
        // A file already inside the assets folder is returned as-is.
        assert_eq!(embed_file(&board_path, &stored).unwrap(), stored);
        // A missing source is an error for the caller to fall back from.
        assert!(embed_file(&board_path, &dir.join("nope.png")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn embed_board_files_migrates_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("qb-test-migrate-{}", std::process::id()));
        let board_path = dir.join("board.json");
        let orig = dir.join("orig");
        std::fs::create_dir_all(&orig).unwrap();
        let src = orig.join("pic.png");
        std::fs::write(&src, [9, 9]).unwrap();
        let mut b = Board::new();
        b.add_image(Pt::new(0.0, 0.0), &src.to_string_lossy(), 100.0, 100.0);
        b.add_audio(Pt::new(0.0, 0.0), &dir.join("gone.wav").to_string_lossy());
        b.add_video(Pt::new(0.0, 0.0), "https://example.com/v.mp4", true, 0);
        assert_eq!(embed_board_files(&mut b, &board_path), 1);
        match &b.items[0].kind {
            Kind::Image { path } => {
                assert!(Path::new(path).starts_with(dir.join("assets")));
                assert_eq!(std::fs::read(path).unwrap(), vec![9, 9]);
            }
            _ => panic!("first item should still be the image"),
        }
        // Missing files and remote videos are untouched.
        match &b.items[1].kind {
            Kind::Audio { path } => assert!(path.ends_with("gone.wav")),
            _ => panic!("second item should still be audio"),
        }
        // Second run migrates nothing: already inside the assets folder.
        assert_eq!(embed_board_files(&mut b, &board_path), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
