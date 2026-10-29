//! The GPUI board view: toolbar, canvas layers, item cards, add/edit bars.
//!
//! Rendering strategy, kept deliberately boring:
//! - a back canvas paints the grid + freehand strokes (low-level paint API),
//! - item cards are ordinary divs positioned absolutely in board space,
//! - a front canvas paints connectors + the marquee on top of the cards,
//! - one transparent interaction div on top owns all mouse/key/drop input,
//!   and hit-testing is done against the model, not the element tree.
//! That keeps one source of truth (the model) for geometry.

use quickboard::model::{Anchor, Board, Camera, Item, ItemId, Kind, Pt, normalise_hex, parse_hex};
use quickboard::preview::{domain_of, parse_preview};
use quickboard::store;
use gpui::prelude::*;
use gpui::{
    AnyWindowHandle, App, Bounds, Context, Div, ExternalPaths, FocusHandle, FontWeight, Hsla,
    MouseButton, PathBuilder, Render, ScrollDelta, SharedString, Styled, Window,
    WindowBounds, WindowKind, WindowOptions, canvas, div, img, point, px, rgb, size,
};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

/// State shared between the board window and the little handle window, so
/// closing/reopening the board never loses the board itself.
pub struct SharedState {
    pub board: RefCell<Board>,
    pub board_window: RefCell<Option<AnyWindowHandle>>,
}

pub type Shared = Rc<SharedState>;

impl SharedState {
    pub fn new(board: Board) -> Shared {
        Rc::new(Self {
            board: RefCell::new(board),
            board_window: RefCell::new(None),
        })
    }
}

const TOOLBAR_H: f32 = 44.0;
const STATUS_H: f32 = 28.0;
const GRID: f32 = 100.0;
const PALETTE: [&str; 6] = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6A4C93", "#2A9D8F"];
const ACCENT: u32 = 0xE63946;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Select,
    Pan,
    Pen,
    Marker,
    Text,
    Connector,
}

impl Tool {
    fn label(self) -> &'static str {
        match self {
            Tool::Select => "Select (V)",
            Tool::Pan => "Pan (Space)",
            Tool::Pen => "Pen (P)",
            Tool::Marker => "Marker (M)",
            Tool::Text => "Text (T)",
            Tool::Connector => "Connector (C)",
        }
    }
}

#[derive(Clone, Debug)]
enum Drag {
    Pan { last: Pt },
    Move { last_world: Pt },
    Stroke { points: Vec<Pt>, marker: bool },
    Connector { from: Anchor, current: Pt },
    Marquee { start: Pt, current: Pt },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AddKind {
    Text,
    Url,
    Swatch,
    ImagePath,
    PdfPath,
}

impl AddKind {
    fn label(self) -> &'static str {
        match self {
            AddKind::Text => "Add text",
            AddKind::Url => "Add link",
            AddKind::Swatch => "Add colour swatch (e.g. #FF6B35)",
            AddKind::ImagePath => "Add image — type or paste a file path",
            AddKind::PdfPath => "Add PDF — type or paste a file path",
        }
    }
}

#[derive(Clone, Debug)]
struct AddPanel {
    kind: AddKind,
    at: Pt,
    input: String,
}

/// Snapshot of what the canvases need, cloned each frame (the board is small).
#[derive(Clone, Debug)]
struct StrokePaint {
    points: Vec<Pt>,
    color: String,
    width: f32,
    marker: bool,
    selected: bool,
}

#[derive(Clone, Debug)]
struct ConnectorPaint {
    from: Pt,
    to: Pt,
    selected: bool,
}

pub struct BoardView {
    pub shared: Shared,
    pub focus_handle: FocusHandle,
    tool: Tool,
    pen_color: String,
    space_down: bool,
    drag: Option<Drag>,
    editing: Option<(ItemId, String)>,
    add_panel: Option<AddPanel>,
    status: String,
    viewport_w: f32,
    viewport_h: f32,
    title_set: bool,
}

impl BoardView {
    pub fn new(shared: Shared, cx: &mut Context<Self>) -> Self {
        Self {
            shared,
            focus_handle: cx.focus_handle(),
            tool: Tool::Select,
            pen_color: PALETTE[0].to_string(),
            space_down: false,
            drag: None,
            editing: None,
            add_panel: None,
            status: "Board auto-saves on every change.".to_string(),
            viewport_w: 1024.0,
            viewport_h: 768.0,
            title_set: false,
        }
    }

    // ----- model helpers -----

    fn with_board<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Board) -> R,
    {
        f(&self.shared.board.borrow())
    }

    fn save(&mut self) {
        let result = {
            let board = self.shared.board.borrow();
            store::save(&board)
        };
        match result {
            Ok(()) => self.status = "Saved.".to_string(),
            Err(e) => self.status = format!("Save failed: {}", e),
        }
    }

    fn camera(&self) -> Camera {
        self.with_board(|b| b.camera)
    }

    fn screen_to_world(&self, screen: Pt) -> Pt {
        self.camera().to_world(screen)
    }

    /// Board-area coordinates: the interaction div sits below the toolbar.
    fn window_to_world(&self, win: Pt) -> Pt {
        self.screen_to_world(Pt::new(win.x, win.y - TOOLBAR_H))
    }

    fn board_centre(&self) -> Pt {
        self.screen_to_world(Pt::new(
            self.viewport_w / 2.0,
            (self.viewport_h - TOOLBAR_H - STATUS_H) / 2.0,
        ))
    }

    fn set_tool(&mut self, tool: Tool) {
        self.tool = tool;
        self.drag = None;
        self.status = format!("Tool: {}", tool.label());
    }

    // ----- URL title fetching (background, never blocks the UI) -----

    fn fetch_url_title(&mut self, id: ItemId, url: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let html = cx
                .background_executor()
                .spawn(async move {
                    ureq::get(&url)
                        .set("User-Agent", "QuickBoard/0.1")
                        .timeout(Duration::from_secs(6))
                        .call()
                        .ok()
                        .and_then(|r| r.into_string().ok())
                })
                .await;
            if let Some(html) = html {
                let (title, description) = parse_preview(&html);
                let _ = this.update(cx, |view, cx| {
                    if let Some(item) = view.shared.board.borrow_mut().get_mut(id) {
                        if let Kind::UrlCard {
                            title: t,
                            description: d,
                            ..
                        } = &mut item.kind
                        {
                            *t = title;
                            *d = description;
                        }
                    }
                    view.save();
                    cx.notify();
                });
            }
        })
        .detach();
    }

    // ----- keyboard -----

    fn handle_key(&mut self, key: &str, key_char: Option<&str>, ctrl: bool, _shift: bool, cx: &mut Context<Self>) {
        // 1. A text field (add panel / editing) eats everything first.
        // (Take-then-act, never borrow the field while replacing it.)
        if self.add_panel.is_some() {
            match key {
                "escape" => self.add_panel = None,
                "enter" => {
                    let panel = self.add_panel.take().unwrap();
                    self.confirm_add(panel, cx);
                }
                "backspace" => {
                    if let Some(panel) = &mut self.add_panel {
                        panel.input.pop();
                    }
                }
                _ => {
                    if let Some(c) = key_char {
                        if c.chars().count() == 1 {
                            if let Some(panel) = &mut self.add_panel {
                                panel.input.push_str(c);
                            }
                        }
                    } else if key == "space" {
                        if let Some(panel) = &mut self.add_panel {
                            panel.input.push(' ');
                        }
                    }
                }
            }
            cx.notify();
            return;
        }
        if self.editing.is_some() {
            match key {
                "escape" => {
                    let (id, text) = self.editing.take().unwrap();
                    self.commit_text_edit(id, text);
                }
                "enter" => {
                    if let Some((_, text)) = &mut self.editing {
                        text.push('\n');
                    }
                }
                "backspace" => {
                    if let Some((_, text)) = &mut self.editing {
                        text.pop();
                    }
                }
                _ => {
                    if let Some(c) = key_char {
                        if c.chars().count() == 1 {
                            if let Some((_, text)) = &mut self.editing {
                                text.push_str(c);
                            }
                        }
                    } else if key == "space" {
                        if let Some((_, text)) = &mut self.editing {
                            text.push(' ');
                        }
                    }
                }
            }
            cx.notify();
            return;
        }

        // 2. Shortcuts.
        match key {
            "v" => self.set_tool(Tool::Select),
            "p" => self.set_tool(Tool::Pen),
            "m" => self.set_tool(Tool::Marker),
            "t" => self.set_tool(Tool::Text),
            "c" => self.set_tool(Tool::Connector),
            "g" if ctrl => {
                let grouped = {
                    let mut b = self.shared.board.borrow_mut();
                    b.group_selection()
                };
                self.status = match grouped {
                    Some(g) => format!("Grouped (group {}).", g),
                    None => "Select 2+ items to group.".to_string(),
                };
                self.save();
            }
            "u" if ctrl => {
                self.shared.board.borrow_mut().ungroup_selection();
                self.status = "Ungrouped.".to_string();
                self.save();
            }
            "backspace" | "delete" => {
                self.shared.board.borrow_mut().delete_selection();
                self.status = "Deleted selection.".to_string();
                self.save();
            }
            "escape" => {
                self.shared.board.borrow_mut().selected.clear();
                self.status = "Selection cleared.".to_string();
            }
            "=" | "+" => self.zoom_centre(1.2),
            "-" => self.zoom_centre(1.0 / 1.2),
            "0" => {
                self.shared.board.borrow_mut().camera = Camera::default();
                self.status = "View reset.".to_string();
                self.save();
            }
            " " | "space" => {
                // Space is handled as a held key (see key up/down), not here.
            }
            _ => {
                if let Some("+") = key_char {
                    self.zoom_centre(1.2);
                } else if let Some("-") = key_char {
                    self.zoom_centre(1.0 / 1.2);
                }
            }
        }
        cx.notify();
    }

    fn zoom_centre(&mut self, factor: f32) {
        let centre = Pt::new(
            self.viewport_w / 2.0,
            (self.viewport_h - TOOLBAR_H - STATUS_H) / 2.0,
        );
        self.shared.board.borrow_mut().camera.zoom_at(centre, factor);
        self.status = format!("Zoom {}%.", (self.camera().zoom * 100.0).round() as i32);
        self.save();
    }

    fn commit_text_edit(&mut self, id: ItemId, text: String) {
        let mut board = self.shared.board.borrow_mut();
        if let Some(item) = board.get_mut(id) {
            if let Kind::Text { text: t, .. } = &mut item.kind {
                *t = text;
                // Re-estimate the box so a longer edit still fits.
                let lines = t.lines().count().max(1) as f32;
                let longest = t.lines().map(|l| l.chars().count()).max().unwrap_or(0) as f32;
                item.size.w = (longest * 9.0 + 24.0).max(120.0);
                item.size.h = (lines * 22.0 + 16.0).max(40.0);
            }
        }
        drop(board);
        self.save();
    }

    fn confirm_add(&mut self, panel: AddPanel, cx: &mut Context<Self>) {
        let input = panel.input.trim().to_string();
        match panel.kind {
            AddKind::Text => {
                if input.is_empty() {
                    self.status = "Nothing typed — no note added.".to_string();
                    return;
                }
                self.shared.board.borrow_mut().add_text(panel.at, &input);
                self.status = "Note added.".to_string();
            }
            AddKind::Url => {
                if input.is_empty() {
                    self.status = "No link typed.".to_string();
                    return;
                }
                let url = if input.contains("://") {
                    input
                } else {
                    format!("https://{}", input)
                };
                let id = self.shared.board.borrow_mut().add_url(panel.at, &url);
                self.status = format!("Link card added for {}.", domain_of(&url));
                self.fetch_url_title(id, url, cx);
            }
            AddKind::Swatch => match normalise_hex(&input) {
                Some(hex) => {
                    self.shared.board.borrow_mut().add_swatch(panel.at, &hex);
                    self.status = format!("Swatch {} added.", hex);
                }
                None => {
                    self.status = "Not a colour — try #FF6B35.".to_string();
                    self.add_panel = Some(AddPanel {
                        input: panel.input,
                        ..panel
                    });
                    return;
                }
            },
            AddKind::ImagePath => {
                let path = std::path::Path::new(&input);
                if !path.is_file() {
                    self.status = format!("No such file: {}", input);
                    self.add_panel = Some(AddPanel {
                        input: panel.input,
                        ..panel
                    });
                    return;
                }
                let (w, h) = image::image_dimensions(path).unwrap_or((320, 240));
                let scale = 320.0 / w.max(1) as f32;
                let (w, h) = if scale < 1.0 {
                    (320.0, h as f32 * scale)
                } else {
                    (w as f32, h as f32)
                };
                self.shared
                    .board
                    .borrow_mut()
                    .add_image(panel.at, &input, w, h);
                self.status = "Image added.".to_string();
            }
            AddKind::PdfPath => {
                let path = std::path::Path::new(&input);
                let is_pdf = path
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("pdf"))
                    .unwrap_or(false);
                if !path.is_file() || !is_pdf {
                    self.status = "That is not a PDF file.".to_string();
                    self.add_panel = Some(AddPanel {
                        input: panel.input,
                        ..panel
                    });
                    return;
                }
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                self.shared.board.borrow_mut().add_pdf(panel.at, &input, size);
                self.status = "PDF card added — double-click it to open.".to_string();
            }
        }
        self.save();
    }

    fn open_external(&mut self, target: &str) {
        #[cfg(target_os = "macos")]
        let opener = "open";
        #[cfg(not(target_os = "macos"))]
        let opener = "xdg-open";
        match std::process::Command::new(opener).arg(target).spawn() {
            Ok(_) => self.status = format!("Opening {}.", target),
            Err(_) => self.status = format!("Could not open {} (no viewer found).", target),
        }
    }

    fn drop_paths(&mut self, paths: &[std::path::PathBuf], at_window: Pt) {
        let mut at = self.window_to_world(at_window);
        let mut added = 0usize;
        let mut skipped = 0usize;
        for path in paths {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let path_str = path.to_string_lossy().to_string();
            match ext.as_str() {
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => {
                    let (w, h) = image::image_dimensions(path).unwrap_or((320, 240));
                    let scale = 320.0 / w.max(1) as f32;
                    let (w, h) = if scale < 1.0 {
                        (320.0, h as f32 * scale)
                    } else {
                        (w as f32, h as f32)
                    };
                    self.shared.board.borrow_mut().add_image(at, &path_str, w, h);
                    added += 1;
                }
                "pdf" => {
                    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                    self.shared.board.borrow_mut().add_pdf(at, &path_str, size);
                    added += 1;
                }
                "txt" | "md" => {
                    if let Ok(text) = std::fs::read_to_string(path) {
                        let text: String = text.chars().take(2000).collect();
                        self.shared.board.borrow_mut().add_text(at, &text);
                        added += 1;
                    } else {
                        skipped += 1;
                    }
                }
                _ => skipped += 1,
            }
            at.x += 24.0;
            at.y += 24.0;
        }
        if added > 0 {
            self.status = format!("Dropped {} item(s) onto the board.", added);
            self.save();
        } else if skipped > 0 {
            self.status = "That file type is not dropped as a board item yet.".to_string();
        }
    }

    // ----- rendering helpers -----

    fn tool_button(&self, label: &str, active: bool) -> Div {
        div()
            .px(px(10.))
            .py(px(6.))
            .text_size(px(13.))
            .bg(if active {
                rgb(0x1A1A1A)
            } else {
                rgb(0xE8E4DC)
            })
            .text_color(if active {
                rgb(0xFFFFFF)
            } else {
                rgb(0x1A1A1A)
            })
            .child(label.to_string())
    }

    fn item_element(&self, item: &Item, selected: bool) -> gpui::AnyElement {
        let cam = self.camera();
        let screen = cam.to_screen(item.pos);
        let w = item.size.w * cam.zoom;
        let h = item.size.h * cam.zoom;
        let border = if selected { rgb(ACCENT) } else { rgb(0xD8D2C8) };
        let base = div()
            .absolute()
            .left(px(screen.x))
            .top(px(screen.y))
            .w(px(w))
            .h(px(h))
            .bg(rgb(0xFFFFFF))
            .border_1()
            .border_color(border);
        let el = match &item.kind {
            Kind::Text {
                text,
                bold,
                size,
                color,
            } => {
                let mut t = base.p(px(8. * cam.zoom)).text_size(px(size * cam.zoom));
                if *bold {
                    t = t.font_weight(FontWeight::BOLD);
                }
                if let Some((r, g, b)) = parse_hex(color) {
                    t = t.text_color(rgb(((r as u32) << 16) | ((g as u32) << 8) | (b as u32)));
                }
                t.child(text.clone())
            }
            Kind::Image { path } => {
                if std::path::Path::new(path).is_file() {
                    base.child(img(path.clone()).w(px(w)).h(px(h)))
                } else {
                    base.p(px(8.)).text_size(px(13.)).child(format!(
                        "Image missing:\n{}",
                        path
                    ))
                }
            }
            Kind::UrlCard {
                url,
                title,
                description,
            } => {
                let domain = domain_of(url);
                let head = title.clone().unwrap_or_else(|| domain.clone());
                let mut card = base.flex().flex_col().p(px(10.));
                card = card.child(
                    div()
                        .text_size(px(13. * cam.zoom.max(0.7)))
                        .font_weight(FontWeight::BOLD)
                        .child(head),
                );
                if let Some(d) = description {
                    if !d.is_empty() {
                        card = card.child(
                            div()
                                .text_size(px(12.))
                                .text_color(rgb(0x666666))
                                .child(d.clone()),
                        );
                    }
                }
                card.child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(0x2E86AB))
                        .child(url.clone()),
                )
            }
            Kind::PdfCard { path, size_bytes } => {
                let name = std::path::Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                let kb = (*size_bytes as f64 / 1024.0).round() as u64;
                base.flex()
                    .flex_col()
                    .p(px(10.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .child(format!("PDF  {}", name)),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(rgb(0x666666))
                            .child(format!("{} KB — double-click to open", kb)),
                    )
            }
            Kind::Swatch { hex } => {
                let (r, g, b) = parse_hex(hex).unwrap_or((0, 0, 0));
                let luminance = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
                let label_color = if luminance > 140.0 {
                    rgb(0x1A1A1A)
                } else {
                    rgb(0xFFFFFF)
                };
                base.bg(rgb(((r as u32) << 16) | ((g as u32) << 8) | (b as u32)))
                    .flex()
                    .items_end()
                    .p(px(8.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(label_color)
                            .child(hex.clone()),
                    )
            }
            Kind::Stroke { .. } | Kind::Connector { .. } => {
                // Painted by the canvases, not as divs.
                return div().into_any_element();
            }
        };
        el.into_any_element()
    }
}

fn hex_to_hsla(hex: &str, alpha: f32) -> Hsla {
    // Approximate: convert sRGB to HSL for the canvas paint API.
    let (r, g, b) = parse_hex(hex).unwrap_or((26, 26, 26));
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f32::EPSILON {
        return Hsla {
            h: 0.0,
            s: 0.0,
            l,
            a: alpha,
        };
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } / 6.0;
    Hsla {
        h,
        s,
        l,
        a: alpha,
    }
}

impl Render for BoardView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.title_set {
            window.set_window_title("QuickBoard");
            self.title_set = true;
        }
        // Keep keyboard focus on the board so shortcuts work after a click.
        if !self.focus_handle.is_focused(window) {
            window.focus(&self.focus_handle);
        }
        let vp = window.viewport_size();
        self.viewport_w = f32::from(vp.width);
        self.viewport_h = f32::from(vp.height);

        let board = self.shared.board.borrow().clone();
        let cam = board.camera;
        let selected = board.selected.clone();
        let tool = self.tool;
        let pen_color = self.pen_color.clone();
        let drag = self.drag.clone();

        // --- back canvas: grid + strokes ---
        let strokes: Vec<StrokePaint> = board
            .items
            .iter()
            .filter_map(|item| match &item.kind {
                Kind::Stroke {
                    points,
                    color,
                    width,
                    marker,
                } => Some(StrokePaint {
                    points: points.clone(),
                    color: color.clone(),
                    width: *width,
                    marker: *marker,
                    selected: selected.contains(&item.id),
                }),
                _ => None,
            })
            .collect();
        let mut live_stroke: Option<StrokePaint> = None;
        if let Some(Drag::Stroke { points, marker }) = &drag {
            live_stroke = Some(StrokePaint {
                points: points.clone(),
                color: pen_color.clone(),
                width: if *marker { 14.0 } else { 3.0 },
                marker: *marker,
                selected: false,
            });
        }
        let back_canvas = canvas(
            move |_bounds, _window, _cx| (),
            move |bounds, _state, window, _cx| {
                let ox = f32::from(bounds.origin.x);
                let oy = f32::from(bounds.origin.y);
                let bw = f32::from(bounds.size.width);
                let bh = f32::from(bounds.size.height);
                // Grid lines every GRID world units.
                let x0 = cam.x;
                let x1 = cam.x + bw / cam.zoom;
                let y0 = cam.y;
                let y1 = cam.y + bh / cam.zoom;
                let mut grid = PathBuilder::stroke(px(1.));
                let mut gx = (x0 / GRID).floor() * GRID;
                while gx <= x1 {
                    let sx = (gx - cam.x) * cam.zoom + ox;
                    grid.move_to(point(px(sx), px(oy)));
                    grid.line_to(point(px(sx), px(oy + bh)));
                    gx += GRID;
                }
                let mut gy = (y0 / GRID).floor() * GRID;
                while gy <= y1 {
                    let sy = (gy - cam.y) * cam.zoom + oy;
                    grid.move_to(point(px(ox), px(sy)));
                    grid.line_to(point(px(ox + bw), px(sy)));
                    gy += GRID;
                }
                if let Ok(path) = grid.build() {
                    window.paint_path(path, Hsla {
                        h: 0.0,
                        s: 0.0,
                        l: 0.85,
                        a: 1.0,
                    });
                }
                // Strokes.
                let mut all = strokes;
                if let Some(live) = live_stroke {
                    all.push(live);
                }
                for stroke in &all {
                    if stroke.points.len() < 2 {
                        continue;
                    }
                    let to_screen = |p: Pt| {
                        point(
                            px((p.x - cam.x) * cam.zoom + ox),
                            px((p.y - cam.y) * cam.zoom + oy),
                        )
                    };
                    if stroke.selected {
                        let mut halo = PathBuilder::stroke(px((stroke.width + 6.0) * cam.zoom));
                        halo.move_to(to_screen(stroke.points[0]));
                        for p in &stroke.points[1..] {
                            halo.line_to(to_screen(*p));
                        }
                        if let Ok(path) = halo.build() {
                            window.paint_path(path, rgb(ACCENT));
                        }
                    }
                    let mut path = PathBuilder::stroke(px(stroke.width * cam.zoom));
                    path.move_to(to_screen(stroke.points[0]));
                    for p in &stroke.points[1..] {
                        path.line_to(to_screen(*p));
                    }
                    if let Ok(path) = path.build() {
                        let alpha = if stroke.marker { 0.45 } else { 1.0 };
                        window.paint_path(path, hex_to_hsla(&stroke.color, alpha));
                    }
                }
            },
        )
        .absolute()
        .left(px(0.))
        .top(px(0.))
        .w_full()
        .h_full();

        // --- front canvas: connectors + marquee + live connector ---
        let connectors: Vec<ConnectorPaint> = board
            .items
            .iter()
            .filter_map(|item| match &item.kind {
                Kind::Connector { from, to, .. } => {
                    let a = board.anchor_point(*from)?;
                    let b = board.anchor_point(*to)?;
                    Some(ConnectorPaint {
                        from: a,
                        to: b,
                        selected: selected.contains(&item.id),
                    })
                }
                _ => None,
            })
            .collect();
        let mut live_connector: Option<(Pt, Pt)> = None;
        if let Some(Drag::Connector { from, current }) = &drag {
            if let Some(a) = board.anchor_point(*from) {
                live_connector = Some((a, *current));
            }
        }
        let marquee_rect: Option<(Pt, Pt)> = match &drag {
            Some(Drag::Marquee { start, current }) => Some((*start, *current)),
            _ => None,
        };
        let front_canvas = canvas(
            move |_bounds, _window, _cx| (),
            move |bounds, _state, window, _cx| {
                let ox = f32::from(bounds.origin.x);
                let oy = f32::from(bounds.origin.y);
                let to_screen = |p: Pt| {
                    point(
                        px((p.x - cam.x) * cam.zoom + ox),
                        px((p.y - cam.y) * cam.zoom + oy),
                    )
                };
                let mut all = connectors;
                if let Some((a, b)) = live_connector {
                    all.push(ConnectorPaint {
                        from: a,
                        to: b,
                        selected: false,
                    });
                }
                for conn in &all {
                    let a = to_screen(conn.from);
                    let b = to_screen(conn.to);
                    let mut path = PathBuilder::stroke(px(if conn.selected { 3. } else { 2. }));
                    path.move_to(a);
                    path.line_to(b);
                    // Arrow head at the end.
                    let dx = f32::from(b.x) - f32::from(a.x);
                    let dy = f32::from(b.y) - f32::from(a.y);
                    let len = (dx * dx + dy * dy).sqrt().max(1.0);
                    let (ux, uy) = (dx / len, dy / len);
                    let head = 12.0;
                    let spread: f32 = 0.45;
                    let (c1, s1) = (spread.cos(), spread.sin());
                    let (c2, s2) = ((-spread).cos(), (-spread).sin());
                    let bx = f32::from(b.x);
                    let by = f32::from(b.y);
                    path.move_to(b);
                    path.line_to(point(px(bx - head * (ux * c1 - uy * s1)), px(by - head * (ux * s1 + uy * c1))));
                    path.move_to(b);
                    path.line_to(point(px(bx - head * (ux * c2 - uy * s2)), px(by - head * (ux * s2 + uy * c2))));
                    if let Ok(path) = path.build() {
                        window.paint_path(
                            path,
                            if conn.selected {
                                rgb(ACCENT)
                            } else {
                                rgb(0x333333)
                            },
                        );
                    }
                }
                if let Some((a, b)) = marquee_rect {
                    let sa = to_screen(a);
                    let sb = to_screen(b);
                    let (x0, x1) = if f32::from(sa.x) < f32::from(sb.x) {
                        (sa.x, sb.x)
                    } else {
                        (sb.x, sa.x)
                    };
                    let (y0, y1) = if f32::from(sa.y) < f32::from(sb.y) {
                        (sa.y, sb.y)
                    } else {
                        (sb.y, sa.y)
                    };
                    let mut path = PathBuilder::stroke(px(1.));
                    path.move_to(point(x0, y0));
                    path.line_to(point(x1, y0));
                    path.line_to(point(x1, y1));
                    path.line_to(point(x0, y1));
                    path.line_to(point(x0, y0));
                    if let Ok(path) = path.build() {
                        window.paint_path(path, rgb(ACCENT));
                    }
                }
            },
        )
        .absolute()
        .left(px(0.))
        .top(px(0.))
        .w_full()
        .h_full();

        // --- item cards ---
        let mut item_els: Vec<gpui::AnyElement> = Vec::new();
        for item in &board.items {
            match &item.kind {
                Kind::Stroke { .. } | Kind::Connector { .. } => {}
                _ => item_els.push(self.item_element(item, selected.contains(&item.id))),
            }
        }

        // --- interaction surface ---
        let interaction = div()
            .absolute()
            .left(px(0.))
            .top(px(0.))
            .w_full()
            .h_full()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, window, cx| {
                    this.focus_handle.focus(window);
                    let win_pt = Pt::new(f32::from(event.position.x), f32::from(event.position.y));
                    // A click while editing a note commits the edit first.
                    if let Some((id, text)) = this.editing.take() {
                        this.commit_text_edit(id, text);
                        cx.notify();
                        return;
                    }
                    if this.add_panel.is_some() {
                        return;
                    }
                    let world = this.window_to_world(win_pt);
                    let effective_tool = if this.space_down {
                        Tool::Pan
                    } else {
                        this.tool
                    };
                    match effective_tool {
                        Tool::Pan => {
                            this.drag = Some(Drag::Pan { last: win_pt });
                        }
                        Tool::Pen | Tool::Marker => {
                            let marker = effective_tool == Tool::Marker;
                            this.drag = Some(Drag::Stroke {
                                points: vec![world],
                                marker,
                            });
                        }
                        Tool::Connector => {
                            let from = this
                                .with_board(|b| b.hit_test(world))
                                .map(Anchor::Item)
                                .unwrap_or(Anchor::Point(world));
                            this.drag = Some(Drag::Connector {
                                from,
                                current: world,
                            });
                        }
                        Tool::Text => {
                            this.add_panel = Some(AddPanel {
                                kind: AddKind::Text,
                                at: world,
                                input: String::new(),
                            });
                        }
                        Tool::Select => {
                            if event.click_count == 2 {
                                if let Some(id) = this.with_board(|b| b.hit_test(world)) {
                                    let kind = this.with_board(|b| {
                                        b.get(id).map(|i| match &i.kind {
                                            Kind::Text { text, .. } => {
                                                format!("text:{}", text)
                                            }
                                            Kind::UrlCard { url, .. } => format!("url:{}", url),
                                            Kind::PdfCard { path, .. } => format!("pdf:{}", path),
                                            Kind::Image { path } => format!("img:{}", path),
                                            _ => String::new(),
                                        })
                                    });
                                    match kind {
                                        Some(k) if k.starts_with("text:") => {
                                            let text = k.trim_start_matches("text:").to_string();
                                            this.editing = Some((id, text));
                                        }
                                        Some(k) if k.starts_with("url:") => {
                                            let url = k.trim_start_matches("url:").to_string();
                                            this.open_external(&url);
                                        }
                                        Some(k) if k.starts_with("pdf:") => {
                                            let path = k.trim_start_matches("pdf:").to_string();
                                            this.open_external(&path);
                                        }
                                        Some(k) if k.starts_with("img:") => {
                                            let path = k.trim_start_matches("img:").to_string();
                                            this.open_external(&path);
                                        }
                                        _ => {}
                                    }
                                }
                                cx.notify();
                                return;
                            }
                            if let Some(id) = this.with_board(|b| b.hit_test(world)) {
                                let additive = event.modifiers.shift;
                                this.shared.board.borrow_mut().select(id, additive);
                                this.drag = Some(Drag::Move { last_world: world });
                            } else {
                                if !event.modifiers.shift {
                                    this.shared.board.borrow_mut().selected.clear();
                                }
                                this.drag = Some(Drag::Marquee {
                                    start: world,
                                    current: world,
                                });
                            }
                        }
                    }
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &gpui::MouseMoveEvent, _window, cx| {
                let win_pt = Pt::new(f32::from(event.position.x), f32::from(event.position.y));
                let world = this.window_to_world(win_pt);
                let zoom = this.camera().zoom;
                match &mut this.drag {
                    Some(Drag::Pan { last }) => {
                        let dx = win_pt.x - last.x;
                        let dy = win_pt.y - last.y;
                        this.shared.board.borrow_mut().camera.pan_by_screen(dx, dy);
                        *last = win_pt;
                    }
                    Some(Drag::Move { last_world }) => {
                        let dx = world.x - last_world.x;
                        let dy = world.y - last_world.y;
                        this.shared.board.borrow_mut().move_selection(dx, dy);
                        *last_world = world;
                    }
                    Some(Drag::Stroke { points, .. }) => {
                        if points.last().map(|p| p.dist(world)).unwrap_or(999.0) > 2.0 / zoom {
                            points.push(world);
                        }
                    }
                    Some(Drag::Connector { current, .. }) => *current = world,
                    Some(Drag::Marquee { current, .. }) => *current = world,
                    None => {}
                }
                cx.notify();
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseUpEvent, _window, cx| {
                    let win_pt = Pt::new(f32::from(event.position.x), f32::from(event.position.y));
                    let world = this.window_to_world(win_pt);
                    match this.drag.take() {
                        Some(Drag::Stroke { points, marker }) => {
                            let color = this.pen_color.clone();
                            let width = if marker { 14.0 } else { 3.0 };
                            if this
                                .shared
                                .board
                                .borrow_mut()
                                .add_stroke(points, &color, width, marker)
                                .is_some()
                            {
                                this.status = "Stroke added.".to_string();
                                this.save();
                            }
                        }
                        Some(Drag::Connector { from, .. }) => {
                            let to = this
                                .with_board(|b| b.hit_test(world))
                                .map(Anchor::Item)
                                .unwrap_or(Anchor::Point(world));
                            let a = this.with_board(|b| b.anchor_point(from));
                            let degenerate = matches!((a, to), (Some(p), Anchor::Point(q)) if p.dist(q) < 4.0);
                            if !degenerate {
                                this.shared.board.borrow_mut().add_connector(from, to);
                                this.status = "Connector added.".to_string();
                                this.save();
                            }
                        }
                        Some(Drag::Marquee { start, .. }) => {
                            let ids = this.with_board(|b| b.marquee(start, world));
                            this.shared.board.borrow_mut().selected = ids;
                            this.status = format!(
                                "{} item(s) selected — Ctrl+G groups them.",
                                this.with_board(|b| b.selected.len())
                            );
                        }
                        Some(Drag::Move { .. }) => {
                            this.save();
                        }
                        _ => {}
                    }
                    cx.notify();
                }),
            )
            .on_scroll_wheel(cx.listener(|this, event: &gpui::ScrollWheelEvent, _window, cx| {
                let win_pt = Pt::new(f32::from(event.position.x), f32::from(event.position.y));
                let delta = match event.delta {
                    ScrollDelta::Pixels(d) => Pt::new(f32::from(d.x), f32::from(d.y)),
                    ScrollDelta::Lines(d) => Pt::new(d.x * 16.0, d.y * 16.0),
                };
                if event.modifiers.control || event.modifiers.platform {
                    let factor = (-delta.y * 0.0015).exp();
                    let screen = Pt::new(win_pt.x, win_pt.y - TOOLBAR_H);
                    this.shared.board.borrow_mut().camera.zoom_at(screen, factor);
                    this.status = format!("Zoom {}%.", (this.camera().zoom * 100.0).round() as i32);
                    this.save();
                } else {
                    this.shared
                        .board
                        .borrow_mut()
                        .camera
                        .pan_by_screen(delta.x, delta.y);
                }
                cx.notify();
            }))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                let mouse = window.mouse_position();
                let at = Pt::new(f32::from(mouse.x), f32::from(mouse.y));
                let owned: Vec<std::path::PathBuf> = paths.paths().to_vec();
                this.drop_paths(&owned, at);
                cx.notify();
            }));

        // --- toolbar ---
        let mut toolbar = div()
            .h(px(TOOLBAR_H))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .px(px(10.))
            // Keep the right end clear of the floating handle pill, which
            // sits over the top-right corner of the display (168 wide + margins).
            .pr(px(200.))
            .bg(rgb(0xE8E4DC));
        toolbar = toolbar.child(
            div()
                .text_size(px(14.))
                .font_weight(FontWeight::BOLD)
                .child("QuickBoard".to_string()),
        );
        for (tool, label) in [
            (Tool::Select, "Select"),
            (Tool::Pan, "Pan"),
            (Tool::Pen, "Pen"),
            (Tool::Marker, "Marker"),
            (Tool::Text, "Text"),
            (Tool::Connector, "Connector"),
        ] {
            let active = tool == self.tool;
            toolbar = toolbar.child(self.tool_button(label, active).id(SharedString::from(format!("tool-{}", label))).on_click(
                cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                    this.set_tool(tool);
                    cx.notify();
                }),
            ));
        }
        toolbar = toolbar.child(div().w(px(12.)));
        for hex in PALETTE {
            let active = self.pen_color == hex;
            let (r, g, b) = parse_hex(hex).unwrap_or((0, 0, 0));
            let swatch = div()
                .w(px(if active { 24. } else { 20. }))
                .h(px(if active { 24. } else { 20. }))
                .bg(rgb(((r as u32) << 16) | ((g as u32) << 8) | (b as u32)))
                .border_1()
                .border_color(if active {
                    rgb(ACCENT)
                } else {
                    rgb(0x999999)
                });
            let hex_owned = hex.to_string();
            toolbar = toolbar.child(swatch.id(SharedString::from(format!("swatch-{}", hex))).on_click(cx.listener(
                move |this, _event: &gpui::ClickEvent, _window, cx| {
                    this.pen_color = hex_owned.clone();
                    cx.notify();
                },
            )));
        }
        toolbar = toolbar.child(div().w(px(12.)));
        for (kind, label) in [
            (AddKind::Text, "+ Note"),
            (AddKind::Url, "+ Link"),
            (AddKind::Swatch, "+ Swatch"),
            (AddKind::ImagePath, "+ Image"),
            (AddKind::PdfPath, "+ PDF"),
        ] {
            let at = self.board_centre();
            toolbar = toolbar.child(self.tool_button(label, false).id(SharedString::from(format!("add-{}", label))).on_click(
                cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                    this.add_panel = Some(AddPanel {
                        kind,
                        at,
                        input: String::new(),
                    });
                    cx.notify();
                }),
            ));
        }
        toolbar = toolbar
            .child(self.tool_button("Group", false).id("btn-group").on_click(cx.listener(
                |this, _event: &gpui::ClickEvent, _window, cx| {
                    let grouped = this.shared.board.borrow_mut().group_selection();
                    this.status = match grouped {
                        Some(g) => format!("Grouped (group {}).", g),
                        None => "Select 2+ items to group.".to_string(),
                    };
                    this.save();
                    cx.notify();
                },
            )))
            .child(self.tool_button("Ungroup", false).id("btn-ungroup").on_click(cx.listener(
                |this, _event: &gpui::ClickEvent, _window, cx| {
                    this.shared.board.borrow_mut().ungroup_selection();
                    this.status = "Ungrouped.".to_string();
                    this.save();
                    cx.notify();
                },
            )))
            .child(self.tool_button("Delete", false).id("btn-delete").on_click(cx.listener(
                |this, _event: &gpui::ClickEvent, _window, cx| {
                    this.shared.board.borrow_mut().delete_selection();
                    this.status = "Deleted selection.".to_string();
                    this.save();
                    cx.notify();
                },
            )))
            .child(self.tool_button("Hide", false).id("btn-hide").on_click(cx.listener(
                |_this, _event: &gpui::ClickEvent, window, cx| {
                    window.minimize_window();
                    cx.notify();
                },
            )));

        // --- board area ---
        let board_area = div()
            .relative()
            .flex_1()
            .bg(rgb(0xF7F5F0))
            .child(back_canvas)
            .children(item_els)
            .child(front_canvas)
            .child(interaction);

        // --- bottom bars ---
        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0xF7F5F0))
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                let key = event.keystroke.key.clone();
                let key_char = event.keystroke.key_char.clone();
                let ctrl = event.keystroke.modifiers.control || event.keystroke.modifiers.platform;
                let shift = event.keystroke.modifiers.shift;
                if key == " " || key == "space" {
                    this.space_down = true;
                }
                // "h" hides the board (minimise); the handle brings it back.
                if key == "h" && this.add_panel.is_none() && this.editing.is_none() {
                    window.minimize_window();
                    cx.notify();
                    return;
                }
                this.handle_key(&key, key_char.as_deref(), ctrl, shift, cx);
            }))
            .on_key_up(cx.listener(|this, event: &gpui::KeyUpEvent, _window, cx| {
                if event.keystroke.key == " " || event.keystroke.key == "space" {
                    this.space_down = false;
                }
                cx.notify();
            }))
            .child(toolbar)
            .child(board_area);

        if let Some(panel) = &self.add_panel {
            let text = if panel.input.is_empty() {
                "Type here…  (Enter to add, Esc to cancel)".to_string()
            } else {
                format!("{}▍", panel.input)
            };
            root = root.child(
                div()
                    .h(px(40.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(12.))
                    .bg(rgb(0xFFF7D6))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .child(panel.kind.label().to_string()),
                    )
                    .child(div().text_size(px(13.)).child(text)),
            );
        } else if let Some((_, text)) = &self.editing {
            root = root.child(
                div()
                    .h(px(40.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(12.))
                    .bg(rgb(0xFFF7D6))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .child("Editing note — Enter = new line, Esc = done".to_string()),
                    )
                    .child(div().text_size(px(13.)).child(format!("{}▍", text))),
            );
        }

        let status_text = format!(
            "{}  ·  {} items  ·  {} selected  ·  zoom {}%  ·  {}",
            self.status,
            board.items.len(),
            board.selected.len(),
            (cam.zoom * 100.0).round() as i32,
            tool.label()
        );
        root = root.child(
            div()
                .h(px(STATUS_H))
                .flex()
                .items_center()
                .px(px(12.))
                .bg(rgb(0xE8E4DC))
                .child(div().text_size(px(12.)).child(status_text)),
        );

        root
    }
}

/// Open the board window and remember its handle on the shared state.
pub fn open_board_window(shared: &Shared, cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    let shared2 = shared.clone();
    let handle = cx.open_window(
        WindowOptions {
            window_bounds: None,
            ..Default::default()
        },
        move |_window, cx| cx.new(|cx| BoardView::new(shared2, cx)),
    )?;
    let any: AnyWindowHandle = handle.into();
    *shared.board_window.borrow_mut() = Some(any);
    Ok(any)
}

/// Open the small corner handle window (a PopUp that sits above other apps).
pub fn open_handle_window(shared: &Shared, cx: &mut App) -> anyhow::Result<()> {
    let display = cx.primary_display();
    let (dx, dy, dw) = match &display {
        Some(d) => {
            let b = d.bounds();
            (
                f32::from(b.origin.x),
                f32::from(b.origin.y),
                f32::from(b.size.width),
            )
        }
        None => (0.0, 0.0, 1440.0),
    };
    let handle_w = 168.0;
    let bounds = Bounds::new(
        point(px(dx + dw - handle_w - 16.0), px(dy + 16.0)),
        size(px(handle_w), px(44.)),
    );
    let shared2 = shared.clone();
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            kind: WindowKind::PopUp,
            ..Default::default()
        },
        move |_window, cx| cx.new(|cx| HandleView::new(shared2, cx)),
    )?;
    Ok(())
}

pub struct HandleView {
    shared: Shared,
    focus_handle: FocusHandle,
    title_set: bool,
}

impl HandleView {
    pub fn new(shared: Shared, cx: &mut Context<Self>) -> Self {
        Self {
            shared,
            focus_handle: cx.focus_handle(),
            title_set: false,
        }
    }
}

impl Render for HandleView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.title_set {
            window.set_window_title("QuickBoard");
            self.title_set = true;
        }
        let shared = self.shared.clone();
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgb(0x1A1A1A))
            .text_color(rgb(0xFFFFFF))
            .text_size(px(13.))
            .font_weight(FontWeight::BOLD)
            .track_focus(&self.focus_handle)
            .id("handle")
            .on_click(cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                // Try to bring the existing board window forward; if it was
                // closed, open a fresh one over the same shared board.
                let existing = *this.shared.board_window.borrow();
                let mut revived = false;
                if let Some(handle) = existing {
                    if handle
                        .update(cx, |_view, window, _cx| {
                            window.activate_window();
                        })
                        .is_ok()
                    {
                        revived = true;
                    }
                }
                if !revived {
                    let _ = open_board_window(&this.shared, cx);
                }
                let _ = &shared;
                cx.notify();
            }))
            .child(SharedString::from("▦  QuickBoard"))
    }
}
