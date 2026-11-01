//! Compiles a note's ```` ```typst ```` blocks to SVG for the editor.
//!
//! A snippet sees only itself and the bundled fonts: no files, no packages, no
//! clock, so a note can't make Mantle read anything. Results are cached in
//! memory by the snippet's hash, never on disk (the snippet may come from an
//! encrypted note).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sha2::{Digest, Sha256};
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::layout::Abs;
use typst_layout::PagedDocument;
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};

/// Shrinks the page to the content, so a snippet renders like an image.
const PRELUDE: &str = "#set page(width: auto, height: auto, margin: 0.5em, fill: none)\n";
const CACHE_LIMIT: usize = 256;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TypstOutput {
    Svg { svg: String },
    /// One line per error, with its 1-based line in the snippet when known.
    Error { errors: Vec<String> },
}

struct Fonts {
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
}

fn fonts() -> &'static Fonts {
    static FONTS: OnceLock<Fonts> = OnceLock::new();
    FONTS.get_or_init(|| {
        let fonts: Vec<Font> = typst_assets::fonts().flat_map(|data| Font::iter(Bytes::new(data))).collect();
        Fonts { book: LazyHash::new(FontBook::from_fonts(&fonts)), fonts }
    })
}

fn library() -> &'static LazyHash<Library> {
    static LIBRARY: OnceLock<LazyHash<Library>> = OnceLock::new();
    LIBRARY.get_or_init(|| LazyHash::new(Library::builder().build()))
}

struct Snippet {
    source: Source,
}

impl World for Snippet {
    fn library(&self) -> &LazyHash<Library> {
        library()
    }
    fn book(&self) -> &LazyHash<FontBook> {
        &fonts().book
    }
    fn main(&self) -> FileId {
        self.source.id()
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.source.id() {
            Ok(self.source.clone())
        } else {
            Err(FileError::AccessDenied)
        }
    }
    fn file(&self, _id: FileId) -> FileResult<Bytes> {
        Err(FileError::AccessDenied)
    }
    fn font(&self, index: usize) -> Option<Font> {
        fonts().fonts.get(index).cloned()
    }
    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

/// Compiles one snippet, uncached.
pub fn compile(code: &str) -> TypstOutput {
    let world = Snippet { source: Source::detached(format!("{PRELUDE}{code}")) };
    let result = typst::compile::<PagedDocument>(&world).output;
    // ponytail: evicts typst's memo cache after every compile; tune if re-renders get slow.
    comemo::evict(10);
    match result {
        Ok(doc) => TypstOutput::Svg { svg: typst_svg::svg_merged(&doc, &Default::default(), Abs::zero()) },
        Err(diags) => TypstOutput::Error {
            errors: diags.iter().filter(|d| d.severity == Severity::Error).map(|d| describe(&world, d)).collect(),
        },
    }
}

fn describe(world: &Snippet, diag: &SourceDiagnostic) -> String {
    let line = world
        .range(diag.span)
        .and_then(|range| world.source.lines().byte_to_line(range.start))
        // The prelude is line 0.
        .filter(|&line| line > 0);
    let mut text = match line {
        Some(line) => format!("Line {line}: {}", diag.message),
        None => diag.message.to_string(),
    };
    for hint in &diag.hints {
        text.push_str(&format!("\nHint: {}", hint.v));
    }
    text
}

#[tauri::command]
pub async fn render_typst(code: String) -> Result<TypstOutput, String> {
    static CACHE: OnceLock<Mutex<HashMap<[u8; 32], TypstOutput>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key: [u8; 32] = Sha256::digest(code.as_bytes()).into();
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }
    let output = tauri::async_runtime::spawn_blocking(move || compile(&code)).await.map_err(|e| e.to_string())?;
    let mut cache = cache.lock().unwrap();
    // ponytail: drops the whole cache when full; LRU if notes with many snippets thrash it.
    if cache.len() >= CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(key, output.clone());
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_renders_math_to_svg() {
        let TypstOutput::Svg { svg } = compile("$ a^2 + b^2 = c^2 $") else { panic!("expected an SVG") };
        assert!(svg.starts_with("<svg"));
    }

    #[test]
    fn test_reports_errors_on_the_snippet_line() {
        let TypstOutput::Error { errors } = compile("ok\n#undefined_thing") else { panic!("expected an error") };
        assert!(errors[0].starts_with("Line 2:"), "{errors:?}");
    }

    #[test]
    fn test_cannot_read_files() {
        assert!(matches!(compile("#read(\"/etc/passwd\")"), TypstOutput::Error { .. }));
    }
}
