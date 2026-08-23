//! Watches a vault directory for external filesystem changes (edits made
//! outside the app, e.g. via the OS file explorer) and notifies the
//! frontend so it can re-scan and reconcile open tabs.

use crate::logging::logged;
use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatcherState(Mutex<Option<RecommendedWatcher>>);

const DEBOUNCE: Duration = Duration::from_millis(200);

/// True if any path component is hidden (starts with `.`), mirroring the
/// dotfile skip in `vault::scan_dir` (e.g. so a `.git` folder inside the
/// vault doesn't cause a refresh storm).
fn is_hidden(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// Only tree-structural changes matter here; plain content writes
/// (`Modify(Data)`) are ignored so the app's own autosave doesn't trigger a
/// refresh loop.
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

        let (tx, rx) = mpsc::channel::<()>();

        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                if !is_structural(&event.kind) {
                    return;
                }
                if !event.paths.is_empty() && event.paths.iter().all(|p| is_hidden(p)) {
                    return;
                }
                let _ = tx.send(());
            })
            .map_err(|e| format!("Failed to start watcher: {e}"))?;

        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch vault: {e}"))?;

        // Storing the new watcher drops (and thereby stops) any previous one,
        // which also drops its `tx`, ending that watcher's debounce thread below.
        *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);

        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                // Coalesce a burst of events (e.g. a move touching many files)
                // into a single refresh.
                while rx.recv_timeout(DEBOUNCE).is_ok() {}
                let _ = app.emit("vault-changed", ());
            }
        });

        Ok(())
    })
}

#[tauri::command]
pub fn stop_vault_watch(state: State<WatcherState>) -> Result<(), String> {
    logged("stop_vault_watch", || {
        *state.0.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    })
}
