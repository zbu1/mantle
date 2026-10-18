//! Tauri commands for loading/saving a vault's own persisted UI metadata —
//! favorites, manual sort order, and collapsed folders — stored inside the
//! vault itself at `.mantle/state.json`, so it travels with the vault across
//! machines and sync (Dropbox/git/etc.), the same way `.obsidian/` does for
//! Obsidian. `.mantle` is a dotfile-prefixed directory, so `vault::scan_dir`
//! already skips it when building the note tree, and `watcher::is_hidden`
//! already ignores writes under it when deciding whether to emit
//! `vault-changed`.
//!
//! This file only ever references `rel_path`s that are already visible as
//! plaintext filenames on disk — even a `.mntl.enc` note's *content* is
//! encrypted, but its filename is not — so it stays plaintext unconditionally
//! rather than needing its own encryption story for encrypted vaults.

use crate::logging::logged;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;

/// The vault-local metadata directory. Dotfile-prefixed, so `vault::scan_dir`
/// and `watcher::is_hidden` both skip it for free.
pub(crate) const STATE_DIR: &str = ".mantle";
const STATE_FILE: &str = "state.json";
const CURRENT_VERSION: u32 = 1;

/// Persisted vault-scoped UI metadata. Every field is additive and
/// `#[serde(default)]`, so older state files missing a newer field parse
/// cleanly instead of erroring.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultMeta {
    /// Schema version, bumped on breaking changes so a future release can
    /// migrate old files instead of silently misreading them.
    #[serde(default = "current_version")]
    pub version: u32,
    /// Favorited note `rel_path`s. Array order is display order, so
    /// favorites don't need a separate entry in `order`.
    #[serde(default)]
    pub favorites: Vec<String>,
    /// Manual child order per folder, keyed by the folder's `rel_path`
    /// (`""` for the vault root), listing its children's file names. Used
    /// when `sort_mode` is `manual`; a folder with no entry here, and any
    /// child it doesn't list, sorts alphabetically. Once a
    /// folder gains an entry it should list all of its current children;
    /// the frontend is responsible for appending newly-discovered children
    /// and dropping ones that no longer exist when it reconciles against a
    /// fresh `scan_vault` result.
    #[serde(default)]
    pub order: HashMap<String, Vec<String>>,
    /// `rel_path`s of folders the user has collapsed. Absent = expanded,
    /// matching the current default in `VaultTreeNode`.
    #[serde(default)]
    pub collapsed_folders: Vec<String>,
    /// How the sidebar tree sorts: `name-asc`, `name-desc`, `modified`,
    /// `created` or `manual`. A string, so a mode added later doesn't make
    /// an older build fail to read the whole file; the frontend falls back
    /// to `name-asc` for one it doesn't know.
    #[serde(default = "default_sort_mode")]
    pub sort_mode: String,
    /// Recently opened notes, most recent first. The frontend owns dedupe
    /// and the size cap; this is stored as-is.
    #[serde(default)]
    pub recent_notes: Vec<RecentNote>,
    /// Each property's type (`text`, `list`, `number`, `checkbox`, `date`,
    /// `datetime`), by lowercased property name: a type is vault-wide, so
    /// `due` is a date in every note. A name with no entry has its type
    /// inferred from its value. Strings for the same reason as `sort_mode`.
    /// Note that this names properties used only in encrypted notes.
    #[serde(default)]
    pub property_types: BTreeMap<String, String>,
}

/// One entry in the recently-opened list.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentNote {
    pub rel_path: String,
    /// When the note was opened, in milliseconds since the Unix epoch.
    pub opened_at: u64,
}

fn current_version() -> u32 {
    CURRENT_VERSION
}

fn default_sort_mode() -> String {
    "name-asc".to_string()
}

impl Default for VaultMeta {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            favorites: Vec::new(),
            order: HashMap::new(),
            collapsed_folders: Vec::new(),
            sort_mode: default_sort_mode(),
            recent_notes: Vec::new(),
            property_types: BTreeMap::new(),
        }
    }
}

fn state_path(vault_root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(vault_root)
        .canonicalize()
        .map_err(|e| format!("Invalid vault root: {e}"))?;
    Ok(root.join(STATE_DIR).join(STATE_FILE))
}

/// Loads `.mantle/state.json` from `vault_root`. A vault that doesn't have
/// one yet (new vault, or one never opened by a version of the app with
/// this feature) is not an error — it just means every field is at its
/// default.
#[tauri::command]
pub fn load_vault_meta(vault_root: String) -> Result<VaultMeta, String> {
    logged("load_vault_meta", || {
        let path = state_path(&vault_root)?;
        if !path.exists() {
            return Ok(VaultMeta::default());
        }
        let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read vault state: {e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse vault state: {e}"))
    })
}

/// Saves `.mantle/state.json`, creating the `.mantle` directory if this is
/// the first write for this vault. Writes to a sibling temp file and renames
/// it over the target so a crash or power loss mid-write can't leave
/// `state.json` truncated or corrupt.
#[tauri::command]
pub fn save_vault_meta(vault_root: String, state: VaultMeta) -> Result<(), String> {
    logged("save_vault_meta", || write_vault_meta(&vault_root, &state))
}

pub(crate) fn write_vault_meta(vault_root: &str, state: &VaultMeta) -> Result<(), String> {
    let path = state_path(vault_root)?;
    let dir = path.parent().ok_or("Invalid vault state path")?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create {STATE_DIR}: {e}"))?;

    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let tmp_path = dir.join(format!("{STATE_FILE}.tmp"));
    fs::write(&tmp_path, json).map_err(|e| format!("Failed to write vault state: {e}"))?;
    fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to save vault state: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-vault-meta-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_returns_default_when_missing() {
        let root = temp_dir("missing");
        let root_str = root.to_string_lossy().into_owned();

        assert_eq!(load_vault_meta(root_str).unwrap(), VaultMeta::default());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_then_load_round_trips() {
        let root = temp_dir("roundtrip");
        let root_str = root.to_string_lossy().into_owned();

        let state = VaultMeta {
            version: 1,
            favorites: vec!["Work/todo.mntl".to_string()],
            order: HashMap::from([("Work".to_string(), vec!["todo.mntl".to_string(), "notes.mntl".to_string()])]),
            collapsed_folders: vec!["Archive".to_string()],
            sort_mode: "modified".to_string(),
            recent_notes: vec![
                RecentNote { rel_path: "Work/todo.mntl".to_string(), opened_at: 1_758_000_000_000 },
                RecentNote { rel_path: "notes.mntl.enc".to_string(), opened_at: 1_757_900_000_000 },
            ],
            property_types: BTreeMap::from([("due".to_string(), "date".to_string())]),
        };
        save_vault_meta(root_str.clone(), state.clone()).unwrap();

        assert!(root.join(".mantle").join("state.json").is_file());
        assert_eq!(load_vault_meta(root_str).unwrap(), state);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_fields_default_instead_of_failing_to_parse() {
        let root = temp_dir("partial");
        fs::create_dir_all(root.join(".mantle")).unwrap();
        fs::write(root.join(".mantle").join("state.json"), r#"{"version":1}"#).unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let loaded = load_vault_meta(root_str).unwrap();
        assert_eq!(loaded, VaultMeta::default());
        assert!(loaded.recent_notes.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recent_notes_use_camel_case_keys_on_disk() {
        let root = temp_dir("recent-keys");
        let root_str = root.to_string_lossy().into_owned();

        let state = VaultMeta {
            recent_notes: vec![RecentNote { rel_path: "a.mntl".to_string(), opened_at: 42 }],
            ..VaultMeta::default()
        };
        save_vault_meta(root_str, state).unwrap();

        let raw = fs::read_to_string(root.join(".mantle").join("state.json")).unwrap();
        assert!(raw.contains("\"recentNotes\""));
        assert!(raw.contains("\"relPath\""));
        assert!(raw.contains("\"openedAt\""));

        let _ = fs::remove_dir_all(&root);
    }
}
