//! The open vault and the recent ones, owned by the backend.
//!
//! Commands read the vault root from [`ActiveVault`] instead of taking it from
//! the webview, and every path that can name a new root or destination (open,
//! create, move, import, export, save a copy) comes from a dialog the backend
//! runs itself. Android has no native dialog: its in-app picker browses with
//! [`browse_folders`] and hands its choice to [`android_approve`], which the
//! next command consumes.

use crate::logging::logged;
use crate::vault::{write_atomic, FolderEntry};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const MAX_RECENT_VAULTS: usize = 8;
const NO_VAULT: &str = "No vault is open";

/// What persists between launches, and what the frontend is told.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct VaultSession {
    pub active: Option<String>,
    /// Newest first.
    pub recents: Vec<String>,
}

/// What a dialog is for. The native dialog's kind follows from it, and on
/// Android it keys the approved choice.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Ask {
    Vault,
    NewVault,
    ObsidianSource,
    ObsidianDest,
    MoveTo,
    ExportTo,
    CopyTo,
    Attachment,
}

impl Ask {
    fn is_folder(self) -> bool {
        matches!(self, Ask::Vault | Ask::ObsidianSource | Ask::ExportTo)
    }

    /// A path that doesn't exist yet, in a folder that does.
    fn is_new(self) -> bool {
        matches!(self, Ask::NewVault | Ask::ObsidianDest | Ask::MoveTo | Ask::CopyTo)
    }
}

pub struct ActiveVault {
    file: PathBuf,
    session: Mutex<VaultSession>,
    approved: Mutex<HashMap<Ask, PathBuf>>,
}

impl ActiveVault {
    pub fn load(file: PathBuf) -> Self {
        let session = fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        ActiveVault { file, session: Mutex::new(session), approved: Mutex::default() }
    }

    /// The open vault's root.
    pub fn root(&self) -> Result<String, String> {
        self.session.lock().unwrap().active.clone().ok_or_else(|| NO_VAULT.to_string())
    }

    /// The session, its open vault dropped if the folder is gone.
    fn snapshot(&self) -> VaultSession {
        let mut session = self.session.lock().unwrap();
        if session.active.as_deref().is_some_and(|path| !Path::new(path).is_dir()) {
            session.active = None;
        }
        session.clone()
    }

    fn update(&self, change: impl FnOnce(&mut VaultSession)) -> Result<VaultSession, String> {
        let mut session = self.session.lock().unwrap();
        change(&mut session);
        let json = serde_json::to_vec(&*session).map_err(|e| e.to_string())?;
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("Failed to save the vault list: {e}"))?;
        }
        write_atomic(&self.file, &json)?;
        Ok(session.clone())
    }

    /// Opens the vault folder `path` and puts it first in the recents.
    fn activate(&self, path: &str) -> Result<VaultSession, String> {
        if !Path::new(path).is_dir() {
            return Err("The vault folder no longer exists".to_string());
        }
        self.update(|s| {
            s.recents.retain(|p| p != path);
            s.recents.insert(0, path.to_string());
            s.recents.truncate(MAX_RECENT_VAULTS);
            s.active = Some(path.to_string());
        })
    }

    /// Only a vault the backend has opened before can be named by the webview.
    fn require_known(&self, path: &str) -> Result<(), String> {
        let session = self.session.lock().unwrap();
        if session.recents.iter().chain(&session.active).any(|p| p == path) {
            Ok(())
        } else {
            Err("That vault isn't one you've opened".to_string())
        }
    }

    fn approve(&self, kind: Ask, path: PathBuf) {
        self.approved.lock().unwrap().insert(kind, path);
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    fn take_approved(&self, kind: Ask) -> Result<PathBuf, String> {
        self.approved.lock().unwrap().remove(&kind).ok_or_else(|| "Choose a location first".to_string())
    }
}

/// The shared storage root the Android folder browser starts from.
fn android_storage() -> PathBuf {
    PathBuf::from(std::env::var("EXTERNAL_STORAGE").unwrap_or_else(|_| "/storage/emulated/0".to_string()))
}

/// `path` (or, for a path that doesn't exist yet, its parent) resolved and
/// inside `root`.
fn inside(root: &Path, path: &Path, must_exist: bool) -> Result<PathBuf, String> {
    let resolved = if must_exist || path.exists() {
        path.canonicalize()
    } else {
        let name = path.file_name().ok_or("Invalid path")?;
        path.parent().ok_or("Invalid path")?.canonicalize().map(|parent| parent.join(name))
    }
    .map_err(|e| format!("Can't use that location: {e}"))?;
    let root = root.canonicalize().map_err(|e| format!("Can't use that location: {e}"))?;
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err("That location isn't available".to_string())
    }
}

/// Where the Android folder browser may go: shared storage, or the open vault.
fn browsable(vault: &ActiveVault, path: &Path, must_exist: bool) -> Result<PathBuf, String> {
    inside(&android_storage(), path, must_exist).or_else(|e| match vault.root() {
        Ok(root) => inside(Path::new(&root), path, must_exist),
        Err(_) => Err(e),
    })
}

/// Asks for a path of the kind `kind`: a native dialog, or on Android the
/// choice [`android_approve`] recorded. `None` if the dialog was cancelled.
#[cfg(not(target_os = "android"))]
pub fn ask_path(
    app: &AppHandle,
    _vault: &ActiveVault,
    kind: Ask,
    title: &str,
    default: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title(title);
    if kind.is_new() {
        if let Some(default) = default {
            if let Some(dir) = default.parent().filter(|dir| dir.is_dir()) {
                dialog = dialog.set_directory(dir);
            }
            if let Some(name) = default.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy());
            }
        }
    }
    let picked = if kind.is_folder() {
        dialog.blocking_pick_folder()
    } else if kind.is_new() {
        dialog.blocking_save_file()
    } else {
        dialog
            .add_filter("Images, Videos and PDFs", &crate::attachments::picker_extensions())
            .blocking_pick_file()
    };
    picked.map(|path| path.into_path().map_err(|e| e.to_string())).transpose()
}

#[cfg(target_os = "android")]
pub fn ask_path(
    _app: &AppHandle,
    vault: &ActiveVault,
    kind: Ask,
    _title: &str,
    _default: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    vault.take_approved(kind).map(Some)
}

/// The vault state at launch: the open vault and the recents.
#[tauri::command]
pub fn vault_session(vault: State<ActiveVault>) -> VaultSession {
    vault.snapshot()
}

#[tauri::command(async)]
pub fn pick_vault(app: AppHandle, vault: State<ActiveVault>) -> Result<Option<String>, String> {
    logged("pick_vault", || {
        let Some(path) = ask_path(&app, &vault, Ask::Vault, "Open a Vault", None)? else { return Ok(None) };
        let path = path.to_string_lossy().into_owned();
        vault.activate(&path)?;
        Ok(Some(path))
    })
}

#[tauri::command(async)]
pub fn create_vault(app: AppHandle, vault: State<ActiveVault>) -> Result<Option<String>, String> {
    logged("create_vault", || {
        let default = PathBuf::from("New Vault");
        let Some(path) = ask_path(&app, &vault, Ask::NewVault, "Create New Vault", Some(&default))? else {
            return Ok(None);
        };
        let path = path.to_string_lossy().into_owned();
        crate::vault::create_vault_at(&path)?;
        vault.activate(&path)?;
        Ok(Some(path))
    })
}

#[tauri::command]
pub fn switch_vault(path: String, vault: State<ActiveVault>) -> Result<String, String> {
    logged("switch_vault", || {
        vault.require_known(&path)?;
        vault.activate(&path)?;
        Ok(path)
    })
}

#[tauri::command]
pub fn close_vault(vault: State<ActiveVault>) -> Result<(), String> {
    logged("close_vault", || vault.update(|s| s.active = None).map(|_| ()))
}

#[tauri::command]
pub fn remove_recent_vault(path: String, vault: State<ActiveVault>) -> Result<Vec<String>, String> {
    logged("remove_recent_vault", || vault.update(|s| s.recents.retain(|p| *p != path)).map(|s| s.recents))
}

#[tauri::command]
pub fn clear_recent_vaults(vault: State<ActiveVault>) -> Result<Vec<String>, String> {
    logged("clear_recent_vaults", || vault.update(|s| s.recents.clear()).map(|s| s.recents))
}

/// Moves the vault folder `from` to a place the user picks, or, given
/// `new_name`, renames it where it is. Returns the new path; `None` if the
/// user cancelled.
#[tauri::command(async)]
pub fn move_vault(
    from: String,
    new_name: Option<String>,
    app: AppHandle,
    vault: State<ActiveVault>,
) -> Result<Option<String>, String> {
    logged("move_vault", || {
        vault.require_known(&from)?;
        let to = match new_name {
            Some(name) if name.contains(['/', '\\']) => return Err("Invalid vault name".to_string()),
            Some(name) => Path::new(&from).with_file_name(name),
            None => match ask_path(&app, &vault, Ask::MoveTo, "Move Vault", Some(Path::new(&from)))? {
                Some(to) => to,
                None => return Ok(None),
            },
        };
        let to = to.to_string_lossy().into_owned();
        crate::vault::move_vault_dir(&from, &to)?;
        vault.update(|s| {
            for path in s.recents.iter_mut().chain(&mut s.active) {
                if *path == from {
                    *path = to.clone();
                }
            }
        })?;
        Ok(Some(to))
    })
}

/// Copies an Obsidian vault the user picks into a new Mantle vault, which
/// becomes the open one.
#[tauri::command(async)]
pub fn import_obsidian_vault(
    app: AppHandle,
    vault: State<ActiveVault>,
    keys: State<crate::credentials::SessionKeys>,
) -> Result<Option<crate::migrate::ImportOutcome>, String> {
    logged("import_obsidian_vault", || {
        let Some(source) = ask_path(&app, &vault, Ask::ObsidianSource, "Choose an Obsidian Vault", None)? else {
            return Ok(None);
        };
        let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let default = PathBuf::from(format!("{name} (Mantle)"));
        let Some(dest) =
            ask_path(&app, &vault, Ask::ObsidianDest, "Create the New Mantle Vault", Some(&default))?
        else {
            return Ok(None);
        };
        let report = crate::migrate::import_obsidian_inner(&source, &dest, &keys)?;
        let path = dest.to_string_lossy().into_owned();
        vault.activate(&path)?;
        Ok(Some(crate::migrate::ImportOutcome { path, report }))
    })
}

/// Subfolders of `path`, for the in-app folder browser on Android. Limited to
/// shared storage and the open vault.
#[tauri::command]
pub fn browse_folders(path: String, vault: State<ActiveVault>) -> Result<Vec<FolderEntry>, String> {
    logged("browse_folders", || {
        browsable(&vault, Path::new(&path), true)?;
        crate::vault::list_folders_at(&path)
    })
}

/// Records what the Android picker chose for `kind`, for the command that
/// asks for it next. Choices are limited to what [`browse_folders`] can reach.
#[tauri::command]
pub fn android_approve(kind: Ask, path: String, vault: State<ActiveVault>) -> Result<(), String> {
    logged("android_approve", || {
        let path = browsable(&vault, Path::new(&path), !kind.is_new())?;
        vault.approve(kind, path);
        Ok(())
    })
}

/// Where the vault list is kept.
pub fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("vaults.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-session-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_session_persists_and_orders_recents_newest_first() {
        let dir = temp_dir("persist");
        let file = dir.join("config").join("vaults.json");
        let (a, b) = (dir.join("a"), dir.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let (a, b) = (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned());

        let vault = ActiveVault::load(file.clone());
        assert!(vault.root().is_err());
        vault.activate(&a).unwrap();
        vault.activate(&b).unwrap();
        vault.activate(&a).unwrap();

        let reloaded = ActiveVault::load(file);
        assert_eq!(reloaded.root().unwrap(), a);
        assert_eq!(reloaded.snapshot().recents, [a.clone(), b.clone()]);

        fs::remove_dir_all(&a).unwrap();
        assert_eq!(reloaded.snapshot().active, None, "a vault whose folder is gone isn't reopened");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_vaults_the_backend_opened_can_be_named() {
        let dir = temp_dir("known");
        let vault = ActiveVault::load(dir.join("vaults.json"));
        let opened = dir.join("v");
        fs::create_dir_all(&opened).unwrap();
        let opened = opened.to_string_lossy().into_owned();
        vault.activate(&opened).unwrap();
        assert!(vault.require_known(&opened).is_ok());
        assert!(vault.require_known(&dir.to_string_lossy()).is_err());
        assert!(vault.activate(&dir.join("missing").to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recents_are_capped() {
        let dir = temp_dir("cap");
        let vault = ActiveVault::load(dir.join("vaults.json"));
        for n in 0..MAX_RECENT_VAULTS + 3 {
            let path = dir.join(format!("v{n}"));
            fs::create_dir_all(&path).unwrap();
            vault.activate(&path.to_string_lossy()).unwrap();
        }
        assert_eq!(vault.snapshot().recents.len(), MAX_RECENT_VAULTS);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn choices_stay_inside_the_allowed_root_and_are_used_once() {
        let dir = temp_dir("inside");
        let root = dir.join("storage");
        fs::create_dir_all(root.join("notes")).unwrap();
        assert!(inside(&root, &root.join("notes"), true).is_ok());
        assert!(inside(&root, &root.join("new"), false).is_ok(), "a new path is judged by its folder");
        assert!(inside(&root, &root.join("..").join("storage").join("notes"), true).is_ok());
        assert!(inside(&root, &dir, true).is_err());
        assert!(inside(&root, &root.join("..").join("new"), false).is_err());

        let vault = ActiveVault::load(dir.join("vaults.json"));
        vault.approve(Ask::ExportTo, root.clone());
        assert_eq!(vault.take_approved(Ask::ExportTo).unwrap(), root);
        assert!(vault.take_approved(Ask::ExportTo).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
