//! Note tags: what counts as a tag, and reading and writing tags in a plain
//! Markdown file's own YAML frontmatter.
//!
//! A `.mntl` note keeps its tags in [`crate::NoteFrontmatter::tags`]. A plain
//! Markdown file keeps them where Obsidian and similar tools do, in a `tags:`
//! key of its frontmatter. That frontmatter belongs to whatever tool wrote the
//! file, so [`set_markdown_tags`] edits only the `tags:` lines and leaves every
//! other byte alone.
//!
//! Tags are flat and match case-insensitively (`Idea` and `idea` are the same
//! tag), keeping the casing they were first written with.

use crate::properties::scalar;
use crate::split_frontmatter;
use serde_yaml::Value;

/// Clean up a tag the user typed, or `None` if it isn't a valid tag.
///
/// A leading `#` and surrounding whitespace are dropped. What remains must be
/// letters, digits, `-` and `_` only (so no spaces and no `/`: tags are flat),
/// with at least one character that isn't a digit, as in Obsidian.
///
/// Only input is held to this. Tags another tool wrote into a Markdown file
/// are read as they are, see [`markdown_tags`].
pub fn normalize_tag(raw: &str) -> Option<String> {
    let tag = raw.trim();
    let tag = tag.strip_prefix('#').unwrap_or(tag);
    let valid = !tag.is_empty()
        && tag.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        && !tag.chars().all(|c| c.is_ascii_digit());
    valid.then(|| tag.to_string())
}

/// Whether `a` and `b` name the same tag, i.e. are equal ignoring case.
pub fn same_tag(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// `tags` without case-insensitive duplicates, keeping the first spelling of
/// each and the original order.
pub fn dedupe_tags<I: IntoIterator<Item = String>>(tags: I) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for tag in tags {
        if !unique.iter().any(|seen| same_tag(seen, &tag)) {
            unique.push(tag);
        }
    }
    unique
}

/// The tags in a plain Markdown file's YAML frontmatter.
///
/// Reads the `tags:` key, or `tag:` if there is none, in the forms other tools
/// write: a list (`[a, b]` or one `- a` per line) or a single string of
/// comma- or space-separated tags. A leading `#` is dropped. Anything else, a
/// missing or malformed frontmatter included, is simply no tags.
pub fn markdown_tags(markdown: &str) -> Vec<String> {
    let Ok((yaml, _)) = split_frontmatter(markdown) else {
        return Vec::new();
    };
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(yaml) else {
        return Vec::new();
    };

    let raw: Vec<String> = match map.get("tags").or_else(|| map.get("tag")) {
        Some(Value::Sequence(items)) => items.iter().filter_map(scalar_to_string).collect(),
        Some(value) => scalar_to_string(value)
            .map(|s| {
                s.split(|c: char| c == ',' || c.is_whitespace())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        None => Vec::new(),
    };

    dedupe_tags(raw.into_iter().filter_map(|tag| {
        let tag = tag.trim();
        let tag = tag.strip_prefix('#').unwrap_or(tag);
        (!tag.is_empty()).then(|| tag.to_string())
    }))
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Rewrite a plain Markdown file so its frontmatter's tags are `tags`.
///
/// Only the lines of the existing `tags:` (or `tag:`) key change; every other
/// line of the frontmatter, and the body, is kept byte for byte. The key keeps
/// its style: a flow list (`tags: [a, b]`) stays one, anything else becomes a
/// block list. With no such key, a `tags:` block is appended to the
/// frontmatter, and a file with no frontmatter gets one. Setting no tags
/// removes the key.
pub fn set_markdown_tags(markdown: &str, tags: &[String]) -> String {
    crate::properties::edit_frontmatter_key(markdown, &["tags", "tag"], |style, newline| {
        if tags.is_empty() {
            return String::new();
        }
        match style {
            Some(style) => render_tags(style.key, tags, style.flow, style.indent.unwrap_or("  "), newline),
            None => render_tags("tags", tags, false, "  ", newline),
        }
    })
}

fn render_tags(key: &str, tags: &[String], flow: bool, indent: &str, newline: &str) -> String {
    if flow {
        let items: Vec<String> = tags.iter().map(|tag| flow_scalar(tag)).collect();
        return format!("{key}: [{}]{newline}", items.join(", "));
    }
    let mut out = format!("{key}:{newline}");
    for tag in tags {
        out.push_str(&format!("{indent}- {}{newline}", scalar(tag)));
    }
    out
}

/// Like [`scalar`], but also quoting the characters that end an item
/// inside a `[...]` flow list.
fn flow_scalar(tag: &str) -> String {
    let scalar = scalar(tag);
    if scalar.contains([',', '[', ']', '{', '}']) {
        double_quoted(tag)
    } else {
        scalar
    }
}

/// A JSON string is also a valid YAML double-quoted scalar.
fn double_quoted(tag: &str) -> String {
    serde_json::to_string(tag).unwrap_or_else(|_| format!("\"{tag}\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn normalize_tag_accepts_obsidian_style_tags() {
        assert_eq!(normalize_tag("  #idea "), Some("idea".into()));
        assert_eq!(normalize_tag("to-do_2"), Some("to-do_2".into()));
        assert_eq!(normalize_tag("Ärger"), Some("Ärger".into()));
        assert_eq!(normalize_tag("y2k"), Some("y2k".into()));
    }

    #[test]
    fn normalize_tag_rejects_invalid_tags() {
        for raw in ["", "#", "   ", "two words", "work/project", "1984", "a,b", "#x#y"] {
            assert_eq!(normalize_tag(raw), None, "{raw:?} should be rejected");
        }
    }

    #[test]
    fn dedupe_tags_is_case_insensitive_and_keeps_the_first_spelling() {
        assert_eq!(
            dedupe_tags(tags(&["Idea", "draft", "idea", "DRAFT", "x"])),
            tags(&["Idea", "draft", "x"])
        );
    }

    #[test]
    fn markdown_tags_reads_the_forms_other_tools_write() {
        let cases = [
            ("---\ntags: [a, b]\n---\nbody", vec!["a", "b"]),
            ("---\ntags:\n  - a\n  - '#b'\n---\n", vec!["a", "b"]),
            ("---\ntags:\n- a\n- b\n---\n", vec!["a", "b"]),
            ("---\ntags: a, b c\n---\n", vec!["a", "b", "c"]),
            ("---\ntag: solo\n---\n", vec!["solo"]),
            ("---\ntags: [2024, true]\n---\n", vec!["2024", "true"]),
            ("---\ntitle: x\n---\n", vec![]),
            ("---\n---\n", vec![]),
            ("# no frontmatter", vec![]),
            ("---\n: not [valid yaml\n---\n", vec![]),
        ];
        for (file, expected) in cases {
            assert_eq!(markdown_tags(file), tags(&expected), "{file:?}");
        }
    }

    #[test]
    fn set_markdown_tags_replaces_a_block_list_and_keeps_everything_else() {
        let file = "---\ntitle: Plan\ntags:\n  - old\n  - older\naliases: [p]\n---\nBody\n";
        let updated = set_markdown_tags(file, &tags(&["new", "idea"]));
        assert_eq!(
            updated,
            "---\ntitle: Plan\ntags:\n  - new\n  - idea\naliases: [p]\n---\nBody\n"
        );
        assert_eq!(markdown_tags(&updated), tags(&["new", "idea"]));
    }

    #[test]
    fn set_markdown_tags_keeps_a_flow_list_a_flow_list() {
        let file = "---\ntags: [a, b]\ntitle: x\n---\n";
        assert_eq!(
            set_markdown_tags(file, &tags(&["c"])),
            "---\ntags: [c]\ntitle: x\n---\n"
        );
    }

    #[test]
    fn set_markdown_tags_keeps_column_zero_list_items_at_column_zero() {
        let file = "---\ntags:\n- a\n---\n";
        assert_eq!(set_markdown_tags(file, &tags(&["a", "b"])), "---\ntags:\n- a\n- b\n---\n");
    }

    #[test]
    fn set_markdown_tags_turns_a_string_value_into_a_block_list() {
        let file = "---\ntags: a, b\n---\n";
        assert_eq!(set_markdown_tags(file, &tags(&["a"])), "---\ntags:\n  - a\n---\n");
    }

    #[test]
    fn set_markdown_tags_rewrites_a_singular_tag_key_in_place() {
        let file = "---\ntag: a\ntitle: x\n---\n";
        assert_eq!(
            set_markdown_tags(file, &tags(&["b"])),
            "---\ntag:\n  - b\ntitle: x\n---\n"
        );
    }

    #[test]
    fn set_markdown_tags_appends_a_key_to_frontmatter_without_one() {
        let file = "---\ntitle: x\n---\nBody";
        assert_eq!(
            set_markdown_tags(file, &tags(&["a"])),
            "---\ntitle: x\ntags:\n  - a\n---\nBody"
        );
    }

    #[test]
    fn set_markdown_tags_adds_frontmatter_to_a_file_without_any() {
        assert_eq!(set_markdown_tags("Body", &tags(&["a"])), "---\ntags:\n  - a\n---\nBody");
        assert_eq!(set_markdown_tags("Body", &[]), "Body");
    }

    #[test]
    fn set_markdown_tags_removes_the_key_when_no_tags_are_left() {
        let file = "---\ntitle: x\ntags:\n  - a\n\n  - b\nother: y\n---\nBody";
        assert_eq!(set_markdown_tags(file, &[]), "---\ntitle: x\nother: y\n---\nBody");
    }

    #[test]
    fn set_markdown_tags_keeps_crlf_line_endings() {
        let file = "---\r\ntitle: x\r\n---\r\nBody\r\n";
        assert_eq!(
            set_markdown_tags(file, &tags(&["a"])),
            "---\r\ntitle: x\r\ntags:\r\n  - a\r\n---\r\nBody\r\n"
        );
    }

    #[test]
    fn set_markdown_tags_quotes_tags_that_would_not_read_back_as_strings() {
        let odd = tags(&["true", "12", "#x", "a,b"]);
        let block = set_markdown_tags("Body", &odd);
        assert_eq!(markdown_tags(&block), tags(&["true", "12", "x", "a,b"]));
        let flow = set_markdown_tags("---\ntags: []\n---\n", &odd);
        assert_eq!(markdown_tags(&flow), tags(&["true", "12", "x", "a,b"]));
    }

    #[test]
    fn a_key_merely_starting_with_tags_is_left_alone() {
        let file = "---\ntagsline: keep\n---\n";
        assert_eq!(
            set_markdown_tags(file, &tags(&["a"])),
            "---\ntagsline: keep\ntags:\n  - a\n---\n"
        );
    }
}
