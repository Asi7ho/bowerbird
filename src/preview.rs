//! URL preview cards: domain extraction + title/description parsing.
//!
//! No HTML parser is pulled in for this: titles and Open Graph tags are
//! extracted with small, tested string scans, and anything unparseable
//! simply leaves the card showing its domain, never a crash.

/// "https://www.example.com/some/path?q=1" -> "example.com"
pub fn domain_of(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let host = after_scheme.split('/').next().unwrap_or(after_scheme);
    let host = host.split('?').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    host.strip_prefix("www.").unwrap_or(host).to_string()
}

fn tag_content<'a>(html: &'a str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let start = html.to_lowercase().find(&open)? + open.len();
    let rest = &html[start..];
    let end = rest.to_lowercase().find(&close)?;
    let raw = rest[..end].trim();
    if raw.is_empty() {
        None
    } else {
        Some(decode_entities(raw))
    }
}

fn meta_content(html: &str, property: &str) -> Option<String> {
    // Scan <meta ...> tags for property="og:title" (or name=) + content="...".
    let lower = html.to_lowercase();
    let mut cursor = 0;
    while let Some(start) = lower[cursor..].find("<meta") {
        let abs = cursor + start;
        let tag_end = lower[abs..].find('>')? + abs;
        let tag = &html[abs..=tag_end];
        let tag_lower = tag.to_lowercase();
        let wants = format!("property=\"{}\"", property);
        let wants_name = format!("name=\"{}\"", property);
        if tag_lower.contains(&wants) || tag_lower.contains(&wants_name) {
            if let Some(content) = attr_value(tag, "content") {
                if !content.trim().is_empty() {
                    return Some(decode_entities(content.trim()));
                }
            }
        }
        cursor = tag_end + 1;
    }
    None
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let needle = format!("{}=\"", attr);
    let start = lower.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// Best-effort (title, description) from a page's HTML.
pub fn parse_preview(html: &str) -> (Option<String>, Option<String>) {
    let title = meta_content(html, "og:title").or_else(|| tag_content(html, "title"));
    let description = meta_content(html, "og:description").or_else(|| meta_content(html, "description"));
    (title, description)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains() {
        assert_eq!(domain_of("https://www.example.com/a/b"), "example.com");
        assert_eq!(domain_of("http://blog.site.co.uk:8080/x"), "blog.site.co.uk");
        assert_eq!(domain_of("example.com/page"), "example.com");
    }

    #[test]
    fn preview_parsing_prefers_open_graph() {
        let html = r#"<html><head><title>Plain</title>
            <meta property="og:title" content="OG Title &amp; More">
            <meta property="og:description" content="A fine page.">
            </head></html>"#;
        let (title, desc) = parse_preview(html);
        assert_eq!(title.as_deref(), Some("OG Title & More"));
        assert_eq!(desc.as_deref(), Some("A fine page."));
    }

    #[test]
    fn preview_falls_back_to_title_and_survives_garbage() {
        let (title, desc) = parse_preview("<html><head><title>Only</title></head>");
        assert_eq!(title.as_deref(), Some("Only"));
        assert_eq!(desc, None);
        let (t2, d2) = parse_preview("not html at all {{{");
        assert_eq!(t2, None);
        assert_eq!(d2, None);
    }
}
