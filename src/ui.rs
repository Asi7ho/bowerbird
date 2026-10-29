//! The GPUI board view: toolbar, canvas layers, item cards, add/edit bars.
//!
//! Rendering strategy, kept deliberately boring:
//! - a back canvas paints the grid + freehand strokes (low-level paint API),
//! - item cards are ordinary divs positioned absolutely in board space,
//! - a front canvas paints connectors + the marquee on top of the cards,
//! - one transparent interaction div on top owns all mouse/key/drop input,
//!   and hit-testing is done against the model, not the element tree.
//! That keeps one source of truth (the model) for geometry.

use quickboard::audio::{AudioPlayer, Playback};
use quickboard::model::{
    Anchor, Board, Camera, GridMode, Item, ItemId, Kind, Pt, normalise_hex, parse_hex,
};
use quickboard::preview::{domain_of, looks_like_video_url, parse_preview};
use quickboard::store;
use gpui::prelude::*;
use gpui::{
    AnyWindowHandle, App, Bounds, BoxShadow, Context, Div, ExternalPaths, FocusHandle, FontWeight,
    Hsla, MouseButton, PathBuilder, Render, ScrollDelta, SharedString, Styled, Window,
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
    /// In-app audio playback; created lazily on first play so a machine
    /// without an audio device never fails at startup.
    pub audio: RefCell<AudioPlayer>,
}

pub type Shared = Rc<SharedState>;

impl SharedState {
    pub fn new(board: Board) -> Shared {
        Rc::new(Self {
            board: RefCell::new(board),
            board_window: RefCell::new(None),
            audio: RefCell::new(AudioPlayer::new()),
        })
    }
}

const TOOLBAR_H: f32 = 52.0;
const GRID: f32 = 100.0;
const PALETTE: [&str; 6] = ["#1A1A1A", "#E63946", "#2E86AB", "#FF6B35", "#6A4C93", "#2A9D8F"];

/// Canvas background choices: name + hex.
const CANVAS_COLORS: [(&str, &str); 5] = [
    ("Paper", "#F7F5F0"),
    ("White", "#FFFFFF"),
    ("Sage", "#EAF3EC"),
    ("Sky", "#EAF2FB"),
    ("Ink", "#23232B"),
];
// macOS system blue: the selection/active accent throughout the app.
const ACCENT: u32 = 0x007AFF;

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
    Resize {
        id: ItemId,
        start_world: Pt,
        orig_w: f32,
        orig_h: f32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AddKind {
    Text,
    Url,
    Swatch,
    ImagePath,
    PdfPath,
    AudioPath,
    VideoPath,
}

impl AddKind {
    fn label(self) -> &'static str {
        match self {
            AddKind::Text => "Add text",
            AddKind::Url => "Add link",
            AddKind::Swatch => "Add colour swatch (e.g. #FF6B35)",
            AddKind::ImagePath => "Add image — type or paste a file path",
            AddKind::PdfPath => "Add PDF — type or paste a file path",
            AddKind::AudioPath => "Add audio — type or paste a file path",
            AddKind::VideoPath => "Add video — type or paste a file path",
        }
    }
}

#[derive(Clone, Debug)]
struct AddPanel {
    kind: AddKind,
    at: Pt,
    input: String,
}

// ----- toolbar icons: small vector glyphs drawn with the canvas API -----
//
// Deliberately font-independent: no emoji, no symbol font, so the toolbar
// looks the same on macOS (San Francisco) and Linux (DejaVu/Noto) with no
// tofu boxes for missing glyphs. Every icon is drawn in a 20x20 box.

#[derive(Clone, Copy, PartialEq, Eq)]
enum Icon {
    Select,
    Pan,
    Pen,
    Marker,
    Text,
    Connector,
    Note,
    Link,
    Swatch,
    Image,
    Pdf,
    Audio,
    Video,
    Play,
    Pause,
    Stop,
    Group,
    Ungroup,
    Delete,
    Hide,
    Tune,
    GridLines,
    GridDots,
    GridOff,
    Close,
    Plus,
}

impl Tool {
    fn icon(self) -> Icon {
        match self {
            Tool::Select => Icon::Select,
            Tool::Pan => Icon::Pan,
            Tool::Pen => Icon::Pen,
            Tool::Marker => Icon::Marker,
            Tool::Text => Icon::Text,
            Tool::Connector => Icon::Connector,
        }
    }
}

impl AddKind {
    fn icon(self) -> Icon {
        match self {
            AddKind::Text => Icon::Note,
            AddKind::Url => Icon::Link,
            AddKind::Swatch => Icon::Swatch,
            AddKind::ImagePath => Icon::Image,
            AddKind::PdfPath => Icon::Pdf,
            AddKind::AudioPath => Icon::Audio,
            AddKind::VideoPath => Icon::Video,
        }
    }
}

fn circle_path(b: &mut PathBuilder, ox: f32, oy: f32, cx: f32, cy: f32, r: f32) {
    b.move_to(point(px(ox + cx - r), px(oy + cy)));
    b.arc_to(
        point(px(r), px(r)),
        px(0.),
        false,
        true,
        point(px(ox + cx + r), px(oy + cy)),
    );
    b.arc_to(
        point(px(r), px(r)),
        px(0.),
        false,
        true,
        point(px(ox + cx - r), px(oy + cy)),
    );
    b.close();
}

fn icon_canvas(icon: Icon, hex: u32) -> impl IntoElement {
    canvas(
        move |_bounds, _window, _cx| (),
        move |bounds, _state, window, _cx| {
            let ox = f32::from(bounds.origin.x);
            let oy = f32::from(bounds.origin.y);
            let pt = |x: f32, y: f32| point(px(ox + x), px(oy + y));
            let mut s = PathBuilder::stroke(px(1.6));
            let mut f = PathBuilder::fill();
            // One polyline in the stroke path.
            macro_rules! line {
                ($($x:expr, $y:expr);+) => {{
                    let mut first = true;
                    $(
                        if first {
                            s.move_to(pt($x, $y));
                            first = false;
                        } else {
                            s.line_to(pt($x, $y));
                        }
                    )+
                }};
            }
            // One filled dot in the fill path, centred at ($x, $y).
            macro_rules! dot {
                ($x:expr, $y:expr, $r:expr) => {{
                    f.move_to(pt($x + $r, $y));
                    f.arc_to(
                        point(px($r), px($r)),
                        px(0.),
                        false,
                        true,
                        pt($x - $r, $y),
                    );
                    f.arc_to(
                        point(px($r), px($r)),
                        px(0.),
                        false,
                        true,
                        pt($x + $r, $y),
                    );
                }};
            }
            match icon {
                Icon::Select => {
                    f.add_polygon(
                        &[
                            pt(4., 3.),
                            pt(4., 17.),
                            pt(7., 14.),
                            pt(9., 18.),
                            pt(11., 17.),
                            pt(9., 13.),
                            pt(14., 13.),
                        ],
                        true,
                    );
                }
                Icon::Pan => {
                    line!(4., 10.; 16., 10.);
                    line!(4., 10.; 6.5, 7.5);
                    line!(4., 10.; 6.5, 12.5);
                    line!(16., 10.; 13.5, 7.5);
                    line!(16., 10.; 13.5, 12.5);
                    line!(10., 4.; 10., 16.);
                    line!(10., 4.; 7.5, 6.5);
                    line!(10., 4.; 12.5, 6.5);
                    line!(10., 16.; 7.5, 13.5);
                    line!(10., 16.; 12.5, 13.5);
                }
                Icon::Pen => {
                    line!(14., 3.; 5., 12.; 3., 17.; 8., 15.; 17., 6.; 14., 3.);
                }
                Icon::Marker => {
                    let mut thick = PathBuilder::stroke(px(4.));
                    thick.move_to(pt(4., 16.));
                    thick.line_to(pt(16., 4.));
                    if let Ok(p) = thick.build() {
                        window.paint_path(p, rgb(hex));
                    }
                }
                Icon::Connector => {
                    line!(4., 16.; 16., 4.);
                    circle_path(&mut f, ox, oy, 4., 16., 2.4);
                    circle_path(&mut f, ox, oy, 16., 4., 2.4);
                }
                Icon::Note => {
                    line!(5., 3.; 12., 3.; 15., 6.; 15., 17.; 5., 17.; 5., 3.);
                    line!(12., 3.; 12., 6.; 15., 6.);
                    line!(7., 10.; 13., 10.);
                    line!(7., 13.; 13., 13.);
                }
                Icon::Link => {
                    circle_path(&mut s, ox, oy, 7., 13., 3.);
                    circle_path(&mut s, ox, oy, 13., 7., 3.);
                    line!(9.2, 10.8; 10.8, 9.2);
                }
                Icon::Image => {
                    line!(3., 5.; 17., 5.; 17., 15.; 3., 15.; 3., 5.);
                    line!(5., 15.; 9., 9.; 12., 13.; 14., 10.; 17., 15.);
                    circle_path(&mut f, ox, oy, 13.5, 8., 1.7);
                }
                Icon::Pdf => {
                    line!(5., 3.; 12., 3.; 15., 6.; 15., 17.; 5., 17.; 5., 3.);
                    line!(12., 3.; 12., 6.; 15., 6.);
                    line!(7., 12.; 13., 12.);
                }
                Icon::Audio => {
                    // Eighth note: filled head, stem, flag.
                    f.move_to(pt(4., 14.));
                    f.arc_to(
                        point(px(3.), px(2.2)),
                        px(0.),
                        false,
                        true,
                        pt(10., 14.),
                    );
                    f.arc_to(
                        point(px(3.), px(2.2)),
                        px(0.),
                        false,
                        true,
                        pt(4., 14.),
                    );
                    f.close();
                    line!(10., 14.; 10., 5.);
                    line!(10., 5.; 15., 7.);
                }
                Icon::Video => {
                    line!(3., 6.; 17., 6.; 17., 14.; 3., 14.; 3., 6.);
                    f.add_polygon(&[pt(8., 8.), pt(8., 12.), pt(13., 10.)], true);
                }
                Icon::Play => {
                    f.add_polygon(&[pt(7., 5.), pt(7., 15.), pt(16., 10.)], true);
                }
                Icon::Pause => {
                    f.add_polygon(
                        &[pt(6., 5.), pt(9., 5.), pt(9., 15.), pt(6., 15.)],
                        true,
                    );
                    f.add_polygon(
                        &[pt(11., 5.), pt(14., 5.), pt(14., 15.), pt(11., 15.)],
                        true,
                    );
                }
                Icon::Plus => {
                    line!(5., 10.; 15., 10.);
                    line!(10., 5.; 10., 15.);
                }
                Icon::Stop => {
                    f.add_polygon(
                        &[pt(6., 6.), pt(14., 6.), pt(14., 14.), pt(6., 14.)],
                        true,
                    );
                }
                Icon::Group => {
                    line!(3., 3.; 11., 3.; 11., 11.; 3., 11.; 3., 3.);
                    line!(9., 9.; 17., 9.; 17., 17.; 9., 17.; 9., 9.);
                }
                Icon::Ungroup => {
                    line!(3., 3.; 9., 3.; 9., 9.; 3., 9.; 3., 3.);
                    line!(11., 11.; 17., 11.; 17., 17.; 11., 17.; 11., 11.);
                }
                Icon::Delete => {
                    line!(4., 5.; 16., 5.);
                    line!(8., 5.; 8., 3.; 12., 3.; 12., 5.);
                    line!(6., 5.; 7., 17.; 13., 17.; 14., 5.);
                    line!(9., 8.; 9., 14.);
                    line!(12., 8.; 12., 14.);
                }
                Icon::Tune => {
                    // Two sliders with knobs: the customise control.
                    line!(3., 7.; 17., 7.);
                    line!(3., 13.; 17., 13.);
                    dot!(12., 7., 2.2);
                    dot!(8., 13., 2.2);
                }
                Icon::GridLines => {
                    line!(7., 4.; 7., 16.);
                    line!(13., 4.; 13., 16.);
                    line!(4., 7.; 16., 7.);
                    line!(4., 13.; 16., 13.);
                }
                Icon::GridDots => {
                    dot!(6., 6., 1.3);
                    dot!(10., 6., 1.3);
                    dot!(14., 6., 1.3);
                    dot!(6., 10., 1.3);
                    dot!(10., 10., 1.3);
                    dot!(14., 10., 1.3);
                    dot!(6., 14., 1.3);
                    dot!(10., 14., 1.3);
                    dot!(14., 14., 1.3);
                }
                Icon::GridOff => {
                    line!(7., 4.; 7., 16.);
                    line!(13., 4.; 13., 16.);
                    line!(4., 7.; 16., 7.);
                    line!(4., 13.; 16., 13.);
                    line!(3., 17.; 17., 3.);
                }
                Icon::Close => {
                    line!(5., 5.; 15., 15.);
                    line!(15., 5.; 5., 15.);
                }
                Icon::Hide => {
                    s.move_to(pt(3., 10.));
                    s.cubic_bezier_to(pt(17., 10.), pt(7., 4.), pt(13., 4.));
                    s.move_to(pt(17., 10.));
                    s.cubic_bezier_to(pt(3., 10.), pt(13., 16.), pt(7., 16.));
                    circle_path(&mut f, ox, oy, 10., 10., 2.2);
                }
                // Text and Swatch are built from divs, not the canvas.
                Icon::Text | Icon::Swatch => {}
            }
            if let Ok(p) = s.build() {
                window.paint_path(p, rgb(hex));
            }
            if let Ok(p) = f.build() {
                window.paint_path(p, rgb(hex));
            }
        },
    )
    .w(px(20.))
    .h(px(20.))
}

fn icon_child(icon: Icon, hex: u32) -> gpui::AnyElement {
    match icon {
        Icon::Text => div()
            .text_size(px(15.))
            .font_weight(FontWeight::BOLD)
            .text_color(rgb(hex))
            .child("T".to_string())
            .into_any_element(),
        Icon::Swatch => div()
            .relative()
            .w(px(20.))
            .h(px(20.))
            .child(
                div()
                    .absolute()
                    .left(px(1.))
                    .top(px(1.))
                    .w(px(12.))
                    .h(px(12.))
                    .rounded(px(3.))
                    .bg(rgb(0xFF6B35)),
            )
            .child(
                div()
                    .absolute()
                    .right(px(1.))
                    .bottom(px(1.))
                    .w(px(12.))
                    .h(px(12.))
                    .rounded(px(3.))
                    .bg(rgb(0x2E86AB)),
            )
            .into_any_element(),
        _ => icon_canvas(icon, hex).into_any_element(),
    }
}

/// A tool button inside the segmented control: white when active, clear when not.
fn tool_icon_button(icon: Icon, active: bool) -> Div {
    let mut b = div()
        .w(px(32.))
        .h(px(32.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.));
    if active {
        b = b.bg(rgb(0xFFFFFF)).border_1().border_color(rgb(0xD9D9DE));
    }
    b.child(icon_child(icon, if active { 0x1C1C1E } else { 0x6E6E73 }))
}

/// A standalone toolbar action button: white pill with a hairline border.
fn action_icon_button(icon: Icon, hex: u32) -> Div {
    div()
        .w(px(32.))
        .h(px(32.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.))
        .bg(rgb(0xFFFFFF))
        .border_1()
        .border_color(rgb(0xDCDCE0))
        .child(icon_child(icon, hex))
}

fn toolbar_divider() -> Div {
    div().w(px(1.)).h(px(24.)).bg(rgb(0xD8D8DE))
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
    canvas_panel: bool,
    add_menu: bool,
    // Kept for debugging; nothing on screen shows it anymore — the
    // bottom status bar was removed at the user's request.
    _status: String,
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
            canvas_panel: false,
            add_menu: false,
            _status: "Board auto-saves on every change.".to_string(),
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
            Ok(()) => self._status = "Saved.".to_string(),
            Err(e) => self._status = format!("Save failed: {}", e),
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
            (self.viewport_h - TOOLBAR_H) / 2.0,
        ))
    }

    fn set_tool(&mut self, tool: Tool) {
        self.tool = tool;
        self.drag = None;
        self._status = format!("Tool: {}", tool.label());
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
                self._status = match grouped {
                    Some(g) => format!("Grouped (group {}).", g),
                    None => "Select 2+ items to group.".to_string(),
                };
                self.save();
            }
            "u" if ctrl => {
                self.shared.board.borrow_mut().ungroup_selection();
                self._status = "Ungrouped.".to_string();
                self.save();
            }
            "backspace" | "delete" => {
                self.shared.board.borrow_mut().delete_selection();
                self._status = "Deleted selection.".to_string();
                self.save();
            }
            "escape" => {
                self.shared.board.borrow_mut().selected.clear();
                self._status = "Selection cleared.".to_string();
            }
            "=" | "+" => self.zoom_centre(1.2),
            "-" => self.zoom_centre(1.0 / 1.2),
            "0" => {
                self.shared.board.borrow_mut().camera = Camera::default();
                self._status = "View reset.".to_string();
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
            (self.viewport_h - TOOLBAR_H) / 2.0,
        );
        self.shared.board.borrow_mut().camera.zoom_at(centre, factor);
        self._status = format!("Zoom {}%.", (self.camera().zoom * 100.0).round() as i32);
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
                    self._status = "Nothing typed — no note added.".to_string();
                    return;
                }
                self.shared.board.borrow_mut().add_text(panel.at, &input);
                self._status = "Note added.".to_string();
            }
            AddKind::Url => {
                if input.is_empty() {
                    self._status = "No link typed.".to_string();
                    return;
                }
                let url = if input.contains("://") {
                    input
                } else {
                    format!("https://{}", input)
                };
                if looks_like_video_url(&url) {
                    // Video links become video cards and open in the
                    // browser/player on double-click — no preview fetch.
                    self.shared
                        .board
                        .borrow_mut()
                        .add_video(panel.at, &url, true, 0);
                    self._status = format!("Video link added for {}.", domain_of(&url));
                } else {
                    let id = self.shared.board.borrow_mut().add_url(panel.at, &url);
                    self._status = format!("Link card added for {}.", domain_of(&url));
                    self.fetch_url_title(id, url, cx);
                }
            }
            AddKind::Swatch => match normalise_hex(&input) {
                Some(hex) => {
                    self.shared.board.borrow_mut().add_swatch(panel.at, &hex);
                    self._status = format!("Swatch {} added.", hex);
                }
                None => {
                    self._status = "Not a colour — try #FF6B35.".to_string();
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
                    self._status = format!("No such file: {}", input);
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
                self._status = "Image added.".to_string();
            }
            AddKind::PdfPath => {
                let path = std::path::Path::new(&input);
                let is_pdf = path
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("pdf"))
                    .unwrap_or(false);
                if !path.is_file() || !is_pdf {
                    self._status = "That is not a PDF file.".to_string();
                    self.add_panel = Some(AddPanel {
                        input: panel.input,
                        ..panel
                    });
                    return;
                }
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                self.shared.board.borrow_mut().add_pdf(panel.at, &input, size);
                self._status = "PDF card added — double-click it to open.".to_string();
            }
            AddKind::AudioPath => {
                let path = std::path::Path::new(&input);
                let is_audio = path
                    .extension()
                    .map(|e| {
                        ["mp3", "wav", "flac", "ogg", "m4a"]
                            .contains(&e.to_string_lossy().to_lowercase().as_str())
                    })
                    .unwrap_or(false);
                if !path.is_file() || !is_audio {
                    self._status = "That is not an audio file (mp3, wav, flac, ogg, m4a)."
                        .to_string();
                    self.add_panel = Some(AddPanel {
                        input: panel.input,
                        ..panel
                    });
                    return;
                }
                self.shared.board.borrow_mut().add_audio(panel.at, &input);
                self._status = "Audio added — select it to play.".to_string();
            }
            AddKind::VideoPath => {
                let path = std::path::Path::new(&input);
                let is_video = path
                    .extension()
                    .map(|e| {
                        ["mp4", "mov", "webm", "mkv", "avi", "m4v"]
                            .contains(&e.to_string_lossy().to_lowercase().as_str())
                    })
                    .unwrap_or(false);
                if !path.is_file() || !is_video {
                    self._status = "That is not a video file (mp4, mov, webm, mkv, avi)."
                        .to_string();
                    self.add_panel = Some(AddPanel {
                        input: panel.input,
                        ..panel
                    });
                    return;
                }
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                self.shared
                    .board
                    .borrow_mut()
                    .add_video(panel.at, &input, false, size);
                self._status = "Video added — double-click it to play.".to_string();
            }
        }
        self.save();
    }

    /// Play/pause the audio item. Failures (no device, bad file) are a
    /// status message, never a crash.
    fn toggle_audio(&mut self, id: ItemId) {
        let path = self.with_board(|b| {
            b.get(id).and_then(|i| match &i.kind {
                Kind::Audio { path } => Some(path.clone()),
                _ => None,
            })
        });
        match path {
            Some(path) => {
                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or(path.clone());
                match self.shared.audio.borrow_mut().toggle(id, &path) {
                    Ok(Playback::Playing) => self._status = format!("Playing {}.", name),
                    Ok(Playback::Paused) => self._status = format!("Paused {}.", name),
                    Ok(Playback::Stopped) => self._status = format!("Stopped {}.", name),
                    Err(msg) => self._status = msg,
                }
            }
            None => self._status = "That is not an audio item.".to_string(),
        }
    }

    fn stop_audio(&mut self) {
        self.shared.audio.borrow_mut().stop();
        self._status = "Playback stopped.".to_string();
    }

    /// Video plays in the system player (local file) or the browser
    /// (remote link) — QuickBoard does not decode video frames itself.
    fn play_video(&mut self, id: ItemId) {
        let source = self.with_board(|b| {
            b.get(id).and_then(|i| match &i.kind {
                Kind::Video { source, .. } => Some(source.clone()),
                _ => None,
            })
        });
        match source {
            Some(source) => self.open_external(&source),
            None => self._status = "That is not a video item.".to_string(),
        }
    }

    fn open_external(&mut self, target: &str) {
        #[cfg(target_os = "macos")]
        let opener = "open";
        #[cfg(not(target_os = "macos"))]
        let opener = "xdg-open";
        match std::process::Command::new(opener).arg(target).spawn() {
            Ok(_) => self._status = format!("Opening {}.", target),
            Err(_) => self._status = format!("Could not open {} (no viewer found).", target),
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
                "mp3" | "wav" | "flac" | "ogg" | "m4a" => {
                    self.shared.board.borrow_mut().add_audio(at, &path_str);
                    added += 1;
                }
                "mp4" | "mov" | "webm" | "mkv" | "avi" | "m4v" => {
                    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                    self.shared
                        .board
                        .borrow_mut()
                        .add_video(at, &path_str, false, size);
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
            self._status = format!("Dropped {} item(s) onto the board.", added);
            self.save();
        } else if skipped > 0 {
            self._status = "That file type is not dropped as a board item yet.".to_string();
        }
    }

    // ----- rendering helpers -----

    fn item_element(&self, item: &Item, selected: bool) -> gpui::AnyElement {
        let cam = self.camera();
        let screen = cam.to_screen(item.pos);
        let w = item.size.w * cam.zoom;
        let h = item.size.h * cam.zoom;
        let border = if selected { rgb(ACCENT) } else { rgb(0xE5E5EA) };
        let base = div()
            .absolute()
            .left(px(screen.x))
            .top(px(screen.y))
            .w(px(w))
            .h(px(h))
            // Flat and minimal: a hairline border and a soft corner,
            // no heavy shadow.
            .rounded(px(14.))
            .bg(rgb(0xFFFFFF))
            .border_1()
            .border_color(border)
            // Nothing inside a card may spill past its rounded corners,
            // whatever the text length or zoom.
            .overflow_hidden();
        let el = match &item.kind {
            Kind::Text {
                text,
                bold,
                size,
                color,
            } => {
                let mut t = base.p(px(12. * cam.zoom)).text_size(px(size * cam.zoom));
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
                    // NB: pass a PathBuf, not the String — GPUI treats a
                    // String as an embedded-asset name and loads nothing.
                    base.child(
                        img(std::path::PathBuf::from(path.clone()))
                            .w(px(w))
                            .h(px(h))
                            .rounded(px(12.)),
                    )
                } else {
                    base.bg(rgb(0xF5F5F7))
                        .flex()
                        .items_center()
                        .justify_center()
                        .p(px(12.))
                        .text_size(px(13.))
                        .text_color(rgb(0x8A8A8E))
                        .child(format!("Image missing:\n{}", path))
                }
            }
            Kind::UrlCard {
                url,
                title,
                description,
            } => {
                let domain = domain_of(url);
                let head = title.clone().unwrap_or_else(|| domain.clone());
                // Unfurl look: a coloured tile with the domain's initial,
                // like a chat app's link preview, next to the text.
                let initial = domain
                    .chars()
                    .next()
                    .unwrap_or('?')
                    .to_ascii_uppercase()
                    .to_string();
                let tile_color = tile_color_for(&domain);
                let tile = div()
                    .w(px(56.))
                    .h(px(56.))
                    .rounded(px(10.))
                    .bg(rgb(tint_u32(tile_color, 0.85)))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .text_size(px(24.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(rgb(tile_color))
                            .child(initial),
                    );
                // Hard width: the text column may never push past the
                // card edge, so long titles/URLs/descriptions clip
                // instead of spilling onto the canvas.
                let col_w = (w - 92.).max(40.);
                let title_px = 14. * cam.zoom.max(0.7);
                let mut col = div().flex().flex_col().gap(px(2.)).w(px(col_w));
                col = col.child(
                    div()
                        .text_size(px(title_px))
                        .font_weight(FontWeight::BOLD)
                        .text_color(rgb(0x1C1C1E))
                        .truncate()
                        .child(elide(&head, col_w, title_px, true)),
                );
                col = col.child(
                    div()
                        .text_size(px(12.))
                        .text_color(rgb(0x2E86AB))
                        .truncate()
                        .child(elide(url, col_w, 12.0, false)),
                );
                if let Some(d) = description {
                    if !d.is_empty() {
                        // Two lines' worth, then line_clamp as backstop.
                        col = col.child(
                            div()
                                .text_size(px(12.))
                                .text_color(rgb(0x6E6E73))
                                .line_clamp(2)
                                .child(elide(d, col_w * 2.0, 12.0, false)),
                        );
                    }
                }
                base.flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .p(px(12.))
                    .child(tile)
                    .child(col)
            }
            Kind::PdfCard { path, size_bytes } => {
                let name = std::path::Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                let kb = (*size_bytes as f64 / 1024.0).round() as u64;
                let tile = div()
                    .w(px(56.))
                    .h(px(56.))
                    .rounded(px(10.))
                    .bg(rgb(tint_u32(0xE63946, 0.88)))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(rgb(0xE63946))
                            .child("PDF".to_string()),
                    );
                base.flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .p(px(12.))
                    .child(tile)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .w(px((w - 92.).max(40.)))
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(rgb(0x1C1C1E))
                                    .truncate()
                                    .child(elide(&name, (w - 92.).max(40.), 14.0, true)),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(rgb(0x6E6E73))
                                    .truncate()
                                    .child(elide(
                                        &format!("{} KB — double-click to open", kb),
                                        (w - 92.).max(40.),
                                        12.0,
                                        false,
                                    )),
                            ),
                    )
            }
            Kind::Audio { path } => {
                let name = std::path::Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                let playing = self
                    .shared
                    .audio
                    .borrow()
                    .playing
                    .map(|pid| pid == item.id)
                    .unwrap_or(false)
                    && self.shared.audio.borrow().state() == Playback::Playing;
                // The tile IS the play button: a play triangle when
                // stopped or paused, pause bars while playing.
                let tile_icon = if playing { Icon::Pause } else { Icon::Play };
                let tile = div()
                    .w(px(56.))
                    .h(px(56.))
                    .rounded(px(10.))
                    .bg(rgb(tint_u32(0x6A4C93, 0.88)))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .w(px(20.))
                            .h(px(20.))
                            .child(icon_canvas(tile_icon, 0x6A4C93)),
                    );
                // A mini player look: the name, then a waveform strip
                // that reads as audio at a glance, then the play hint.
                let mut wave = div().flex().flex_row().items_end().gap(px(2.)).h(px(18.));
                for (i, bh) in [
                    5., 9., 13., 7., 15., 11., 6., 13., 17., 10., 8., 14., 6., 12., 9., 5., 10.,
                    13.,
                ]
                .iter()
                .enumerate()
                {
                    wave = wave.child(
                        div()
                            .w(px(3.))
                            .h(px(*bh))
                            .rounded(px(1.))
                            .bg(rgb(if i % 3 == 0 { 0xB8A6CC } else { 0x6A4C93 })),
                    );
                }
                base.flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .p(px(12.))
                    .child(tile)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .w(px((w - 92.).max(40.)))
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(rgb(0x1C1C1E))
                                    .truncate()
                                    .child(elide(&name, (w - 92.).max(40.), 14.0, true)),
                            )
                            .child(wave)
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(rgb(0x6E6E73))
                                    .truncate()
                                    .child(if playing {
                                        "Now playing".to_string()
                                    } else {
                                        elide(
                                            "Click play to listen",
                                            (w - 92.).max(40.),
                                            12.0,
                                            false,
                                        )
                                    }),
                            ),
                    )
            }
            Kind::Video {
                source,
                remote,
                size_bytes,
            } => {
                let name = if *remote {
                    domain_of(source)
                } else {
                    std::path::Path::new(source)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| source.clone())
                };
                let kb = (*size_bytes as f64 / 1024.0).round() as u64;
                let subline = if *remote {
                    "Video link — click to play".to_string()
                } else {
                    format!("{} KB — click to play", kb)
                };
                // Big preview when the card is tall enough for a 16:9
                // thumb plus text; otherwise the compact row layout.
                // (Cards made before this change are short, so they
                // keep the row layout until resized bigger.)
                let thumb_h = (w - 24.) * 9. / 16.;
                if h >= thumb_h + 70. {
                    let col_w = (w - 24.).max(40.);
                    let thumb = div()
                        .w(px(w - 24.))
                        .h(px(thumb_h))
                        .rounded(px(10.))
                        .bg(rgb(0x1C1C1E))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            div()
                                .w(px(28.))
                                .h(px(28.))
                                .child(icon_canvas(Icon::Play, 0xFFFFFF)),
                        );
                    base.flex()
                        .flex_col()
                        .p(px(12.))
                        .gap(px(8.))
                        .child(thumb)
                        .child(
                            div()
                                .text_size(px(14.))
                                .font_weight(FontWeight::BOLD)
                                .text_color(rgb(0x1C1C1E))
                                .truncate()
                                .child(elide(&name, col_w, 14.0, true)),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(rgb(0x6E6E73))
                                .truncate()
                                .child(elide(&subline, col_w, 12.0, false)),
                        )
                } else {
                    let tile = div()
                        .w(px(96.))
                        .h(px(56.))
                        .rounded(px(10.))
                        .bg(rgb(0x1C1C1E))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            div()
                                .w(px(24.))
                                .h(px(24.))
                                .child(icon_canvas(Icon::Play, 0xFFFFFF)),
                        );
                    base.flex()
                        .flex_row()
                        .items_center()
                        .gap(px(12.))
                        .p(px(12.))
                        .child(tile)
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .w(px((w - 132.).max(40.)))
                                .child(
                                    div()
                                        .text_size(px(14.))
                                        .font_weight(FontWeight::BOLD)
                                        .text_color(rgb(0x1C1C1E))
                                        .truncate()
                                        .child(elide(&name, (w - 132.).max(40.), 14.0, true)),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(rgb(0x6E6E73))
                                        .truncate()
                                        .child(elide(
                                            &subline,
                                            (w - 132.).max(40.),
                                            12.0,
                                            false,
                                        )),
                                ),
                        )
                }
            }
            Kind::Swatch { hex } => {
                let (r, g, b) = parse_hex(hex).unwrap_or((0, 0, 0));
                // The hex sits in a white pill so it reads on any colour.
                base.bg(rgb(((r as u32) << 16) | ((g as u32) << 8) | (b as u32)))
                    .flex()
                    .items_end()
                    .p(px(10.))
                    .child(
                        div()
                            .bg(rgb(0xFFFFFF))
                            .rounded(px(10.))
                            .px(px(8.))
                            .py(px(4.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(rgb(0x1C1C1E))
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

/// Shorten `s` to roughly fit `width_px` at `text_px` size, appending
/// "…" when cut. GPUI's own ellipsis does not reliably render for
/// single-line text in these cards (the text clips without it), so the
/// cut is done here; the card's overflow_hidden remains as a backstop.
fn elide(s: &str, width_px: f32, text_px: f32, bold: bool) -> String {
    let per_char = text_px * if bold { 0.55 } else { 0.50 };
    let budget = (width_px / per_char).floor() as usize;
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= budget || budget < 2 {
        return s.to_string();
    }
    let head: String = chars[..budget.saturating_sub(1)].iter().collect();
    format!("{}…", head.trim_end())
}

/// Where the segment from `from` to `to` crosses a rectangle: its entry
/// point (for the target item) or exit point (for the source item).
/// Connectors anchor at item centres, so without this the line and its
/// arrowhead would draw straight across the cards themselves.
fn rect_crossing(from: Pt, to: Pt, pos: Pt, w: f32, h: f32, entry: bool) -> Option<Pt> {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let mut t0 = 0.0f32;
    let mut t1 = 1.0f32;
    for (o, d, lo, hi) in [
        (from.x, dx, pos.x, pos.x + w),
        (from.y, dy, pos.y, pos.y + h),
    ] {
        if d.abs() < f32::EPSILON {
            if o < lo || o > hi {
                return None;
            }
        } else {
            let mut ta = (lo - o) / d;
            let mut tb = (hi - o) / d;
            if ta > tb {
                std::mem::swap(&mut ta, &mut tb);
            }
            t0 = t0.max(ta);
            t1 = t1.min(tb);
            if t0 > t1 {
                return None;
            }
        }
    }
    let t = if entry { t0 } else { t1 };
    if !(0.0..=1.0).contains(&t) {
        return None;
    }
    Some(Pt::new(from.x + dx * t, from.y + dy * t))
}

/// A connector's drawn endpoints: clipped to the anchored items' edges
/// (point anchors keep their exact position).
fn clipped_ends(board: &Board, from: Anchor, to: Anchor) -> Option<(Pt, Pt)> {
    let a_raw = board.anchor_point(from)?;
    let b_raw = board.anchor_point(to)?;
    let mut a = a_raw;
    let mut b = b_raw;
    if let Anchor::Item(id) = from {
        if let Some(it) = board.get(id) {
            let (p, s) = it.bounds();
            if let Some(p2) = rect_crossing(a_raw, b_raw, p, s.w, s.h, false) {
                a = p2;
            }
        }
    }
    if let Anchor::Item(id) = to {
        if let Some(it) = board.get(id) {
            let (p, s) = it.bounds();
            if let Some(p2) = rect_crossing(a_raw, b_raw, p, s.w, s.h, true) {
                b = p2;
            }
        }
    }
    Some((a, b))
}

/// A stable tile colour for a link preview, picked from the domain name.
fn tile_color_for(domain: &str) -> u32 {
    const TILES: [u32; 6] = [0x2E86AB, 0x6A4C93, 0x2A9D8F, 0xFF6B35, 0xE63946, 0xB56576];
    let mut h: u32 = 0;
    for b in domain.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u32);
    }
    TILES[(h % TILES.len() as u32) as usize]
}

/// Mix a 0xRRGGBB colour toward white: 0.85 gives a pastel tint for
/// the minimal card tiles, with the full colour kept for the glyph.
fn tint_u32(color: u32, white_mix: f32) -> u32 {
    let r = ((color >> 16) & 0xFF) as f32;
    let g = ((color >> 8) & 0xFF) as f32;
    let b = (color & 0xFF) as f32;
    let m = |c: f32| (c * (1.0 - white_mix) + 255.0 * white_mix) as u32;
    (m(r) << 16) | (m(g) << 8) | m(b)
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

impl BoardView {
    /// The "+" menu: every add action as an icon + label row, top-left
    /// of the board. Picking one opens the same input banner the old
    /// toolbar buttons opened, then the menu closes.
    fn add_menu_el(&self, cx: &mut Context<Self>) -> Div {
        let mut menu = div()
            .absolute()
            .left(px(16.))
            .top(px(12.))
            .w(px(220.))
            .rounded(px(12.))
            .bg(rgb(0xFFFFFF))
            .border_1()
            .border_color(rgb(0xE5E5EA))
            .shadow(vec![BoxShadow {
                color: Hsla {
                    h: 0.0,
                    s: 0.0,
                    l: 0.0,
                    a: 0.12,
                },
                offset: point(px(0.), px(4.)),
                blur_radius: px(16.),
                spread_radius: px(0.),
            }])
            .p(px(8.))
            .flex()
            .flex_col()
            .gap(px(2.));
        for (kind, label) in [
            (AddKind::Text, "Note"),
            (AddKind::Url, "Link"),
            (AddKind::Swatch, "Colour swatch"),
            (AddKind::ImagePath, "Image"),
            (AddKind::PdfPath, "PDF"),
            (AddKind::AudioPath, "Audio"),
            (AddKind::VideoPath, "Video"),
        ] {
            let at = self.board_centre();
            let icon_hex = if kind == AddKind::PdfPath {
                0xC0392B
            } else {
                0x333333
            };
            menu = menu.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .px(px(8.))
                    .py(px(6.))
                    .rounded(px(8.))
                    .child(icon_child(kind.icon(), icon_hex))
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(rgb(0x1C1C1E))
                            .child(label.to_string()),
                    )
                    .id(SharedString::from(format!("add-menu-{}", label)))
                    .on_click(cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                        this.add_panel = Some(AddPanel {
                            kind,
                            at,
                            input: String::new(),
                        });
                        this.add_menu = false;
                        cx.notify();
                    })),
            );
        }
        menu
    }

    /// The canvas customisation panel: background colours and grid
    /// style. Choices apply instantly and save with the board; the
    /// panel closes after a choice (a canvas click on the panel's
    /// own buttons still lands the choice first), and also closes on
    /// a canvas click elsewhere, Esc, or the close button.
    fn canvas_panel_el(&self, cx: &mut Context<Self>) -> Div {
        let bg_now = self.shared.board.borrow().bg.clone();
        let grid_now = self.shared.board.borrow().grid;
        let mut panel = div()
            .absolute()
            .right(px(16.))
            .top(px(12.))
            .w(px(272.))
            .rounded(px(12.))
            .bg(rgb(0xFFFFFF))
            .border_1()
            .border_color(rgb(0xE5E5EA))
            .shadow(vec![BoxShadow {
                color: Hsla {
                    h: 0.0,
                    s: 0.0,
                    l: 0.0,
                    a: 0.12,
                },
                offset: point(px(0.), px(4.)),
                blur_radius: px(16.),
                spread_radius: px(0.),
            }])
            .p(px(12.))
            .flex()
            .flex_col()
            .gap(px(10.));
        panel = panel.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(rgb(0x1C1C1E))
                        .child("Canvas".to_string()),
                )
                .child(
                    action_icon_button(Icon::Close, 0x333333)
                        .id("canvas-close")
                        .on_click(cx.listener(|this, _event: &gpui::ClickEvent, _window, cx| {
                            this.canvas_panel = false;
                            cx.notify();
                        })),
                ),
        );
        panel = panel.child(
            div()
                .text_size(px(11.))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(0x6E6E73))
                .child("Colour".to_string()),
        );
        let mut row = div().flex().flex_row().gap(px(8.));
        for (name, hex) in CANVAS_COLORS {
            let (r, g, b) = parse_hex(hex).unwrap_or((0, 0, 0));
            let active = bg_now == hex;
            let hex_owned = hex.to_string();
            let name_owned = name.to_string();
            row = row.child(
                div()
                    .w(px(28.))
                    .h(px(28.))
                    .rounded(px(14.))
                    .bg(rgb(((r as u32) << 16) | ((g as u32) << 8) | (b as u32)))
                    .border_1()
                    .border_color(if active { rgb(ACCENT) } else { rgb(0xDCDCE0) })
                    .id(SharedString::from(format!("canvas-bg-{}", name)))
                    .on_click(cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                        this.shared.board.borrow_mut().bg = hex_owned.clone();
                        this._status = format!("Canvas colour: {}.", name_owned);
                        this.save();
                        cx.notify();
                    })),
            );
        }
        panel = panel.child(row);
        panel = panel.child(
            div()
                .text_size(px(11.))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(0x6E6E73))
                .child("Grid".to_string()),
        );
        let mut grid_row = div().flex().flex_row().gap(px(8.));
        for (mode, label, icon) in [
            (GridMode::Lines, "Lines", Icon::GridLines),
            (GridMode::Dots, "Dots", Icon::GridDots),
            (GridMode::Off, "Off", Icon::GridOff),
        ] {
            let active = grid_now == mode;
            grid_row = grid_row.child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(2.))
                    .w(px(77.))
                    .py(px(8.))
                    .rounded(px(8.))
                    .bg(if active { rgb(0xF5F5F7) } else { rgb(0xFFFFFF) })
                    .border_1()
                    .border_color(if active { rgb(ACCENT) } else { rgb(0xE5E5EA) })
                    .child(icon_child(icon, if active { 0x1C1C1E } else { 0x6E6E73 }))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(rgb(0x1C1C1E))
                            .child(label.to_string()),
                    )
                    .id(SharedString::from(format!("canvas-grid-{}", label)))
                    .on_click(cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                        this.shared.board.borrow_mut().grid = mode;
                        this._status = format!("Grid: {}.", label.to_lowercase());
                        this.save();
                        cx.notify();
                    })),
            );
        }
        panel = panel.child(grid_row);
        panel = panel.child(
            div()
                .text_size(px(11.))
                .text_color(rgb(0x8E8E93))
                .child("Saved with the board.".to_string()),
        );
        panel
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
        // Canvas appearance, from the board's own settings.
        let (br, bg_g, bb) = parse_hex(&board.bg).unwrap_or((0xF7, 0xF5, 0xF0));
        let board_bg = rgb(((br as u32) << 16) | ((bg_g as u32) << 8) | (bb as u32));
        // Grid marks stay subtle on any background: dark grey on light
        // boards, mid grey on dark ones.
        let lum = 0.299 * br as f32 + 0.587 * bg_g as f32 + 0.114 * bb as f32;
        let grid_lightness = if lum > 140.0 { 0.85 } else { 0.35 };
        let grid_mode = board.grid;

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
                // Grid, in the board's chosen style, every GRID units.
                let x0 = cam.x;
                let x1 = cam.x + bw / cam.zoom;
                let y0 = cam.y;
                let y1 = cam.y + bh / cam.zoom;
                let grid_color = Hsla {
                    h: 0.0,
                    s: 0.0,
                    l: grid_lightness,
                    a: 1.0,
                };
                match grid_mode {
                    GridMode::Lines => {
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
                            window.paint_path(path, grid_color);
                        }
                    }
                    GridMode::Dots => {
                        let mut dots = PathBuilder::fill();
                        let mut gx = (x0 / GRID).floor() * GRID;
                        while gx <= x1 {
                            let sx = (gx - cam.x) * cam.zoom + ox;
                            let mut gy = (y0 / GRID).floor() * GRID;
                            while gy <= y1 {
                                let sy = (gy - cam.y) * cam.zoom + oy;
                                dots.move_to(point(px(sx + 1.5), px(sy)));
                                dots.arc_to(
                                    point(px(1.5), px(1.5)),
                                    px(0.),
                                    false,
                                    true,
                                    point(px(sx - 1.5), px(sy)),
                                );
                                dots.arc_to(
                                    point(px(1.5), px(1.5)),
                                    px(0.),
                                    false,
                                    true,
                                    point(px(sx + 1.5), px(sy)),
                                );
                                gy += GRID;
                            }
                            gx += GRID;
                        }
                        if let Ok(path) = dots.build() {
                            window.paint_path(path, grid_color);
                        }
                    }
                    GridMode::Off => {}
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
                    let (a, b) = clipped_ends(&board, *from, *to)?;
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
            if let Some(a_raw) = board.anchor_point(*from) {
                let mut a = a_raw;
                if let Anchor::Item(id) = from {
                    if let Some(it) = board.get(*id) {
                        let (p, s) = it.bounds();
                        if let Some(p2) = rect_crossing(a_raw, *current, p, s.w, s.h, false) {
                            a = p2;
                        }
                    }
                }
                live_connector = Some((a, *current));
            }
        }
        let marquee_rect: Option<(Pt, Pt)> = match &drag {
            Some(Drag::Marquee { start, current }) => Some((*start, *current)),
            _ => None,
        };
        // Resize handle: the bottom-right corner of the single selected
        // item, in world coords; painted below by the front canvas.
        let resize_handle: Option<Pt> = if board.selected.len() == 1 {
            board.get(board.selected[0]).map(|item| {
                let (p, s) = board.item_bounds(item);
                Pt::new(p.x + s.w, p.y + s.h)
            })
        } else {
            None
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
                // Resize handle: a white square with a hairline border
                // and two grip diagonals at the selected item's corner.
                if let Some(hp) = resize_handle {
                    let hs = to_screen(hp);
                    let hx = f32::from(hs.x);
                    let hy = f32::from(hs.y);
                    let mut fill = PathBuilder::fill();
                    fill.move_to(point(px(hx - 16.), px(hy - 16.)));
                    fill.line_to(point(px(hx), px(hy - 16.)));
                    fill.line_to(point(px(hx), px(hy)));
                    fill.line_to(point(px(hx - 16.), px(hy)));
                    fill.close();
                    if let Ok(path) = fill.build() {
                        window.paint_path(path, rgb(0xFFFFFF));
                    }
                    let mut grip = PathBuilder::stroke(px(1.));
                    grip.move_to(point(px(hx - 16.), px(hy - 16.)));
                    grip.line_to(point(px(hx), px(hy - 16.)));
                    grip.line_to(point(px(hx), px(hy)));
                    grip.line_to(point(px(hx - 16.), px(hy)));
                    grip.line_to(point(px(hx - 16.), px(hy - 16.)));
                    grip.move_to(point(px(hx - 12.), px(hy - 4.)));
                    grip.line_to(point(px(hx - 4.), px(hy - 12.)));
                    grip.move_to(point(px(hx - 7.), px(hy - 4.)));
                    grip.line_to(point(px(hx - 4.), px(hy - 7.)));
                    if let Ok(path) = grip.build() {
                        window.paint_path(path, rgb(0x8E8E93));
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
                    // A canvas click dismisses the customisation panel
                    // instead of doing anything with the tool.
                    if this.canvas_panel {
                        this.canvas_panel = false;
                        cx.notify();
                        return;
                    }
                    // Same for the add menu.
                    if this.add_menu {
                        this.add_menu = false;
                        cx.notify();
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
                                            Kind::Audio { .. } => format!("audio:{}", id),
                                            Kind::Video { .. } => format!("video:{}", id),
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
                                        // No audio/video arms here on
                                        // purpose: playback is a single
                                        // click on the play button now,
                                        // so a double-click must not
                                        // fire it a second time.
                                        _ => {}
                                    }
                                }
                                cx.notify();
                                return;
                            }
                            // Play buttons first: a single click on a
                            // video thumb plays it, and a single click
                            // on an audio tile toggles playback. The
                            // item is selected too, so the transport
                            // bar appears for audio.
                            if let Some(id) = this.with_board(|b| b.hit_test(world)) {
                                let play_hit = this.with_board(|b| {
                                    b.get(id).map(|item| match &item.kind {
                                        Kind::Video { .. } => {
                                            let (pw, ph) = (item.size.w, item.size.h);
                                            let thumb_h = (pw - 24.) * 9. / 16.;
                                            if ph >= thumb_h + 70. {
                                                // Big layout: thumb on top.
                                                world.x >= item.pos.x + 12.
                                                    && world.x <= item.pos.x + pw - 12.
                                                    && world.y >= item.pos.y + 12.
                                                    && world.y <= item.pos.y + 12. + thumb_h
                                            } else {
                                                // Compact row: 96x56 thumb,
                                                // vertically centred.
                                                world.x >= item.pos.x + 12.
                                                    && world.x <= item.pos.x + 108.
                                                    && world.y >= item.pos.y + (ph - 56.) / 2.
                                                    && world.y <= item.pos.y + (ph + 56.) / 2.
                                            }
                                        }
                                        Kind::Audio { .. } => {
                                            // The tile: 56x56, vertically
                                            // centred, 12 in from the left.
                                            let ph = item.size.h;
                                            world.x >= item.pos.x + 12.
                                                && world.x <= item.pos.x + 68.
                                                && world.y >= item.pos.y + (ph - 56.) / 2.
                                                && world.y <= item.pos.y + (ph + 56.) / 2.
                                        }
                                        _ => false,
                                    })
                                });
                                if play_hit == Some(true) {
                                    this.shared.board.borrow_mut().select(id, false);
                                    match this.with_board(|b| {
                                        b.get(id).map(|i| i.kind.clone())
                                    }) {
                                        Some(Kind::Video { .. }) => this.play_video(id),
                                        Some(Kind::Audio { .. }) => this.toggle_audio(id),
                                        _ => {}
                                    }
                                    cx.notify();
                                    return;
                                }
                            }
                            // Resize handle first: the bottom-right
                            // 16 screen px of the single selected item.
                            let handle_hit = {
                                let selected = this.shared.board.borrow().selected.clone();
                                if selected.len() == 1 {
                                    let zoom = this.camera().zoom;
                                    this.with_board(|b| {
                                        b.get(selected[0]).map(|item| {
                                            let (p, s) = b.item_bounds(item);
                                            let tol = 16.0 / zoom;
                                            world.x >= p.x + s.w - tol
                                                && world.x <= p.x + s.w + tol
                                                && world.y >= p.y + s.h - tol
                                                && world.y <= p.y + s.h + tol
                                        })
                                    })
                                } else {
                                    None
                                }
                            };
                            if handle_hit == Some(true) {
                                let sel = this.shared.board.borrow().selected[0];
                                let (ow, oh) = this.with_board(|b| {
                                    b.get(sel).map(|i| (i.size.w, i.size.h)).unwrap_or((100.0, 100.0))
                                });
                                this.drag = Some(Drag::Resize {
                                    id: sel,
                                    start_world: world,
                                    orig_w: ow,
                                    orig_h: oh,
                                });
                            } else if let Some(id) = this.with_board(|b| b.hit_test(world)) {
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
                    Some(Drag::Resize {
                        id,
                        start_world,
                        orig_w,
                        orig_h,
                    }) => {
                        let new_w = *orig_w + (world.x - start_world.x);
                        let new_h = *orig_h + (world.y - start_world.y);
                        this.shared.board.borrow_mut().resize_item(*id, new_w, new_h);
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
                                this._status = "Stroke added.".to_string();
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
                                this._status = "Connector added.".to_string();
                                this.save();
                            }
                        }
                        Some(Drag::Marquee { start, .. }) => {
                            let ids = this.with_board(|b| b.marquee(start, world));
                            this.shared.board.borrow_mut().selected = ids;
                            this._status = format!(
                                "{} item(s) selected — Ctrl+G groups them.",
                                this.with_board(|b| b.selected.len())
                            );
                        }
                        Some(Drag::Move { .. }) => {
                            this.save();
                        }
                        Some(Drag::Resize { .. }) => {
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
                    this._status = format!("Zoom {}%.", (this.camera().zoom * 100.0).round() as i32);
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

        // --- toolbar: macOS-style, icons only ---
        // The status bar names the active tool, so nothing here needs a word.
        let mut toolbar = div()
            .h(px(TOOLBAR_H))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            // Keep the right end clear of the floating handle pill, which
            // sits over the top-right corner of the display (168 wide + margins).
            .pr(px(200.))
            .bg(rgb(0xF5F5F7))
            .border_b_1()
            .border_color(rgb(0xDCDCE0));
        toolbar = toolbar.child(
            div()
                .text_size(px(13.))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(0x1C1C1E))
                .child("QuickBoard".to_string()),
        );
        // Segmented tool control.
        let mut tools = div()
            .flex()
            .flex_row()
            .items_center()
            .bg(rgb(0xE8E8ED))
            .rounded(px(9.))
            .p(px(2.));
        for (tool, label) in [
            (Tool::Select, "Select"),
            (Tool::Pan, "Pan"),
            (Tool::Pen, "Pen"),
            (Tool::Marker, "Marker"),
            (Tool::Text, "Text"),
            (Tool::Connector, "Connector"),
        ] {
            let active = tool == self.tool;
            tools = tools.child(tool_icon_button(tool.icon(), active).id(SharedString::from(format!("tool-{}", label))).on_click(
                cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                    this.set_tool(tool);
                    cx.notify();
                }),
            ));
        }
        toolbar = toolbar.child(tools);
        toolbar = toolbar.child(toolbar_divider());
        // The pen palette only shows for the drawing tools — the rest
        // of the time the toolbar stays quiet.
        if self.tool == Tool::Pen || self.tool == Tool::Marker {
            for hex in PALETTE {
            let active = self.pen_color == hex;
            let (r, g, b) = parse_hex(hex).unwrap_or((0, 0, 0));
            let swatch = div()
                .w(px(if active { 24. } else { 20. }))
                .h(px(if active { 24. } else { 20. }))
                .rounded(px(if active { 12. } else { 10. }))
                .bg(rgb(((r as u32) << 16) | ((g as u32) << 8) | (b as u32)))
                .border_1()
                .border_color(if active {
                    rgb(ACCENT)
                } else {
                    rgb(0xBBBBBB)
                });
            let hex_owned = hex.to_string();
            toolbar = toolbar.child(swatch.id(SharedString::from(format!("swatch-{}", hex))).on_click(cx.listener(
                move |this, _event: &gpui::ClickEvent, _window, cx| {
                    this.pen_color = hex_owned.clone();
                    cx.notify();
                },
            )));
            }
        }
        toolbar = toolbar.child(toolbar_divider());
        // One "+" button opens the add menu; the seven add actions
        // live there instead of filling the toolbar.
        toolbar = toolbar.child(
            action_icon_button(Icon::Plus, 0x333333)
                .id("btn-add")
                .on_click(cx.listener(|this, _event: &gpui::ClickEvent, _window, cx| {
                    this.add_menu = !this.add_menu;
                    this.canvas_panel = false;
                    cx.notify();
                })),
        );
        // Group/ungroup/delete only appear while something is selected.
        if !board.selected.is_empty() {
            toolbar = toolbar.child(toolbar_divider());
            toolbar = toolbar
                .child(action_icon_button(Icon::Group, 0x333333).id("btn-group").on_click(cx.listener(
                    |this, _event: &gpui::ClickEvent, _window, cx| {
                        let grouped = this.shared.board.borrow_mut().group_selection();
                        this._status = match grouped {
                            Some(g) => format!("Grouped (group {}).", g),
                            None => "Select 2+ items to group.".to_string(),
                        };
                        this.save();
                        cx.notify();
                    },
                )))
                .child(action_icon_button(Icon::Ungroup, 0x333333).id("btn-ungroup").on_click(cx.listener(
                    |this, _event: &gpui::ClickEvent, _window, cx| {
                        this.shared.board.borrow_mut().ungroup_selection();
                        this._status = "Ungrouped.".to_string();
                        this.save();
                        cx.notify();
                    },
                )))
                .child(action_icon_button(Icon::Delete, 0x333333).id("btn-delete").on_click(cx.listener(
                    |this, _event: &gpui::ClickEvent, _window, cx| {
                        this.shared.board.borrow_mut().delete_selection();
                        this._status = "Deleted selection.".to_string();
                        this.save();
                        cx.notify();
                    },
                )));
        }
        toolbar = toolbar.child(toolbar_divider());
        toolbar = toolbar.child(action_icon_button(Icon::Hide, 0x333333).id("btn-hide").on_click(cx.listener(
            |_this, _event: &gpui::ClickEvent, window, cx| {
                window.minimize_window();
                cx.notify();
            },
        )));
        toolbar = toolbar.child(toolbar_divider());
        toolbar = toolbar.child(
            action_icon_button(Icon::Tune, 0x333333)
                .id("btn-canvas")
                .on_click(cx.listener(|this, _event: &gpui::ClickEvent, _window, cx| {
                    this.canvas_panel = !this.canvas_panel;
                    this.add_menu = false;
                    cx.notify();
                })),
        );

        // --- board area ---
        // The customisation panel, when open, sits above the interaction
        // surface so its buttons receive clicks.
        let mut board_area = div()
            .relative()
            .flex_1()
            .bg(board_bg)
            .child(back_canvas)
            .children(item_els)
            .child(front_canvas)
            .child(interaction);
        if self.canvas_panel {
            board_area = board_area.child(self.canvas_panel_el(cx));
        }
        if self.add_menu {
            board_area = board_area.child(self.add_menu_el(cx));
        }

        // --- bottom bars ---
        let mut root = div()
            .size_full()
            .flex()
            .flex_col()
            .bg(board_bg)
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
                // Esc closes the add menu, then the customisation panel.
                if key == "escape" && this.add_menu {
                    this.add_menu = false;
                    cx.notify();
                    return;
                }
                if key == "escape" && this.canvas_panel {
                    this.canvas_panel = false;
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
                    .bg(rgb(0xFFFFFF))
                    .border_b_1()
                    .border_color(rgb(0xE5E5EA))
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
                    .bg(rgb(0xFFFFFF))
                    .border_b_1()
                    .border_color(rgb(0xE5E5EA))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::BOLD)
                            .child("Editing note — Enter = new line, Esc = done".to_string()),
                    )
                    .child(div().text_size(px(13.)).child(format!("{}▍", text))),
            );
        }

        // --- media transport bar: shown when exactly one audio/video item
        // is selected. These buttons live outside the canvas, so unlike
        // in-card buttons they actually receive clicks.
        if board.selected.len() == 1 {
            let sel_id = board.selected[0];
            if let Some(item) = board.get(sel_id) {
                match &item.kind {
                    Kind::Audio { path } => {
                        let name = std::path::Path::new(path)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| path.clone());
                        let state = self.shared.audio.borrow().state();
                        let is_this_playing = self
                            .shared
                            .audio
                            .borrow()
                            .playing
                            .map(|pid| pid == sel_id)
                            .unwrap_or(false)
                            && state == Playback::Playing;
                        let label = match state {
                            Playback::Playing if is_this_playing => {
                                format!("{} — playing", name)
                            }
                            Playback::Paused if is_this_playing => {
                                format!("{} — paused", name)
                            }
                            _ => format!("{} — stopped", name),
                        };
                        let play_icon = if is_this_playing {
                            Icon::Pause
                        } else {
                            Icon::Play
                        };
                        root = root.child(
                            div()
                                .h(px(40.))
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .px(px(12.))
                                .bg(rgb(0xFFFFFF))
                                .border_t_1()
                                .border_color(rgb(0xE5E5EA))
                                .child(
                                    action_icon_button(play_icon, 0x1C1C1E)
                                        .id(SharedString::from("media-play"))
                                        .on_click(cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                                            this.toggle_audio(sel_id);
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    action_icon_button(Icon::Stop, 0x1C1C1E)
                                        .id(SharedString::from("media-stop"))
                                        .on_click(cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                                            this.stop_audio();
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .text_color(rgb(0x1C1C1E))
                                        .child(label),
                                ),
                        );
                    }
                    Kind::Video { source, remote, .. } => {
                        let name = if *remote {
                            domain_of(source)
                        } else {
                            std::path::Path::new(source)
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_else(|| source.clone())
                        };
                        root = root.child(
                            div()
                                .h(px(40.))
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .px(px(12.))
                                .bg(rgb(0xFFFFFF))
                                .border_t_1()
                                .border_color(rgb(0xE5E5EA))
                                .child(
                                    action_icon_button(Icon::Play, 0x1C1C1E)
                                        .id(SharedString::from("media-play"))
                                        .on_click(cx.listener(move |this, _event: &gpui::ClickEvent, _window, cx| {
                                            this.play_video(sel_id);
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .text_color(rgb(0x1C1C1E))
                                        .child(format!(
                                            "{} — plays in {}",
                                            name,
                                            if *remote { "your browser" } else { "your video player" }
                                        )),
                                ),
                        );
                    }
                    _ => {}
                }
            }
        }

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
