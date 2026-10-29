//! Board model: pure data + geometry, no GPUI in here on purpose.
//!
//! Everything in this file is unit-testable without a window, which is how
//! the pan/zoom, hit-testing, grouping and persistence logic is verified.

use serde::{Deserialize, Serialize};

/// A point in infinite board (world) coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Pt {
    pub x: f32,
    pub y: f32,
}

impl Pt {
    pub fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
    pub fn dist(self, other: Pt) -> f32 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2)).sqrt()
    }
}

/// Width/height in world units.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub w: f32,
    pub h: f32,
}

impl Size {
    pub fn new(w: f32, h: f32) -> Self {
        Self { w, h }
    }
}

/// Camera: which world point sits at the screen origin, and the zoom factor.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Camera {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            zoom: 1.0,
        }
    }
}

impl Camera {
    /// World -> screen, for a viewport whose top-left is the screen origin.
    pub fn to_screen(&self, p: Pt) -> Pt {
        Pt::new((p.x - self.x) * self.zoom, (p.y - self.y) * self.zoom)
    }

    /// Screen -> world.
    pub fn to_world(&self, p: Pt) -> Pt {
        Pt::new(p.x / self.zoom + self.x, p.y / self.zoom + self.y)
    }

    /// Zoom keeping the world point under `screen_pt` fixed on screen.
    pub fn zoom_at(&mut self, screen_pt: Pt, factor: f32) {
        let before = self.to_world(screen_pt);
        self.zoom = (self.zoom * factor).clamp(0.1, 8.0);
        let after = self.to_world(screen_pt);
        self.x += before.x - after.x;
        self.y += before.y - after.y;
    }

    pub fn pan_by_screen(&mut self, dx: f32, dy: f32) {
        self.x -= dx / self.zoom;
        self.y -= dy / self.zoom;
    }
}

pub type ItemId = u64;

/// Where a connector endpoint attaches: a fixed world point, or an item
/// (in which case it follows that item's centre when the item moves).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Anchor {
    Point(Pt),
    Item(ItemId),
}

/// Everything that can live on the board.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Kind {
    /// A text note. `size` is in world units at zoom 1.
    Text {
        text: String,
        bold: bool,
        size: f32,
        color: String,
    },
    /// An image loaded from a local file path.
    Image { path: String },
    /// A URL rendered as a preview card (domain + title when known).
    UrlCard {
        url: String,
        title: Option<String>,
        description: Option<String>,
    },
    /// A PDF dropped on the board. v0.1 shows it as a card (name + size)
    /// and opens it in the system viewer on double-click; rendering PDF
    /// pages inside the canvas is a follow-up, not a silent stub.
    PdfCard { path: String, size_bytes: u64 },
    /// A colour swatch, e.g. "#FF5733".
    Swatch { hex: String },
    /// An audio file dropped on the board. Plays inside QuickBoard.
    Audio { path: String },
    /// A video: a local file path, or a URL when `remote` is true.
    /// `size_bytes` is 0 for remote videos.
    Video {
        source: String,
        remote: bool,
        size_bytes: u64,
    },
    /// A freehand stroke. `marker` = thicker, translucent marker pen.
    Stroke {
        points: Vec<Pt>,
        color: String,
        width: f32,
        marker: bool,
    },
    /// A straight connector line with an arrow head at the end.
    Connector { from: Anchor, to: Anchor, color: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: ItemId,
    /// Top-left in world units. For strokes/connectors this is the bounding
    /// box top-left, recomputed when points change.
    pub pos: Pt,
    pub size: Size,
    /// Group id, if this item belongs to a group. Items sharing a group id
    /// move and select together.
    pub group: Option<u64>,
    pub kind: Kind,
}

impl Item {
    pub fn bounds(&self) -> (Pt, Size) {
        (self.pos, self.size)
    }

    pub fn centre(&self) -> Pt {
        Pt::new(self.pos.x + self.size.w / 2.0, self.pos.y + self.size.h / 2.0)
    }

    pub fn contains(&self, world: Pt) -> bool {
        match &self.kind {
            Kind::Stroke { points, width, .. } => {
                let tol = (width / 2.0 + 6.0).max(8.0);
                points.windows(2).any(|w| dist_to_segment(world, w[0], w[1]) <= tol)
                    || points.iter().any(|p| p.dist(world) <= tol)
            }
            Kind::Connector { .. } => {
                let (a, b) = (self.pos, Pt::new(self.pos.x + self.size.w, self.pos.y + self.size.h));
                // Connector bounds are stored as its line endpoints in pos/size
                // only when free-standing; anchored connectors are hit-tested
                // by the caller via `connector_endpoints`. Fall back to box.
                world.x >= a.x.min(b.x) - 8.0
                    && world.x <= a.x.max(b.x) + 8.0
                    && world.y >= a.y.min(b.y) - 8.0
                    && world.y <= a.y.max(b.y) + 8.0
            }
            _ => {
                world.x >= self.pos.x
                    && world.x <= self.pos.x + self.size.w
                    && world.y >= self.pos.y
                    && world.y <= self.pos.y + self.size.h
            }
        }
    }

    /// Recompute pos/size from stroke points. No-op for other kinds.
    pub fn refresh_stroke_bounds(&mut self) {
        if let Kind::Stroke { points, .. } = &self.kind {
            if points.is_empty() {
                return;
            }
            let min_x = points.iter().map(|p| p.x).fold(f32::INFINITY, f32::min);
            let min_y = points.iter().map(|p| p.y).fold(f32::INFINITY, f32::min);
            let max_x = points.iter().map(|p| p.x).fold(f32::NEG_INFINITY, f32::max);
            let max_y = points.iter().map(|p| p.y).fold(f32::NEG_INFINITY, f32::max);
            self.pos = Pt::new(min_x, min_y);
            self.size = Size::new((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
        }
    }
}

fn dist_to_segment(p: Pt, a: Pt, b: Pt) -> f32 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return p.dist(a);
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0);
    p.dist(Pt::new(a.x + t * dx, a.y + t * dy))
}

/// Parse "#RGB" / "#RRGGBB" (with or without '#') into (r, g, b).
/// Returns None for anything else, so bad input never becomes a swatch.
pub fn parse_hex(hex: &str) -> Option<(u8, u8, u8)> {
    let h = hex.trim().trim_start_matches('#');
    let expanded = match h.len() {
        3 => {
            let c: Vec<char> = h.chars().collect();
            format!("{}{}{}{}{}{}", c[0], c[0], c[1], c[1], c[2], c[2])
        }
        6 => h.to_string(),
        _ => return None,
    };
    if !expanded.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let r = u8::from_str_radix(&expanded[0..2], 16).ok()?;
    let g = u8::from_str_radix(&expanded[2..4], 16).ok()?;
    let b = u8::from_str_radix(&expanded[4..6], 16).ok()?;
    Some((r, g, b))
}

/// Normalise a hex colour to "#RRGGBB" uppercase, or None.
pub fn normalise_hex(hex: &str) -> Option<String> {
    parse_hex(hex).map(|(r, g, b)| format!("#{:02X}{:02X}{:02X}", r, g, b))
}

/// Which board item a dropped file becomes, from its extension alone.
/// The drop handler matches on this, so the mapping is tested here
/// rather than living inline in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropKind {
    Image,
    Pdf,
    Audio,
    Video,
    Text,
    Shortcut,
    Unknown,
}

pub fn drop_kind_for_ext(ext: &str) -> DropKind {
    match ext.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => DropKind::Image,
        "pdf" => DropKind::Pdf,
        "mp3" | "wav" | "flac" | "ogg" | "m4a" => DropKind::Audio,
        "mp4" | "mov" | "webm" | "mkv" | "avi" | "m4v" => DropKind::Video,
        "txt" | "md" => DropKind::Text,
        "url" | "webloc" => DropKind::Shortcut,
        _ => DropKind::Unknown,
    }
}

/// Pull a URL out of a dropped shortcut file: a Windows .url file
/// (`URL=...` line), a macOS .webloc plist (first http(s) string), or
/// a bare URL on its own. Anything else gives None.
pub fn extract_shortcut_url(content: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("URL=") {
            let url = rest.trim();
            if url.starts_with("http://") || url.starts_with("https://") {
                return Some(url.to_string());
            }
        }
    }
    // Bare URL, or a URL embedded in XML (a .webloc plist): take the
    // first http(s) token, cut at the first delimiter.
    for needle in ["https://", "http://"] {
        if let Some(pos) = content.find(needle) {
            let rest = &content[pos..];
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '<' || c == '"' || c == '\'')
                .unwrap_or(rest.len());
            let url = &rest[..end];
            if url.len() > needle.len() + 1 {
                return Some(url.to_string());
            }
        }
    }
    None
}

/// A text file whose whole content is a colour code drops as a
/// swatch instead of a note.
pub fn swatch_hex_from_text(content: &str) -> Option<String> {
    normalise_hex(content.trim())
}

/// How the canvas grid is drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GridMode {
    Lines,
    Dots,
    Off,
}

impl Default for GridMode {
    fn default() -> Self {
        GridMode::Lines
    }
}

fn default_bg() -> String {
    "#F7F5F0".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Board {
    pub items: Vec<Item>,
    pub camera: Camera,
    #[serde(default)]
    pub next_id: ItemId,
    #[serde(default)]
    pub next_group: u64,
    /// Transient selection, never persisted.
    #[serde(skip)]
    pub selected: Vec<ItemId>,
    /// Canvas background colour (hex). Old boards load as paper.
    #[serde(default = "default_bg")]
    pub bg: String,
    /// Canvas grid style. Old boards load as lines.
    #[serde(default)]
    pub grid: GridMode,
}

impl Default for Board {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            camera: Camera::default(),
            next_id: 0,
            next_group: 0,
            selected: Vec::new(),
            bg: default_bg(),
            grid: GridMode::default(),
        }
    }
}

impl Board {
    pub fn new() -> Self {
        Self::default()
    }

    fn alloc_id(&mut self) -> ItemId {
        self.next_id += 1;
        self.next_id
    }

    pub fn get(&self, id: ItemId) -> Option<&Item> {
        self.items.iter().find(|i| i.id == id)
    }

    pub fn get_mut(&mut self, id: ItemId) -> Option<&mut Item> {
        self.items.iter_mut().find(|i| i.id == id)
    }

    /// Resolve a connector endpoint to a world point.
    pub fn anchor_point(&self, anchor: Anchor) -> Option<Pt> {
        match anchor {
            Anchor::Point(p) => Some(p),
            Anchor::Item(id) => self.get(id).map(|i| i.centre()),
        }
    }

    /// Whether `world` grabs this item. Connectors are tested against
    /// their live endpoints, not their stored box: an endpoint anchored
    /// to an item moves with that item, while the stored box is only set
    /// at creation time — testing the box made anchored connectors
    /// unselectable (and unmovable) after their items moved.
    fn item_hit(&self, item: &Item, world: Pt) -> bool {
        if let Kind::Connector { from, to, .. } = &item.kind {
            if let (Some(a), Some(b)) = (self.anchor_point(*from), self.anchor_point(*to)) {
                return dist_to_segment(world, a, b) <= 8.0;
            }
        }
        item.contains(world)
    }

    /// Live bounds for an item: connectors use their current endpoints.
    pub fn item_bounds(&self, item: &Item) -> (Pt, Size) {
        if let Kind::Connector { from, to, .. } = &item.kind {
            if let (Some(a), Some(b)) = (self.anchor_point(*from), self.anchor_point(*to)) {
                let m = 8.0;
                let x = a.x.min(b.x) - m;
                let y = a.y.min(b.y) - m;
                return (
                    Pt::new(x, y),
                    Size::new(a.x.max(b.x) - x + m, a.y.max(b.y) - y + m),
                );
            }
        }
        item.bounds()
    }

    /// Topmost item under a world point, if any.
    pub fn hit_test(&self, world: Pt) -> Option<ItemId> {
        self.items.iter().rev().find(|i| self.item_hit(i, world)).map(|i| i.id)
    }

    /// All items intersecting a marquee rectangle (world coords).
    pub fn marquee(&self, a: Pt, b: Pt) -> Vec<ItemId> {
        let (x0, x1) = if a.x < b.x { (a.x, b.x) } else { (b.x, a.x) };
        let (y0, y1) = if a.y < b.y { (a.y, b.y) } else { (b.y, a.y) };
        self.items
            .iter()
            .filter(|i| {
                let (p, s) = self.item_bounds(i);
                p.x < x1 && p.x + s.w > x0 && p.y < y1 && p.y + s.h > y0
            })
            .map(|i| i.id)
            .collect()
    }

    /// Select an item; if it belongs to a group, select the whole group.
    pub fn select(&mut self, id: ItemId, additive: bool) {
        if !additive {
            self.selected.clear();
        }
        let group = self.get(id).and_then(|i| i.group);
        match group {
            Some(g) => {
                for item in &self.items {
                    if item.group == Some(g) && !self.selected.contains(&item.id) {
                        self.selected.push(item.id);
                    }
                }
            }
            None => {
                if !self.selected.contains(&id) {
                    self.selected.push(id);
                }
            }
        }
    }

    pub fn move_selection(&mut self, dx: f32, dy: f32) {
        for item in self.items.iter_mut() {
            if self.selected.contains(&item.id) {
                item.pos.x += dx;
                item.pos.y += dy;
                if let Kind::Stroke { points, .. } = &mut item.kind {
                    for p in points.iter_mut() {
                        p.x += dx;
                        p.y += dy;
                    }
                }
                if let Kind::Connector { from, to, .. } = &mut item.kind {
                    if let Anchor::Point(p) = from {
                        p.x += dx;
                        p.y += dy;
                    }
                    if let Anchor::Point(p) = to {
                        p.x += dx;
                        p.y += dy;
                    }
                }
            }
        }
    }

    /// Resize one item to `new_w` × `new_h` world units (clamped to a
    /// 48-unit minimum). Strokes scale their points about the item's
    /// top-left; connectors scale their free (Point) endpoints about
    /// the connector's box origin, while item-anchored endpoints stay
    /// pinned to their items; everything else just changes size.
    pub fn resize_item(&mut self, id: ItemId, new_w: f32, new_h: f32) {
        let new_w = new_w.max(48.0);
        let new_h = new_h.max(48.0);
        let Some(item) = self.get(id) else {
            return;
        };
        let (ox, oy, ow, oh) = (item.pos.x, item.pos.y, item.size.w, item.size.h);
        let Some(item) = self.get_mut(id) else {
            return;
        };
        match &mut item.kind {
            Kind::Stroke { points, .. } => {
                if ow > 0.0 && oh > 0.0 {
                    let sx = new_w / ow;
                    let sy = new_h / oh;
                    for p in points.iter_mut() {
                        p.x = ox + (p.x - ox) * sx;
                        p.y = oy + (p.y - oy) * sy;
                    }
                }
            }
            Kind::Connector { from, to, .. } => {
                if ow > 0.0 && oh > 0.0 {
                    let sx = new_w / ow;
                    let sy = new_h / oh;
                    if let Anchor::Point(p) = from {
                        p.x = ox + (p.x - ox) * sx;
                        p.y = oy + (p.y - oy) * sy;
                    }
                    if let Anchor::Point(p) = to {
                        p.x = ox + (p.x - ox) * sx;
                        p.y = oy + (p.y - oy) * sy;
                    }
                }
            }
            _ => {}
        }
        if matches!(item.kind, Kind::Stroke { .. }) {
            item.refresh_stroke_bounds();
        }
        item.size = Size::new(new_w, new_h);
    }

    pub fn delete_selection(&mut self) {
        self.items.retain(|i| !self.selected.contains(&i.id));
        self.selected.clear();
    }

    /// Group the current selection. Returns the group id, if >= 2 items.
    pub fn group_selection(&mut self) -> Option<u64> {
        if self.selected.len() < 2 {
            return None;
        }
        self.next_group += 1;
        let g = self.next_group;
        for item in self.items.iter_mut() {
            if self.selected.contains(&item.id) {
                item.group = Some(g);
            }
        }
        Some(g)
    }

    pub fn ungroup_selection(&mut self) {
        let groups: Vec<u64> = self
            .selected
            .iter()
            .filter_map(|id| self.get(*id).and_then(|i| i.group))
            .collect();
        for item in self.items.iter_mut() {
            if let Some(g) = item.group {
                if groups.contains(&g) {
                    item.group = None;
                }
            }
        }
    }

    pub fn add_text(&mut self, at: Pt, text: &str) -> ItemId {
        let id = self.alloc_id();
        // Rough width estimate; the UI measures real text, this is the model box.
        let lines = text.lines().count().max(1) as f32;
        let longest = text.lines().map(|l| l.chars().count()).max().unwrap_or(0) as f32;
        self.items.push(Item {
            id,
            pos: at,
            size: Size::new((longest * 9.0 + 24.0).max(120.0), (lines * 27.0 + 22.0).max(48.0)),
            group: None,
            kind: Kind::Text {
                text: text.to_string(),
                bold: false,
                size: 16.0,
                color: "#1A1A1A".to_string(),
            },
        });
        id
    }

    pub fn add_url(&mut self, at: Pt, url: &str) -> ItemId {
        let id = self.alloc_id();
        self.items.push(Item {
            id,
            pos: at,
            size: Size::new(300.0, 108.0),
            group: None,
            kind: Kind::UrlCard {
                url: url.trim().to_string(),
                title: None,
                description: None,
            },
        });
        id
    }

    pub fn add_swatch(&mut self, at: Pt, hex: &str) -> Option<ItemId> {
        let hex = normalise_hex(hex)?;
        let id = self.alloc_id();
        self.items.push(Item {
            id,
            pos: at,
            size: Size::new(120.0, 120.0),
            group: None,
            kind: Kind::Swatch { hex },
        });
        Some(id)
    }

    pub fn add_audio(&mut self, at: Pt, path: &str) -> ItemId {
        let id = self.alloc_id();
        self.items.push(Item {
            id,
            pos: at,
            size: Size::new(300.0, 96.0),
            group: None,
            kind: Kind::Audio {
                path: path.to_string(),
            },
        });
        id
    }

    pub fn add_video(&mut self, at: Pt, source: &str, remote: bool, size_bytes: u64) -> ItemId {
        let id = self.alloc_id();
        self.items.push(Item {
            id,
            pos: at,
            // Big preview card: a 16:9 thumb on top plus text below.
            size: Size::new(360.0, 264.0),
            group: None,
            kind: Kind::Video {
                source: source.to_string(),
                remote,
                size_bytes,
            },
        });
        id
    }

    pub fn add_pdf(&mut self, at: Pt, path: &str, size_bytes: u64) -> ItemId {
        let id = self.alloc_id();
        self.items.push(Item {
            id,
            pos: at,
            size: Size::new(260.0, 96.0),
            group: None,
            kind: Kind::PdfCard {
                path: path.to_string(),
                size_bytes,
            },
        });
        id
    }

    pub fn add_image(&mut self, at: Pt, path: &str, w: f32, h: f32) -> ItemId {
        let id = self.alloc_id();
        self.items.push(Item {
            id,
            pos: at,
            size: Size::new(w.max(40.0), h.max(40.0)),
            group: None,
            kind: Kind::Image {
                path: path.to_string(),
            },
        });
        id
    }

    pub fn add_stroke(&mut self, points: Vec<Pt>, color: &str, width: f32, marker: bool) -> Option<ItemId> {
        if points.len() < 2 {
            return None;
        }
        let id = self.alloc_id();
        let mut item = Item {
            id,
            pos: Pt::default(),
            size: Size::default(),
            group: None,
            kind: Kind::Stroke {
                points,
                color: color.to_string(),
                width,
                marker,
            },
        };
        item.refresh_stroke_bounds();
        self.items.push(item);
        Some(id)
    }

    pub fn add_connector(&mut self, from: Anchor, to: Anchor) -> ItemId {
        let id = self.alloc_id();
        let a = self.anchor_point(from).unwrap_or_default();
        let b = self.anchor_point(to).unwrap_or_default();
        self.items.push(Item {
            id,
            pos: Pt::new(a.x.min(b.x), a.y.min(b.y)),
            size: Size::new((b.x - a.x).abs().max(1.0), (b.y - a.y).abs().max(1.0)),
            group: None,
            kind: Kind::Connector {
                from,
                to,
                color: "#333333".to_string(),
            },
        });
        id
    }

    /// A starter board so a first run is never an empty void.
    pub fn welcome() -> Self {
        let mut board = Self::new();
        board.add_text(
            Pt::new(40.0, 40.0),
            "Welcome to QuickBoard\nEvery element, on one board:\na note, a link card, a swatch,\na PDF card and a picture.\nDrop your own files onto the canvas.",
        );
        board.add_swatch(Pt::new(40.0, 240.0), "#FF6B35");
        board.add_swatch(Pt::new(180.0, 240.0), "#2E86AB");
        board.add_url(Pt::new(340.0, 240.0), "https://example.com");
        board
    }

    /// The welcome board plus the showcase pieces: a real PDF card, a
    /// picture, and a connector from the note to the link card, so a first
    /// run shows what every element looks like. Item ids in `welcome()` are
    /// 1 (note), 2–3 (swatches), 4 (link), so the connector anchors 1 → 4.
    pub fn welcome_showcase(image_path: &str, pdf_path: &str, pdf_bytes: u64) -> Self {
        let mut board = Self::welcome();
        board.add_pdf(Pt::new(660.0, 240.0), pdf_path, pdf_bytes);
        board.add_image(Pt::new(40.0, 400.0), image_path, 360.0, 225.0);
        board.add_connector(Anchor::Item(1), Anchor::Item(4));
        board
    }

    pub fn to_json(&self) -> anyhow::Result<String> {
        Ok(serde_json::to_string_pretty(self)?)
    }

    pub fn from_json(s: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(s)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_kind_covers_every_supported_type() {
        for ext in ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] {
            assert_eq!(drop_kind_for_ext(ext), DropKind::Image, "{ext}");
        }
        assert_eq!(drop_kind_for_ext("pdf"), DropKind::Pdf);
        for ext in ["mp3", "wav", "flac", "ogg", "m4a"] {
            assert_eq!(drop_kind_for_ext(ext), DropKind::Audio, "{ext}");
        }
        for ext in ["mp4", "mov", "webm", "mkv", "avi", "m4v"] {
            assert_eq!(drop_kind_for_ext(ext), DropKind::Video, "{ext}");
        }
        for ext in ["txt", "md"] {
            assert_eq!(drop_kind_for_ext(ext), DropKind::Text, "{ext}");
        }
        for ext in ["url", "webloc"] {
            assert_eq!(drop_kind_for_ext(ext), DropKind::Shortcut, "{ext}");
        }
        assert_eq!(drop_kind_for_ext("zip"), DropKind::Unknown);
        assert_eq!(drop_kind_for_ext(""), DropKind::Unknown);
        // Case-insensitive: the handler need not lowercase first.
        assert_eq!(drop_kind_for_ext("PNG"), DropKind::Image);
        assert_eq!(drop_kind_for_ext("PDF"), DropKind::Pdf);
    }

    #[test]
    fn shortcut_url_extraction() {
        let url_file = "[InternetShortcut]\nURL=https://example.com/some/article\n";
        assert_eq!(
            extract_shortcut_url(url_file).as_deref(),
            Some("https://example.com/some/article")
        );
        let webloc = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist><dict><key>URL</key><string>https://example.com/page</string></dict></plist>";
        assert_eq!(
            extract_shortcut_url(webloc).as_deref(),
            Some("https://example.com/page")
        );
        assert_eq!(
            extract_shortcut_url("https://example.com/bare").as_deref(),
            Some("https://example.com/bare")
        );
        assert_eq!(extract_shortcut_url("just some notes"), None);
        assert_eq!(extract_shortcut_url("[InternetShortcut]\nURL=not-a-url\n"), None);
    }

    #[test]
    fn hex_text_file_becomes_a_swatch() {
        assert_eq!(
            swatch_hex_from_text("#FF6B35").as_deref(),
            Some("#FF6B35")
        );
        assert_eq!(
            swatch_hex_from_text("  ff6b35\n").as_deref(),
            Some("#FF6B35")
        );
        assert_eq!(swatch_hex_from_text("hello world"), None);
        assert_eq!(swatch_hex_from_text("#FF6B35 and more"), None);
    }

    #[test]
    fn camera_round_trips_and_zoom_keeps_cursor_point() {
        let mut cam = Camera {
            x: 100.0,
            y: 50.0,
            zoom: 1.0,
        };
        let screen = Pt::new(200.0, 150.0);
        let world_before = cam.to_world(screen);
        cam.zoom_at(screen, 2.0);
        assert_eq!(cam.zoom, 2.0);
        let world_after = cam.to_world(screen);
        assert!((world_before.x - world_after.x).abs() < 0.001);
        assert!((world_before.y - world_after.y).abs() < 0.001);
        // And back again.
        let p = Pt::new(42.0, 17.0);
        let s = cam.to_screen(p);
        let back = cam.to_world(s);
        assert!((p.x - back.x).abs() < 0.001);
    }

    #[test]
    fn zoom_clamps() {
        let mut cam = Camera::default();
        cam.zoom_at(Pt::new(0.0, 0.0), 0.001);
        assert_eq!(cam.zoom, 0.1);
        cam.zoom_at(Pt::new(0.0, 0.0), 1000.0);
        assert_eq!(cam.zoom, 8.0);
    }

    #[test]
    fn hex_parsing() {
        assert_eq!(parse_hex("#FF5733"), Some((255, 87, 51)));
        assert_eq!(parse_hex("f53"), Some((255, 85, 51)));
        assert_eq!(parse_hex("#zzzzzz"), None);
        assert_eq!(parse_hex("not a colour"), None);
        assert_eq!(normalise_hex("#f53"), Some("#FF5533".to_string()));
    }

    #[test]
    fn grouping_moves_and_selects_together() {
        let mut b = Board::new();
        let a = b.add_text(Pt::new(0.0, 0.0), "a");
        let c = b.add_text(Pt::new(100.0, 0.0), "b");
        b.selected = vec![a, c];
        assert!(b.group_selection().is_some());
        b.selected.clear();
        b.select(a, false);
        assert_eq!(b.selected.len(), 2);
        b.move_selection(10.0, 5.0);
        assert_eq!(b.get(a).unwrap().pos.x, 10.0);
        assert_eq!(b.get(c).unwrap().pos.x, 110.0);
        b.ungroup_selection();
        assert_eq!(b.get(a).unwrap().group, None);
    }

    #[test]
    fn stroke_hit_and_bounds() {
        let mut b = Board::new();
        let id = b
            .add_stroke(vec![Pt::new(0.0, 0.0), Pt::new(100.0, 0.0)], "#000000", 3.0, false)
            .unwrap();
        assert_eq!(b.hit_test(Pt::new(50.0, 2.0)), Some(id));
        assert_eq!(b.hit_test(Pt::new(50.0, 50.0)), None);
        let item = b.get(id).unwrap();
        assert_eq!(item.size.w, 100.0);
    }

    #[test]
    fn board_json_round_trip() {
        let b = Board::welcome();
        let json = b.to_json().unwrap();
        let back = Board::from_json(&json).unwrap();
        assert_eq!(back.items.len(), b.items.len());
        // Selection is transient and must not survive a save/load.
        assert!(back.selected.is_empty());
    }

    #[test]
    fn marquee_selects_intersecting_only() {
        let mut b = Board::new();
        let inside = b.add_text(Pt::new(10.0, 10.0), "in");
        let _outside = b.add_text(Pt::new(500.0, 500.0), "out");
        let hits = b.marquee(Pt::new(0.0, 0.0), Pt::new(200.0, 200.0));
        assert_eq!(hits, vec![inside]);
    }

    #[test]
    fn connector_hit_follows_anchored_items() {
        // A note plus a connector anchored to it and to a free point.
        let mut b = Board::new();
        let note = b.add_text(Pt::new(100.0, 100.0), "hi");
        let conn = b.add_connector(Anchor::Item(note), Anchor::Point(Pt::new(400.0, 100.0)));
        // The note's centre is its anchor point; the line runs from there.
        let centre = b.get(note).unwrap().centre();
        let mid = Pt::new((centre.x + 400.0) / 2.0, (centre.y + 100.0) / 2.0);
        assert_eq!(b.hit_test(mid), Some(conn));
        // Move the note far away: the connector's grab line must move
        // with it, and the old line must stop grabbing.
        b.select(note, false);
        b.move_selection(200.0, 200.0);
        let new_centre = b.get(note).unwrap().centre();
        let new_mid = Pt::new((new_centre.x + 400.0) / 2.0, (new_centre.y + 100.0) / 2.0);
        assert_eq!(b.hit_test(new_mid), Some(conn));
        assert_ne!(b.hit_test(mid), Some(conn));
        // The marquee uses the live line too.
        let hits = b.marquee(
            Pt::new(new_mid.x - 5.0, new_mid.y - 5.0),
            Pt::new(new_mid.x + 5.0, new_mid.y + 5.0),
        );
        assert!(hits.contains(&conn));
    }

    #[test]
    fn resize_scales_strokes_and_cards() {
        let mut b = Board::new();
        let stroke = b
            .add_stroke(vec![Pt::new(0.0, 0.0), Pt::new(100.0, 50.0)], "#000000", 3.0, false)
            .unwrap();
        b.resize_item(stroke, 200.0, 100.0);
        let item = b.get(stroke).unwrap();
        assert_eq!(item.size.w, 200.0);
        assert_eq!(item.size.h, 100.0);
        if let Kind::Stroke { points, .. } = &item.kind {
            assert_eq!(points[1], Pt::new(200.0, 100.0));
        } else {
            panic!("expected a stroke");
        }
        let card = b.add_text(Pt::new(10.0, 10.0), "hi");
        b.resize_item(card, 10.0, 10.0); // clamped to the minimum
        let item = b.get(card).unwrap();
        assert_eq!(item.size.w, 48.0);
        assert_eq!(item.size.h, 48.0);
    }

    #[test]
    fn canvas_settings_default_for_old_boards() {
        // A board saved before canvas settings existed has neither field.
        let json = r#"{"items":[],"camera":{"x":0.0,"y":0.0,"zoom":1.0},"next_id":0,"next_group":0}"#;
        let b = Board::from_json(json).unwrap();
        assert_eq!(b.bg, "#F7F5F0");
        assert_eq!(b.grid, GridMode::Lines);
        let json = r##"{"items":[],"camera":{"x":0.0,"y":0.0,"zoom":1.0},"next_id":0,"next_group":0,"bg":"#EAF3EC","grid":"Dots"}"##;
        let b = Board::from_json(json).unwrap();
        assert_eq!(b.bg, "#EAF3EC");
        assert_eq!(b.grid, GridMode::Dots);
    }
}
