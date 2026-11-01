//! Compiles a note's ```` ```typst ```` blocks to SVG for the editor.
//!
//! A snippet sees only itself and the bundled fonts: no files, no packages, no
//! clock, so a note can't make Mantle read anything. Results are cached in
//! memory by the snippet's hash, never on disk (the snippet may come from an
//! encrypted note).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
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

#[derive(Clone, Serialize, Deserialize)]
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

/// Longest snippet rendered. Compiling can't be interrupted, so a note (which
/// may come from a synced vault) mustn't be able to hand it an enormous one.
const MAX_CODE_LEN: usize = 100_000;

const COMPILE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const TIMEOUT_MSG: &str = "This snippet took too long to render";
/// Argument that makes the app binary act as a compile worker (see [`worker_main`]).
pub const WORKER_ARG: &str = "--typst-worker";

/// Compile worker: reads the snippet from stdin, writes the JSON result to
/// stdout. Run in a child process so a runaway compile can be killed.
pub fn worker_main() -> ! {
    let mut code = String::new();
    let output = match std::io::Read::read_to_string(&mut std::io::stdin(), &mut code) {
        Ok(_) => compile(&code),
        Err(e) => TypstOutput::Error { errors: vec![e.to_string()] },
    };
    let _ = serde_json::to_writer(std::io::stdout(), &output);
    std::process::exit(0)
}

/// Compiles in a child process, killed (freeing its memory) after `timeout`.
/// One at a time, so renders can't pile up processes.
// ponytail: memory is bounded by the timeout only; add an OS memory limit (job object/rlimit) if that's too loose.
#[cfg(not(target_os = "android"))]
fn run_within(code: &str, timeout: std::time::Duration) -> Result<TypstOutput, String> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    static BUSY: Mutex<()> = Mutex::new(());
    let _guard = BUSY.lock().unwrap_or_else(|e| e.into_inner());
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command.arg(WORKER_ARG).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    // Dropping stdin closes it, which ends the worker's read.
    child.stdin.take().ok_or("no stdin")?.write_all(code.as_bytes()).map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let deadline = std::time::Instant::now() + timeout;
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(TypstOutput::Error { errors: vec![TIMEOUT_MSG.to_string()] });
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let bytes = reader.join().map_err(|_| "reader panicked".to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Android can't re-exec the app, so compile on a thread and give up on it
/// after `timeout`; a runaway snippet keeps its thread and memory until exit.
#[cfg(target_os = "android")]
fn run_within(code: &str, timeout: std::time::Duration) -> Result<TypstOutput, String> {
    static BUSY: Mutex<()> = Mutex::new(());
    let (tx, rx) = std::sync::mpsc::channel();
    let code = code.to_string();
    std::thread::spawn(move || {
        let _guard = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        let _ = tx.send(compile(&code));
    });
    Ok(rx.recv_timeout(timeout).unwrap_or_else(|_| TypstOutput::Error { errors: vec![TIMEOUT_MSG.to_string()] }))
}

#[tauri::command]
pub async fn render_typst(code: String) -> Result<TypstOutput, String> {
    if code.len() > MAX_CODE_LEN {
        return Ok(TypstOutput::Error { errors: vec!["This snippet is too long to render".to_string()] });
    }
    static CACHE: OnceLock<Mutex<HashMap<[u8; 32], TypstOutput>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key: [u8; 32] = Sha256::digest(code.as_bytes()).into();
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }
    let output = tauri::async_runtime::spawn_blocking(move || run_within(&code, COMPILE_TIMEOUT))
        .await
        .map_err(|e| e.to_string())??;
    if matches!(&output, TypstOutput::Error { errors } if errors[0] == TIMEOUT_MSG) {
        return Ok(output);
    }
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
    fn test_output_survives_the_worker_json_round_trip() {
        let json = serde_json::to_vec(&compile("$ x $")).unwrap();
        assert!(matches!(serde_json::from_slice(&json), Ok(TypstOutput::Svg { .. })));
    }

    #[test]
    fn test_cannot_read_files() {
        assert!(matches!(compile("#read(\"/etc/passwd\")"), TypstOutput::Error { .. }));
    }
}
