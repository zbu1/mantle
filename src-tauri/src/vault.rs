//! Tauri commands for browsing and persisting a vault: a directory tree of
//! `.mntl` (plaintext) and `.mntl.enc` (encrypted, currently read-only/listed
//! but not decryptable) note files.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Classify a filename as a note file this app understands, returning its
/// display title (filename stem) and whether it's the encrypted format.
///
/// `.mntl.enc` is a compound extension, so it must be checked before `.mntl`.
fn classify_note_file(filename: &str) -> Option<(String, bool)> {
    if let Some(stem) = filename.strip_suffix(".mntl.enc") {
        return Some((stem.to_string(), true));
    }
    if let Some(stem) = filename.strip_suffix(".mntl") {
        return Some((stem.to_string(), false));
    }
    None
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum VaultNode {
    #[serde(rename_all = "camelCase")]
    Folder {
        name: String,
        rel_path: String,
        children: Vec<VaultNode>,
    },
    #[serde(rename_all = "camelCase")]
    Note {
        name: String,
        rel_path: String,
        locked: bool,
    },
}

fn node_name(node: &VaultNode) -> &str {
    match node {
        VaultNode::Folder { name, .. } | VaultNode::Note { name, .. } => name,
    }
}

fn to_slash(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn scan_dir(abs_dir: &Path, rel_dir: &Path) -> std::io::Result<Vec<VaultNode>> {
    let mut folders = Vec::new();
    let mut notes = Vec::new();

    for entry in fs::read_dir(abs_dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let child_rel = rel_dir.join(&name);

        if file_type.is_dir() {
            let children = scan_dir(&entry.path(), &child_rel)?;
            folders.push(VaultNode::Folder {
                name,
                rel_path: to_slash(&child_rel),
                children,
            });
        } else if file_type.is_file() {
            if let Some((title, locked)) = classify_note_file(&name) {
                notes.push(VaultNode::Note {
                    name: title,
                    rel_path: to_slash(&child_rel),
                    locked,
                });
            }
        }
    }

    folders.sort_by(|a, b| node_name(a).cmp(node_name(b)));
    notes.sort_by(|a, b| node_name(a).cmp(node_name(b)));
    folders.extend(notes);
    Ok(folders)
}

/// Resolve a vault-relative path to an absolute path, guarding against path
/// traversal (`..`, absolute components, symlink escapes).
fn resolve_rel_path(vault_root: &str, rel_path: &str) -> Result<PathBuf, String> {
    if rel_path.is_empty() {
        return Err("rel_path must not be empty".to_string());
    }
    let normalized = rel_path.replace('\\', "/");
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." || component.contains(':') {
            return Err(format!("Invalid path component in rel_path: {rel_path}"));
        }
    }

    let canonical_root = PathBuf::from(vault_root)
        .canonicalize()
        .map_err(|e| format!("Invalid vault root: {e}"))?;

    let mut candidate = canonical_root.clone();
    for component in normalized.split('/') {
        candidate.push(component);
    }

    let check_target = if candidate.exists() {
        candidate.canonicalize().map_err(|e| e.to_string())?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| "Invalid rel_path".to_string())?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Parent directory does not exist: {e}"))?;
        let file_name = candidate
            .file_name()
            .ok_or_else(|| "Invalid rel_path".to_string())?;
        canonical_parent.join(file_name)
    };

    if !check_target.starts_with(&canonical_root) {
        return Err("Path escapes vault root".to_string());
    }
    Ok(candidate)
}

#[tauri::command]
pub fn scan_vault(vault_root: String) -> Result<VaultNode, String> {
    let root = PathBuf::from(&vault_root);
    if !root.is_dir() {
        return Err(format!(
            "Vault root does not exist or is not a directory: {vault_root}"
        ));
    }
    let children = scan_dir(&root, Path::new("")).map_err(|e| e.to_string())?;
    Ok(VaultNode::Folder {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        rel_path: String::new(),
        children,
    })
}

#[tauri::command]
pub fn read_note(vault_root: String, rel_path: String) -> Result<String, String> {
    if rel_path.ends_with(".mntl.enc") {
        return Err("Encrypted notes are not supported yet".to_string());
    }
    let path = resolve_rel_path(&vault_root, &rel_path)?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {e}"))?;
    mntl_core::decode_unencrypted_note(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_note(vault_root: String, rel_path: String, content: String) -> Result<(), String> {
    if rel_path.ends_with(".mntl.enc") {
        return Err("Encrypted notes are not supported yet".to_string());
    }
    let path = resolve_rel_path(&vault_root, &rel_path)?;
    let encoded = mntl_core::encode_unencrypted_note(&content).map_err(|e| e.to_string())?;
    fs::write(&path, encoded).map_err(|e| format!("Failed to write note: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedNote {
    pub name: String,
    pub rel_path: String,
}

#[tauri::command]
pub fn create_note(vault_root: String, rel_dir: String, name: String) -> Result<CreatedNote, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err("Invalid note name".to_string());
    }
    let rel_path = if rel_dir.is_empty() {
        format!("{name}.mntl")
    } else {
        format!("{rel_dir}/{name}.mntl")
    };
    let path = resolve_rel_path(&vault_root, &rel_path)?;
    if path.exists() {
        return Err(format!("A note named \"{name}\" already exists in this folder"));
    }
    let encoded = mntl_core::encode_unencrypted_note("").map_err(|e| e.to_string())?;
    fs::write(&path, encoded).map_err(|e| format!("Failed to create note: {e}"))?;
    Ok(CreatedNote {
        name,
        rel_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_note_file_distinguishes_encrypted_from_plaintext() {
        assert_eq!(
            classify_note_file("todo.mntl"),
            Some(("todo".to_string(), false))
        );
        assert_eq!(
            classify_note_file("secret.mntl.enc"),
            Some(("secret".to_string(), true))
        );
        assert_eq!(classify_note_file("readme.md"), None);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-vault-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_rel_path_rejects_traversal() {
        let root = temp_dir("traversal");
        let root_str = root.to_string_lossy().into_owned();

        assert!(resolve_rel_path(&root_str, "../escape.mntl").is_err());
        assert!(resolve_rel_path(&root_str, "sub/../../escape.mntl").is_err());
        assert!(resolve_rel_path(&root_str, "").is_err());
        assert!(resolve_rel_path(&root_str, "ok.mntl").is_ok());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_rel_path_allows_existing_nested_file() {
        let root = temp_dir("nested");
        fs::create_dir_all(root.join("Work")).unwrap();
        fs::write(root.join("Work").join("todo.mntl"), "---\nv: 2\n---\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let resolved = resolve_rel_path(&root_str, "Work/todo.mntl").unwrap();
        assert!(resolved.ends_with("Work/todo.mntl") || resolved.ends_with("Work\\todo.mntl"));

        let _ = fs::remove_dir_all(&root);
    }
}
