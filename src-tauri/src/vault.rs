//! Tauri commands for browsing and persisting a vault: a directory tree of
//! `.mntl` (plaintext) and `.mntl.enc` (encrypted, currently read-only/listed
//! but not decryptable) note files.

use crate::logging::logged;
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
    logged("scan_vault", || {
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
    })
}

#[tauri::command]
pub fn read_note(vault_root: String, rel_path: String) -> Result<String, String> {
    logged("read_note", || {
        if rel_path.ends_with(".mntl.enc") {
            return Err("Encrypted notes are not supported yet".to_string());
        }
        let path = resolve_rel_path(&vault_root, &rel_path)?;
        let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {e}"))?;
        mntl_core::decode_unencrypted_note(&raw).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn write_note(vault_root: String, rel_path: String, content: String) -> Result<(), String> {
    logged("write_note", || {
        if rel_path.ends_with(".mntl.enc") {
            return Err("Encrypted notes are not supported yet".to_string());
        }
        let path = resolve_rel_path(&vault_root, &rel_path)?;
        let encoded = mntl_core::encode_unencrypted_note(&content).map_err(|e| e.to_string())?;
        fs::write(&path, encoded).map_err(|e| format!("Failed to write note: {e}"))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedNote {
    pub name: String,
    pub rel_path: String,
}

#[tauri::command]
pub fn create_note(vault_root: String, rel_dir: String, name: String) -> Result<CreatedNote, String> {
    logged("create_note", || {
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
    })
}

#[tauri::command]
pub fn rename_note(vault_root: String, rel_path: String, new_name: String) -> Result<CreatedNote, String> {
    logged("rename_note", || {
        if rel_path.ends_with(".mntl.enc") {
            return Err("Encrypted notes are not supported yet".to_string());
        }
        if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') || new_name.contains(':') {
            return Err("Invalid note name".to_string());
        }
        let source = resolve_rel_path(&vault_root, &rel_path)?;
        let (dir_rel, _) = split_rel_note_path(&rel_path);
        let dest_rel = if dir_rel.is_empty() {
            format!("{new_name}.mntl")
        } else {
            format!("{dir_rel}/{new_name}.mntl")
        };
        let dest = resolve_rel_path(&vault_root, &dest_rel)?;
        if dest != source && dest.exists() {
            return Err(format!("A note named \"{new_name}\" already exists in this folder"));
        }
        fs::rename(&source, &dest).map_err(|e| format!("Failed to rename note: {e}"))?;
        Ok(CreatedNote {
            name: new_name,
            rel_path: dest_rel,
        })
    })
}

#[tauri::command]
pub fn delete_note(vault_root: String, rel_path: String) -> Result<(), String> {
    logged("delete_note", || {
        let path = resolve_rel_path(&vault_root, &rel_path)?;
        // Send to the OS recycle bin/trash rather than unlinking outright, so a
        // deleted note stays recoverable through the normal OS trash UI.
        trash::delete(&path).map_err(|e| format!("Failed to delete note: {e}"))
    })
}

#[tauri::command]
pub fn delete_folder(vault_root: String, rel_path: String) -> Result<(), String> {
    logged("delete_folder", || {
        let path = resolve_rel_path(&vault_root, &rel_path)?;
        // Same recycle-bin behavior as delete_note; trash::delete handles directories recursively.
        trash::delete(&path).map_err(|e| format!("Failed to delete folder: {e}"))
    })
}

/// Resolve a vault-relative directory (empty string means the vault root)
/// to an absolute path, guarding against traversal outside the vault.
fn resolve_rel_dir(vault_root: &str, rel_dir: &str) -> Result<PathBuf, String> {
    let canonical_root = PathBuf::from(vault_root)
        .canonicalize()
        .map_err(|e| format!("Invalid vault root: {e}"))?;
    if rel_dir.is_empty() {
        return Ok(canonical_root);
    }

    let normalized = rel_dir.replace('\\', "/");
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." || component.contains(':') {
            return Err(format!("Invalid path component in rel_dir: {rel_dir}"));
        }
    }

    let mut candidate = canonical_root.clone();
    for component in normalized.split('/') {
        candidate.push(component);
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("Destination folder does not exist: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Path escapes vault root".to_string());
    }
    if !canonical.is_dir() {
        return Err("Destination is not a folder".to_string());
    }
    Ok(canonical)
}

/// Split a vault-relative note path into its parent dir (possibly empty)
/// and file stem (name without the `.mntl` extension).
fn split_rel_note_path(rel_path: &str) -> (String, String) {
    let (dir_rel, file_name) = match rel_path.rsplit_once('/') {
        Some((dir, file)) => (dir.to_string(), file.to_string()),
        None => (String::new(), rel_path.to_string()),
    };
    let stem = file_name.strip_suffix(".mntl").unwrap_or(&file_name).to_string();
    (dir_rel, stem)
}

/// Find a non-colliding `.mntl` filename for `stem` inside `dir_abs`.
/// If `force_suffix` is true (or the plain name already collides), tries
/// "stem copy.mntl", "stem copy 2.mntl", etc. Returns the absolute path and
/// the resulting vault-relative path (`dir_rel/name.mntl`).
fn unique_sibling_note_path(dir_abs: &Path, dir_rel: &str, stem: &str, force_suffix: bool) -> (PathBuf, String) {
    let make_rel = |name: &str| {
        if dir_rel.is_empty() {
            format!("{name}.mntl")
        } else {
            format!("{dir_rel}/{name}.mntl")
        }
    };

    if !force_suffix {
        let path = dir_abs.join(format!("{stem}.mntl"));
        if !path.exists() {
            return (path, make_rel(stem));
        }
    }

    let mut n = 1;
    loop {
        let candidate_stem = if n == 1 { format!("{stem} copy") } else { format!("{stem} copy {n}") };
        let path = dir_abs.join(format!("{candidate_stem}.mntl"));
        if !path.exists() {
            return (path, make_rel(&candidate_stem));
        }
        n += 1;
    }
}

#[tauri::command]
pub fn duplicate_note(vault_root: String, rel_path: String) -> Result<CreatedNote, String> {
    logged("duplicate_note", || {
        if rel_path.ends_with(".mntl.enc") {
            return Err("Encrypted notes are not supported yet".to_string());
        }
        let source = resolve_rel_path(&vault_root, &rel_path)?;
        let dir_abs = source.parent().ok_or("Invalid rel_path")?.to_path_buf();
        let (dir_rel, stem) = split_rel_note_path(&rel_path);

        let (dest_abs, dest_rel) = unique_sibling_note_path(&dir_abs, &dir_rel, &stem, true);
        fs::copy(&source, &dest_abs).map_err(|e| format!("Failed to duplicate note: {e}"))?;
        Ok(CreatedNote {
            name: dest_abs
                .file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            rel_path: dest_rel,
        })
    })
}

#[tauri::command]
pub fn copy_note(vault_root: String, source_rel_path: String, dest_rel_dir: String) -> Result<CreatedNote, String> {
    logged("copy_note", || {
        if source_rel_path.ends_with(".mntl.enc") {
            return Err("Encrypted notes are not supported yet".to_string());
        }
        let source = resolve_rel_path(&vault_root, &source_rel_path)?;
        let dest_dir_abs = resolve_rel_dir(&vault_root, &dest_rel_dir)?;
        let (_, stem) = split_rel_note_path(&source_rel_path);

        let (dest_abs, dest_rel) = unique_sibling_note_path(&dest_dir_abs, &dest_rel_dir, &stem, false);
        fs::copy(&source, &dest_abs).map_err(|e| format!("Failed to copy note: {e}"))?;
        Ok(CreatedNote {
            name: dest_abs
                .file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            rel_path: dest_rel,
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFolder {
    pub name: String,
    pub rel_path: String,
}

#[tauri::command]
pub fn create_folder(vault_root: String, rel_dir: String, name: String) -> Result<CreatedFolder, String> {
    logged("create_folder", || {
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains(':') {
            return Err("Invalid folder name".to_string());
        }
        let dest_dir_abs = resolve_rel_dir(&vault_root, &rel_dir)?;
        let rel_path = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        let path = dest_dir_abs.join(&name);
        if path.exists() {
            return Err(format!("A folder named \"{name}\" already exists in this location"));
        }
        fs::create_dir(&path).map_err(|e| format!("Failed to create folder: {e}"))?;
        Ok(CreatedFolder { name, rel_path })
    })
}

#[tauri::command]
pub fn rename_folder(vault_root: String, rel_path: String, new_name: String) -> Result<CreatedFolder, String> {
    logged("rename_folder", || {
        if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') || new_name.contains(':') {
            return Err("Invalid folder name".to_string());
        }
        let source = resolve_rel_path(&vault_root, &rel_path)?;
        let dir_rel = rel_path.rsplit_once('/').map(|(dir, _)| dir.to_string()).unwrap_or_default();
        let dest_rel = if dir_rel.is_empty() {
            new_name.clone()
        } else {
            format!("{dir_rel}/{new_name}")
        };
        let dest = resolve_rel_path(&vault_root, &dest_rel)?;
        if dest != source && dest.exists() {
            return Err(format!("A folder named \"{new_name}\" already exists in this location"));
        }
        fs::rename(&source, &dest).map_err(|e| format!("Failed to rename folder: {e}"))?;
        Ok(CreatedFolder {
            name: new_name,
            rel_path: dest_rel,
        })
    })
}

#[tauri::command]
pub fn move_note(vault_root: String, source_rel_path: String, dest_rel_dir: String) -> Result<CreatedNote, String> {
    logged("move_note", || {
        if source_rel_path.ends_with(".mntl.enc") {
            return Err("Encrypted notes are not supported yet".to_string());
        }
        let source = resolve_rel_path(&vault_root, &source_rel_path)?;
        let dest_dir_abs = resolve_rel_dir(&vault_root, &dest_rel_dir)?;
        let (_, stem) = split_rel_note_path(&source_rel_path);

        let (dest_abs, dest_rel) = unique_sibling_note_path(&dest_dir_abs, &dest_rel_dir, &stem, false);
        fs::rename(&source, &dest_abs).map_err(|e| format!("Failed to move note: {e}"))?;
        Ok(CreatedNote {
            name: dest_abs
                .file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            rel_path: dest_rel,
        })
    })
}

#[tauri::command]
pub fn move_folder(vault_root: String, source_rel_path: String, dest_rel_dir: String) -> Result<CreatedFolder, String> {
    logged("move_folder", || {
        let source = resolve_rel_path(&vault_root, &source_rel_path)?;
        let dest_dir_abs = resolve_rel_dir(&vault_root, &dest_rel_dir)?;
        let name = source
            .file_name()
            .ok_or("Invalid rel_path")?
            .to_string_lossy()
            .into_owned();
        let dest_abs = dest_dir_abs.join(&name);

        if dest_abs == source {
            return Ok(CreatedFolder { name, rel_path: source_rel_path });
        }
        if dest_abs.starts_with(&source) {
            return Err("Cannot move a folder into itself or one of its subfolders".to_string());
        }
        if dest_abs.exists() {
            return Err(format!("\"{name}\" already exists in the destination folder"));
        }

        let dest_rel = if dest_rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{dest_rel_dir}/{name}")
        };
        fs::rename(&source, &dest_abs).map_err(|e| format!("Failed to move folder: {e}"))?;
        Ok(CreatedFolder { name, rel_path: dest_rel })
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

    #[test]
    fn create_folder_creates_at_root_and_nested() {
        let root = temp_dir("create-folder");
        fs::create_dir_all(root.join("Work")).unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let created = create_folder(root_str.clone(), String::new(), "Archive".to_string()).unwrap();
        assert_eq!(created.rel_path, "Archive");
        assert!(root.join("Archive").is_dir());

        let nested = create_folder(root_str, "Work".to_string(), "Drafts".to_string()).unwrap();
        assert_eq!(nested.rel_path, "Work/Drafts");
        assert!(root.join("Work").join("Drafts").is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_folder_rejects_collisions_and_invalid_names() {
        let root = temp_dir("create-folder-invalid");
        fs::create_dir_all(root.join("Archive")).unwrap();
        let root_str = root.to_string_lossy().into_owned();

        assert!(create_folder(root_str.clone(), String::new(), "Archive".to_string()).is_err());
        assert!(create_folder(root_str.clone(), String::new(), "a/b".to_string()).is_err());
        assert!(create_folder(root_str, String::new(), String::new()).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_note_renames_in_place_and_rejects_collisions() {
        let root = temp_dir("rename-note");
        fs::create_dir_all(root.join("Work")).unwrap();
        fs::write(root.join("Work").join("todo.mntl"), "---\nv: 2\n---\n").unwrap();
        fs::write(root.join("Work").join("taken.mntl"), "---\nv: 2\n---\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let renamed = rename_note(root_str.clone(), "Work/todo.mntl".to_string(), "done".to_string()).unwrap();
        assert_eq!(renamed.rel_path, "Work/done.mntl");
        assert!(root.join("Work").join("done.mntl").is_file());
        assert!(!root.join("Work").join("todo.mntl").exists());

        assert!(rename_note(root_str.clone(), "Work/done.mntl".to_string(), "taken".to_string()).is_err());
        assert!(rename_note(root_str, "Work/done.mntl".to_string(), "a/b".to_string()).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_folder_renames_in_place_and_rejects_collisions() {
        let root = temp_dir("rename-folder");
        fs::create_dir_all(root.join("Work")).unwrap();
        fs::create_dir_all(root.join("Archive")).unwrap();
        fs::write(root.join("Work").join("todo.mntl"), "---\nv: 2\n---\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let renamed = rename_folder(root_str.clone(), "Work".to_string(), "Projects".to_string()).unwrap();
        assert_eq!(renamed.rel_path, "Projects");
        assert!(root.join("Projects").join("todo.mntl").is_file());
        assert!(!root.join("Work").exists());

        assert!(rename_folder(root_str.clone(), "Projects".to_string(), "Archive".to_string()).is_err());
        assert!(rename_folder(root_str, "Projects".to_string(), "a/b".to_string()).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_folder_moves_into_destination_and_rejects_cycles_and_collisions() {
        let root = temp_dir("move-folder");
        fs::create_dir_all(root.join("Work").join("Nested")).unwrap();
        fs::create_dir_all(root.join("Archive")).unwrap();
        fs::create_dir_all(root.join("Archive").join("Work")).unwrap();
        fs::write(root.join("Work").join("todo.mntl"), "---\nv: 2\n---\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        // moving into itself or a subfolder of itself is rejected
        assert!(move_folder(root_str.clone(), "Work".to_string(), "Work".to_string()).is_err());
        assert!(move_folder(root_str.clone(), "Work".to_string(), "Work/Nested".to_string()).is_err());

        // colliding with an existing folder at the destination is rejected
        assert!(move_folder(root_str.clone(), "Work".to_string(), "Archive".to_string()).is_err());

        let moved = move_folder(root_str.clone(), "Work".to_string(), "".to_string()).unwrap();
        assert_eq!(moved.rel_path, "Work");

        let moved = move_folder(root_str.clone(), "Work".to_string(), "Nonexistent".to_string());
        assert!(moved.is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_folder_removes_the_directory_and_its_contents() {
        let root = temp_dir("delete-folder");
        fs::create_dir_all(root.join("Work").join("Nested")).unwrap();
        fs::write(root.join("Work").join("todo.mntl"), "---\nv: 2\n---\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        delete_folder(root_str, "Work".to_string()).unwrap();
        assert!(!root.join("Work").exists());

        let _ = fs::remove_dir_all(&root);
    }
}
