//! Note properties: the user's own frontmatter keys (`due`, `status`, ...).
//!
//! A `.mntl` note keeps them in [`crate::NoteFrontmatter::properties`]. A
//! plain Markdown file keeps them as top-level keys of its own frontmatter,
//! which belongs to whatever tool wrote the file, so [`set_markdown_property`]
//! rewrites only the lines of the one key it changes. Tags are a property too
//! but have their own handling, see [`crate::tags`].

use crate::split_frontmatter;
use serde_yaml::{Mapping, Value};

/// The properties in a plain Markdown file's frontmatter, in file order:
/// every top-level key with a string name except the one
/// [`crate::markdown_tags`] reads tags from.
///
/// `None` if the file has frontmatter that isn't a YAML mapping (malformed,
/// or a bare list): it's left untouched rather than guessed at. A file
/// without frontmatter has no properties.
pub fn markdown_properties(markdown: &str) -> Option<Vec<(String, Value)>> {
    let Ok((yaml, _)) = split_frontmatter(markdown) else {
        return Some(Vec::new());
    };
    let map = match serde_yaml::from_str::<Value>(yaml) {
        Ok(Value::Mapping(map)) => map,
        Ok(Value::Null) => Mapping::new(),
        _ => return None,
    };
    let tags_key = if map.contains_key("tags") { "tags" } else { "tag" };
    Some(
        map.into_iter()
            .filter_map(|(key, value)| match key {
                Value::String(key) if key != tags_key => Some((key, value)),
                _ => None,
            })
            .collect(),
    )
}

/// Rewrite a plain Markdown file so its frontmatter's `key` is `value`, or
/// with `None`, so it has no `key`.
///
/// Only that key's lines change: an existing key is rewritten in place, a new
/// one appended, and every other byte of the file kept. A file with no
/// frontmatter gets one.
pub fn set_markdown_property(markdown: &str, key: &str, value: Option<&Value>) -> String {
    let rendered_key = scalar(key);
    let mut keys = vec![rendered_key.as_str()];
    if rendered_key != key {
        keys.push(key);
    }
    edit_frontmatter_key(markdown, &keys, |_, newline| {
        let Some(value) = value else { return String::new() };
        let mut entry = Mapping::new();
        entry.insert(Value::String(key.to_string()), value.clone());
        let yaml = serde_yaml::to_string(&entry).unwrap_or_default();
        if newline == "\n" { yaml } else { yaml.replace('\n', newline) }
    })
}

/// Where and how a frontmatter key was written, for re-rendering it in kind.
pub(crate) struct KeyStyle<'a> {
    /// The key as spelled in the file.
    pub key: &'a str,
    /// Whether its value was a `[...]` flow list.
    pub flow: bool,
    /// The indent of its first continuation line, if any.
    pub indent: Option<&'a str>,
}

/// Replace the lines of the first of `keys` found at the top level of
/// `markdown`'s frontmatter with what `render` returns (given that key's
/// style, or `None` if no key is there, and the file's newline). An empty
/// rendering removes the key; a new key is appended to the frontmatter, and
/// a file without frontmatter gets one if there's anything to write.
pub(crate) fn edit_frontmatter_key(
    markdown: &str,
    keys: &[&str],
    render: impl FnOnce(Option<KeyStyle>, &str) -> String,
) -> String {
    let newline = if markdown.contains("\r\n") { "\r\n" } else { "\n" };
    let (frontmatter, body) = crate::split_markdown_frontmatter(markdown);

    if frontmatter.is_empty() {
        let block = render(None, newline);
        if block.is_empty() {
            return markdown.to_string();
        }
        return format!("---{newline}{block}---{newline}{body}");
    }

    // `split_markdown_frontmatter` only returns a prefix that opens and closes
    // with a `---` line, so there are always at least those two lines.
    let lines: Vec<&str> = frontmatter.split_inclusive('\n').collect();
    let (open, rest) = lines.split_first().expect("frontmatter has an opening line");
    let (close, inner) = rest.split_last().expect("frontmatter has a closing line");

    let key_line = keys.iter().find_map(|key| {
        inner
            .iter()
            .position(|line| line.strip_prefix(key).is_some_and(|after| after.starts_with(':')))
            .map(|i| (i, *key))
    });

    let mut out = String::with_capacity(markdown.len() + 64);
    out.push_str(open);

    match key_line {
        Some((start, key)) => {
            let end = start + 1 + continuation_len(&inner[start + 1..]);
            let style = KeyStyle {
                key,
                flow: inner[start][key.len() + 1..].trim().starts_with('['),
                indent: inner[start + 1..end]
                    .iter()
                    .find(|line| !line.trim().is_empty())
                    .map(|line| &line[..line.len() - line.trim_start().len()]),
            };
            inner[..start].iter().for_each(|line| out.push_str(line));
            out.push_str(&render(Some(style), newline));
            inner[end..].iter().for_each(|line| out.push_str(line));
        }
        None => {
            inner.iter().for_each(|line| out.push_str(line));
            out.push_str(&render(None, newline));
        }
    }

    out.push_str(close);
    out.push_str(body);
    out
}

/// How many of `lines` continue a top-level key's value: indented lines, and
/// `- item` lines, which YAML allows at column 0 in a block list. Blank lines
/// count only when more of the value follows them.
fn continuation_len(lines: &[&str]) -> usize {
    let mut len = 0;
    for (i, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with([' ', '\t', '-']) {
            len = i + 1;
        } else {
            break;
        }
    }
    len
}

/// `text` as a YAML scalar, quoted only if it would otherwise read back as
/// something other than this string (`true`, `12`, `#x`, ...).
pub(crate) fn scalar(text: &str) -> String {
    match serde_yaml::to_string(text) {
        Ok(yaml) => yaml.trim_end_matches('\n').to_string(),
        Err(_) => serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\"")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(props: &[(String, Value)]) -> Vec<&str> {
        props.iter().map(|(key, _)| key.as_str()).collect()
    }

    #[test]
    fn markdown_properties_lists_keys_in_file_order_without_tags() {
        let file = "---\nzeta: 1\ntags: [a]\ntag: kept\nalpha: [x, y]\n---\nBody";
        let props = markdown_properties(file).unwrap();
        assert_eq!(keys(&props), vec!["zeta", "tag", "alpha"]);
        assert_eq!(props[0].1, Value::from(1));
    }

    #[test]
    fn markdown_properties_skips_the_singular_tag_key_when_it_holds_the_tags() {
        let props = markdown_properties("---\ntag: a\ndue: 2026-10-17\n---\n").unwrap();
        assert_eq!(keys(&props), vec!["due"]);
        assert_eq!(props[0].1, Value::from("2026-10-17"));
    }

    #[test]
    fn markdown_properties_is_none_for_frontmatter_it_cannot_read() {
        assert_eq!(markdown_properties("---\n: not [valid\n---\n"), None);
        assert_eq!(markdown_properties("---\n- a list\n---\n"), None);
        assert_eq!(markdown_properties("# no frontmatter"), Some(vec![]));
        assert_eq!(markdown_properties("---\n---\n"), Some(vec![]));
    }

    #[test]
    fn set_markdown_property_rewrites_only_its_own_key() {
        let file = "---\ntitle: Plan\nstatus:   draft # comment\naliases:\n  - p\n---\nBody\n";
        let updated = set_markdown_property(file, "status", Some(&Value::from("done")));
        assert_eq!(updated, "---\ntitle: Plan\nstatus: done\naliases:\n  - p\n---\nBody\n");
    }

    #[test]
    fn set_markdown_property_replaces_a_multi_line_value() {
        let file = "---\nlist:\n  - a\n  - b\nnext: x\n---\n";
        assert_eq!(
            set_markdown_property(file, "list", Some(&Value::from(true))),
            "---\nlist: true\nnext: x\n---\n"
        );
    }

    #[test]
    fn set_markdown_property_appends_removes_and_adds_frontmatter() {
        let file = "---\ntitle: x\n---\nBody";
        let added = set_markdown_property(file, "count", Some(&Value::from(3)));
        assert_eq!(added, "---\ntitle: x\ncount: 3\n---\nBody");
        assert_eq!(set_markdown_property(&added, "count", None), file);
        assert_eq!(
            set_markdown_property("Body", "done", Some(&Value::from(false))),
            "---\ndone: false\n---\nBody"
        );
        assert_eq!(set_markdown_property("Body", "done", None), "Body");
    }

    #[test]
    fn set_markdown_property_writes_lists_and_odd_values_that_read_back() {
        let list = Value::Sequence(vec![Value::from("a"), Value::from("12"), Value::from("x: y")]);
        let updated = set_markdown_property("---\n---\n", "items", Some(&list));
        assert_eq!(markdown_properties(&updated).unwrap(), vec![("items".to_string(), list)]);
        let quoted = set_markdown_property("---\n---\n", "true", Some(&Value::from("yes")));
        assert_eq!(markdown_properties(&quoted).unwrap(), vec![("true".to_string(), Value::from("yes"))]);
        // The quoted key is found again rather than appended twice.
        let again = set_markdown_property(&quoted, "true", Some(&Value::from("no")));
        assert_eq!(markdown_properties(&again).unwrap(), vec![("true".to_string(), Value::from("no"))]);
    }

    #[test]
    fn set_markdown_property_keeps_crlf_line_endings() {
        let list = Value::Sequence(vec![Value::from("a")]);
        assert_eq!(
            set_markdown_property("---\r\ntitle: x\r\n---\r\nBody", "l", Some(&list)),
            "---\r\ntitle: x\r\nl:\r\n- a\r\n---\r\nBody"
        );
    }
}
