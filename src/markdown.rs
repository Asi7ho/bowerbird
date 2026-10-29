//! Tiny markdown for notes: headings, bullets, ordered lists, quotes,
//! fenced code blocks, and inline bold / italic / code / links /
//! strikethrough. Deliberately small and flat — no nesting inside a
//! formatted span, and `_italic_` is not supported (underscores inside
//! words like `my_var_name` must stay literal). Unclosed markers and
//! markers around whitespace stay literal too, so `2 * 3 * 4` never
//! becomes emphasis by accident.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub link: bool,
    pub strike: bool,
}

impl Segment {
    fn plain(text: &str) -> Self {
        Segment {
            text: text.to_string(),
            bold: false,
            italic: false,
            code: false,
            link: false,
            strike: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    Heading { level: u8, segments: Vec<Segment> },
    Bullet { segments: Vec<Segment> },
    Ordered { n: u32, segments: Vec<Segment> },
    Quote { segments: Vec<Segment> },
    Code { lines: Vec<String> },
    Paragraph { segments: Vec<Segment> },
}

pub fn parse_markdown(text: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut code_lines: Option<Vec<String>> = None;
    for raw in text.lines() {
        if let Some(code) = &mut code_lines {
            if raw.trim_start().starts_with("```") {
                blocks.push(Block::Code {
                    lines: std::mem::take(code),
                });
                code_lines = None;
            } else {
                code.push(raw.to_string());
            }
            continue;
        }
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") {
            code_lines = Some(Vec::new());
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=3).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
            blocks.push(Block::Heading {
                level: hashes as u8,
                segments: parse_inline(trimmed[hashes + 1..].trim()),
            });
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("> ") {
            blocks.push(Block::Quote {
                segments: parse_inline(rest),
            });
            continue;
        }
        if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            blocks.push(Block::Bullet {
                segments: parse_inline(rest),
            });
            continue;
        }
        if let Some((n, rest)) = parse_ordered(trimmed) {
            blocks.push(Block::Ordered {
                n,
                segments: parse_inline(rest),
            });
            continue;
        }
        blocks.push(Block::Paragraph {
            segments: parse_inline(trimmed),
        });
    }
    if let Some(code) = code_lines {
        blocks.push(Block::Code { lines: code });
    }
    blocks
}

fn parse_ordered(line: &str) -> Option<(u32, &str)> {
    let digits: String = line.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = line[digits.len()..].strip_prefix(". ")?;
    Some((digits.parse().ok()?, rest))
}

/// Parse one line's inline formatting. Markers must close on the same
/// line; bold/italic/strike content may not start or end with
/// whitespace, so `* 3 *` stays literal.
pub fn parse_inline(text: &str) -> Vec<Segment> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<Segment> = Vec::new();
    let mut buf = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\'
            && i + 1 < chars.len()
            && matches!(chars[i + 1], '*' | '`' | '[' | ']' | '~' | '\\')
        {
            buf.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if c == '[' {
            if let Some((label, after)) = parse_link(&chars, i) {
                if !buf.is_empty() {
                    out.push(Segment::plain(&buf));
                    buf.clear();
                }
                out.push(Segment {
                    text: label,
                    bold: false,
                    italic: false,
                    code: false,
                    link: true,
                    strike: false,
                });
                i = after;
                continue;
            }
            buf.push(c);
            i += 1;
            continue;
        }
        // Bold, then strike, then code, then italic — in that order so
        // `**` is never mistaken for two italic markers.
        if c == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            if let Some(end) = find_marker(&chars, i + 2, "**") {
                let inner: String = chars[i + 2..end].iter().collect();
                if !inner.is_empty() && !edge_space(&inner) {
                    if !buf.is_empty() {
                        out.push(Segment::plain(&buf));
                        buf.clear();
                    }
                    out.push(Segment {
                        text: inner,
                        bold: true,
                        italic: false,
                        code: false,
                        link: false,
                        strike: false,
                    });
                    i = end + 2;
                    continue;
                }
            }
            buf.push(c);
            i += 1;
            continue;
        }
        if c == '~' && i + 1 < chars.len() && chars[i + 1] == '~' {
            if let Some(end) = find_marker(&chars, i + 2, "~~") {
                let inner: String = chars[i + 2..end].iter().collect();
                if !inner.is_empty() && !edge_space(&inner) {
                    if !buf.is_empty() {
                        out.push(Segment::plain(&buf));
                        buf.clear();
                    }
                    out.push(Segment {
                        text: inner,
                        bold: false,
                        italic: false,
                        code: false,
                        link: false,
                        strike: true,
                    });
                    i = end + 2;
                    continue;
                }
            }
            buf.push(c);
            i += 1;
            continue;
        }
        if c == '`' {
            if let Some(end) = find_char(&chars, i + 1, '`') {
                let inner: String = chars[i + 1..end].iter().collect();
                if !inner.is_empty() {
                    if !buf.is_empty() {
                        out.push(Segment::plain(&buf));
                        buf.clear();
                    }
                    out.push(Segment {
                        text: inner,
                        bold: false,
                        italic: false,
                        code: true,
                        link: false,
                        strike: false,
                    });
                    i = end + 1;
                    continue;
                }
            }
            buf.push(c);
            i += 1;
            continue;
        }
        if c == '*' {
            if let Some(end) = find_char(&chars, i + 1, '*') {
                let inner: String = chars[i + 1..end].iter().collect();
                if !inner.is_empty() && !edge_space(&inner) && !inner.contains('*') {
                    if !buf.is_empty() {
                        out.push(Segment::plain(&buf));
                        buf.clear();
                    }
                    out.push(Segment {
                        text: inner,
                        bold: false,
                        italic: true,
                        code: false,
                        link: false,
                        strike: false,
                    });
                    i = end + 1;
                    continue;
                }
            }
            buf.push(c);
            i += 1;
            continue;
        }
        buf.push(c);
        i += 1;
    }
    if !buf.is_empty() {
        out.push(Segment::plain(&buf));
    }
    out
}

fn edge_space(s: &str) -> bool {
    s.starts_with(char::is_whitespace) || s.ends_with(char::is_whitespace)
}

fn find_marker(chars: &[char], from: usize, marker: &str) -> Option<usize> {
    let m: Vec<char> = marker.chars().collect();
    if chars.len() < from + m.len() {
        return None;
    }
    (from..=chars.len() - m.len()).find(|&i| chars[i..i + m.len()] == m[..])
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    (from..chars.len()).find(|&i| chars[i] == target)
}

/// `[label](url)` starting at `i` (which must be `[`): returns the
/// label and the index just past the closing paren. The URL itself is
/// not kept — notes render links, they don't navigate.
fn parse_link(chars: &[char], i: usize) -> Option<(String, usize)> {
    let close = find_char(chars, i + 1, ']')?;
    if close + 1 >= chars.len() || chars[close + 1] != '(' {
        return None;
    }
    let paren = find_char(chars, close + 2, ')')?;
    let label: String = chars[i + 1..close].iter().collect();
    if label.is_empty() {
        return None;
    }
    Some((label, paren + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(segments: &[Segment]) -> Vec<(&str, bool, bool, bool, bool, bool)> {
        segments
            .iter()
            .map(|s| {
                (
                    s.text.as_str(),
                    s.bold,
                    s.italic,
                    s.code,
                    s.link,
                    s.strike,
                )
            })
            .collect()
    }

    #[test]
    fn blocks_from_lines() {
        let blocks = parse_markdown("# Title\n## Sub\npara\n- one\n* two\n1. first\n12. twelfth\n> quoted\n\n```\ncode();\n```");
        assert_eq!(blocks.len(), 9);
        assert!(matches!(blocks[0], Block::Heading { level: 1, .. }));
        assert!(matches!(blocks[1], Block::Heading { level: 2, .. }));
        assert!(matches!(blocks[2], Block::Paragraph { .. }));
        assert!(matches!(blocks[3], Block::Bullet { .. }));
        assert!(matches!(blocks[4], Block::Bullet { .. }));
        assert!(matches!(
            blocks[5],
            Block::Ordered { n: 1, .. }
        ));
        assert!(matches!(
            blocks[6],
            Block::Ordered { n: 12, .. }
        ));
        assert!(matches!(blocks[7], Block::Quote { .. }));
        assert!(matches!(blocks[8], Block::Code { .. }));
        // Four hashes is not a heading.
        assert!(matches!(
            parse_markdown("#### deep")[0],
            Block::Paragraph { .. }
        ));
    }

    #[test]
    fn inline_formats() {
        let segs = parse_inline("Hello **bold** and *italic* and `code` and [link](https://x.test) and ~~gone~~.");
        assert_eq!(
            texts(&segs),
            vec![
                ("Hello ", false, false, false, false, false),
                ("bold", true, false, false, false, false),
                (" and ", false, false, false, false, false),
                ("italic", false, true, false, false, false),
                (" and ", false, false, false, false, false),
                ("code", false, false, true, false, false),
                (" and ", false, false, false, false, false),
                ("link", false, false, false, true, false),
                (" and ", false, false, false, false, false),
                ("gone", false, false, false, false, true),
                (".", false, false, false, false, false),
            ]
        );
    }

    #[test]
    fn markers_stay_literal_when_they_should() {
        // Unclosed markers.
        assert_eq!(
            texts(&parse_inline("a **bold and *italic")),
            vec![("a **bold and *italic", false, false, false, false, false)]
        );
        // Multiplication is not emphasis.
        assert_eq!(
            texts(&parse_inline("2 * 3 * 4")),
            vec![("2 * 3 * 4", false, false, false, false, false)]
        );
        // Underscores inside words stay literal.
        assert_eq!(
            texts(&parse_inline("my_var_name")),
            vec![("my_var_name", false, false, false, false, false)]
        );
        // Empty markers stay literal.
        assert_eq!(
            texts(&parse_inline("****")),
            vec![("****", false, false, false, false, false)]
        );
        // Escapes work.
        assert_eq!(
            texts(&parse_inline("a \\*b\\* c")),
            vec![("a *b* c", false, false, false, false, false)]
        );
        // Broken link stays literal.
        assert_eq!(
            texts(&parse_inline("see [this] later")),
            vec![("see [this] later", false, false, false, false, false)]
        );
    }

    #[test]
    fn unclosed_fence_is_code_to_the_end() {
        let blocks = parse_markdown("```\nlet x = 1;");
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], Block::Code { .. }));
    }
}
