//! Small helper shared by Tauri commands so a failing command always leaves
//! a trace in the log (stdout + the on-disk log file managed by
//! `tauri-plugin-log`), even when the frontend swallows the rejected
//! promise or the webview console is empty.

use log::error;

pub fn logged<T>(cmd: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let result = f();
    if let Err(err) = &result {
        error!("{cmd} failed: {err}");
    }
    result
}
