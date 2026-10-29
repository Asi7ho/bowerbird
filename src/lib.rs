//! QuickBoard library: the board model, link previews and persistence.
//!
//! Kept free of GPUI on purpose, so `cargo test --lib` verifies the core
//! without a display or a GPU — the UI in the binary is a thin view over
//! this.

pub mod audio;
pub mod model;
pub mod preview;
pub mod store;
