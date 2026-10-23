//! Watches a vault directory for external filesystem changes (edits made
//! outside the app, e.g. via the OS file explorer) and notifies the
//! frontend so it can re-scan and reconcile open tabs, and reload open notes
//! whose content changed.

use crate::logging::logged;
use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatcherState(Mutex<Option<RecommendedWatcher>>);

const DEBOUNCE: Duration = Duration::from_millis(200);

/// How long a self-written path stays suppressed. Long enough to cover the
/// filesystem notification arriving after the write, short enough that a real
/// external edit to the same file moments later is not swallowed.
const SUPPRESS_TTL: Duration = Duration::from_secs(2);

/// Paths this app has just written, which should not be reported as external
/// changes.
///
/// A process-global rather than a field on [`WatcherState`] so that the write
/// helpers in `vault`/`notes_crypto` can register a path without every command
/// in the call chain having to thread `State<WatcherState>` through. There is
/// only ever one watcher per process, so a global is accurate here.
static SUPPRESSED: OnceLock<Mutex<Vec<(String, Instant)>>> = OnceLock::new();

fn suppressed() -> &'static Mutex<Vec<(String, Instant)>> {
    SUPPRESSED.get_or_init(|| Mutex::new(Vec::new()))
}

/// A comparable form of `path`.
///
/// Event paths come from `notify` as the watcher saw them, while our own
/// writes go through `fs::canonicalize`, which on Windows produces the
/// `\\?\C:\…` verbatim form. Comparing the raw paths would therefore never
/// match. Windows filesystems are also case-insensitive, hence the lowercase.
fn normalize(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    if cfg!(windows) {
        text.to_lowercase().replace('/', "\\")
    } else {
        text.to_string()
    }
}

/// Mark `path` as written by this app, so the change it causes does not come
/// back as a `vault-changed` event.
///
/// Encrypted notes are saved with a temp file and a rename, which emits
/// `Create` + `Modify(Name)` + `Remove` — all structural, unlike the in-place
/// `Modify(Data)` a plaintext save produces and [`is_structural`] ignores.
/// Without this, every autosave of an encrypted note would trigger a full
/// vault rescan.
pub(crate) fn suppress(path: &Path) {
    let Ok(mut entries) = suppressed().lock() else {
        return;
    };
    let now = Instant::now();
    entries.retain(|(_, at)| now.duration_since(*at) < SUPPRESS_TTL);
    entries.push((normalize(path), now));
}

fn is_suppressed(path: &Path) -> bool {
    let Ok(entries) = suppressed().lock() else {
        return false;
    };
    let now = Instant::now();
    let key = normalize(path);
    entries
        .iter()
        .any(|(p, at)| *p == key && now.duration_since(*at) < SUPPRESS_TTL)
}

/// True if any path component is hidden (starts with `.`), mirroring the
/// dotfile skip in `vault::scan_dir` (e.g. so a `.git` folder inside the
/// vault doesn't cause a refresh storm).
fn is_hidden(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// Only tree-structural changes need a rescan; a plain content write
/// (`Modify(Data)`, or `Modify(Any)` on Windows) only reloads that note.
fn is_structural(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    )
}

#[tauri::command]
pub fn start_vault_watch(app: AppHandle, state: State<WatcherState>, vault_root: String) -> Result<(), String> {
    logged("start_vault_watch", || {
        let root = PathBuf::from(&vault_root);
        if !root.is_dir() {
            return Err(format!(
                "Vault root does not exist or is not a directory: {vault_root}"
            ));
        }

        // Whether the event was structural, and the paths it names.
        let (tx, rx) = mpsc::channel::<(bool, Vec<PathBuf>)>();

        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                // Reads (and the atime updates they cause) aren't changes;
                // reporting them would make every `read_note` trigger another.
                if matches!(event.kind, EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))) {
                    return;
                }
                if !event.paths.is_empty() && event.paths.iter().all(|p| is_hidden(p)) {
                    return;
                }
                // A rename event carries both the temp file and its
                // destination, so `all` only holds once both were registered
                // by `write_atomic`.
                if !event.paths.is_empty() && event.paths.iter().all(|p| is_suppressed(p)) {
                    return;
                }
                let _ = tx.send((is_structural(&event.kind), event.paths));
            })
            .map_err(|e| format!("Failed to start watcher: {e}"))?;

        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch vault: {e}"))?;

        // Storing the new watcher drops (and thereby stops) any previous one,
        // which also drops its `tx`, ending that watcher's debounce thread below.
        *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);

        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                // Coalesce a burst of events (e.g. a move touching many files)
                // into a single refresh.
                let mut structural = false;
                let mut changed = BTreeSet::new();
                let mut next = Some(first);
                while let Some((is_structural, paths)) = next {
                    structural |= is_structural;
                    changed.extend(paths.iter().filter_map(|p| rel_path(&root, p)));
                    next = rx.recv_timeout(DEBOUNCE).ok();
                }
                if structural {
                    let _ = app.emit("vault-changed", ());
                }
                if !changed.is_empty() {
                    let _ = app.emit("notes-changed", changed);
                }
            }
        });

        Ok(())
    })
}

/// `path` relative to `root` with `/` separators, the way the frontend names notes.
fn rel_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    Some(parts.join("/"))
}

#[tauri::command]
pub fn stop_vault_watch(state: State<WatcherState>) -> Result<(), String> {
    logged("stop_vault_watch", || {
        *state.0.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppresses_a_path_we_just_wrote() {
        let path = std::env::temp_dir().join("mntl-watcher-test-a.mntl.enc");
        let other = std::env::temp_dir().join("mntl-watcher-test-b.mntl.enc");

        assert!(!is_suppressed(&path));
        suppress(&path);
        assert!(is_suppressed(&path));
        assert!(!is_suppressed(&other), "suppression must not be global");
    }

    #[test]
    fn normalize_makes_canonical_and_plain_paths_comparable() {
        // The mismatch this exists to fix: our writes go through
        // `fs::canonicalize` (verbatim `\\?\` form on Windows) while notify
        // reports the path as the watcher saw it.
        if cfg!(windows) {
            assert_eq!(
                normalize(Path::new(r"\\?\C:\Vault\Note.mntl.enc")),
                normalize(Path::new(r"C:\vault\note.mntl.enc"))
            );
        } else {
            assert_eq!(
                normalize(Path::new("/vault/note.mntl.enc")),
                normalize(Path::new("/vault/note.mntl.enc"))
            );
        }
    }

    #[test]
    fn rel_path_uses_forward_slashes() {
        let root = Path::new("vault");
        assert_eq!(rel_path(root, &root.join("Work").join("todo.md")).as_deref(), Some("Work/todo.md"));
        assert_eq!(rel_path(root, Path::new("elsewhere/todo.md")), None);
    }

    #[test]
    fn is_hidden_skips_dotfile_directories() {
        assert!(is_hidden(Path::new("/vault/.mantle/state.json")));
        assert!(!is_hidden(Path::new("/vault/Work/todo.mntl")));
    }
}
