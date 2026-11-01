//! Vault-wide tag edits: renaming a tag, or removing it, in every note that
//! has it.
//!
//! A note's tags live in the note itself (see [`mntl_core::tags`]), so this
//! rewrites each affected note file. Encrypted notes of a locked profile
//! can't be read, let alone rewritten, so they are skipped and counted; the
//! frontend tells the user.
//!
//! As in [`crate::notes_crypto`], errors here reach the on-disk log — never
//! interpolate decrypted note content into one.

use crate::credentials::SessionKeys;
use crate::logging::logged;
use crate::vault::{
    clean_tags, is_markdown_note, master_key_for, note_paths, resolve_rel_path, sealed_hidden, write_atomic,
    EXT_ENCRYPTED,
};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagEditReport {
    /// Vault-relative paths of the notes that were rewritten.
    pub updated: Vec<String>,
    /// Encrypted notes that couldn't be checked because their profile is
    /// locked. Whether any of them has the tag is unknowable until unlocked.
    pub locked_skipped: usize,
}

/// Rename the tag `from` to `to` in every note that has it, matching case-
/// insensitively. A note that already has `to` just loses `from`, so renaming
/// onto an existing tag merges the two.
#[tauri::command(async)]
pub fn rename_tag(
    vault_root: String,
    from: String,
    to: String,
    keys: State<SessionKeys>,
) -> Result<TagEditReport, String> {
    logged("rename_tag", || {
        let to = mntl_core::normalize_tag(&to).ok_or_else(|| {
            "Tags can only contain letters, numbers, - and _, and can't be only numbers".to_string()
        })?;
        edit_tag_in_vault(&vault_root, &from, Some(&to), &keys)
    })
}

/// Remove the tag `tag` from every note that has it, matching case-insensitively.
#[tauri::command(async)]
pub fn remove_tag(
    vault_root: String,
    tag: String,
    keys: State<SessionKeys>,
) -> Result<TagEditReport, String> {
    logged("remove_tag", || edit_tag_in_vault(&vault_root, &tag, None, &keys))
}

pub(crate) fn edit_tag_in_vault(
    vault_root: &str,
    from: &str,
    to: Option<&str>,
    keys: &SessionKeys,
) -> Result<TagEditReport, String> {
    let root = PathBuf::from(vault_root);
    if !root.is_dir() {
        return Err("The vault folder no longer exists".to_string());
    }

    let mut report = TagEditReport::default();
    for (rel_path, disk) in note_paths(vault_root, keys)? {
        let path = resolve_rel_path(vault_root, &disk)?;
        match edit_note_tags(vault_root, &path, &rel_path, |tags| edited_tags(tags, from, to), keys) {
            Ok(true) => report.updated.push(rel_path),
            Ok(false) => {}
            Err(NoteEditError::Locked) => report.locked_skipped += 1,
            Err(NoteEditError::Failed(e)) => return Err(format!("Failed to update \"{rel_path}\": {e}")),
        }
    }
    Ok(report)
}

/// Set each listed note's tags to exactly the given ones, for undoing a
/// vault-wide edit note by note. Unlike a rename this fails on a locked note:
/// skipping it would leave the undo half done without saying so.
#[tauri::command]
pub fn set_note_tags(
    vault_root: String,
    tags_by_note: HashMap<String, Vec<String>>,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    logged("set_note_tags", || set_note_tags_inner(&vault_root, &tags_by_note, &keys))
}

fn set_note_tags_inner(
    vault_root: &str,
    tags_by_note: &HashMap<String, Vec<String>>,
    keys: &SessionKeys,
) -> Result<(), String> {
    for (rel_path, tags) in tags_by_note {
        let path = crate::hidden::resolve_note(vault_root, rel_path, keys)?;
        match edit_note_tags(vault_root, &path, rel_path, |_| Some(clean_tags(tags)), keys) {
            Ok(_) => {}
            Err(NoteEditError::Locked) => return Err(format!("\"{rel_path}\" is locked")),
            Err(NoteEditError::Failed(e)) => return Err(format!("Failed to update \"{rel_path}\": {e}")),
        }
    }
    Ok(())
}

pub(crate) enum NoteEditError {
    Locked,
    Failed(String),
}

impl From<String> for NoteEditError {
    fn from(e: String) -> Self {
        NoteEditError::Failed(e)
    }
}

/// Rewrite one note's tags with `edit`, which returns `None` when the note
/// needs no rewrite. `Ok(true)` if it was rewritten.
fn edit_note_tags(
    vault_root: &str,
    path: &Path,
    rel_path: &str,
    edit: impl Fn(&[String]) -> Option<Vec<String>>,
    keys: &SessionKeys,
) -> Result<bool, NoteEditError> {
    edit_note(vault_root, path, rel_path, keys, |tags, _| match edit(tags) {
        Some(edited) => {
            *tags = edited;
            true
        }
        None => false,
    })
}

/// `tags` with `from` renamed to `to` (or dropped), or `None` if `from` isn't
/// among them and the note needs no rewrite.
fn edited_tags(tags: &[String], from: &str, to: Option<&str>) -> Option<Vec<String>> {
    if !tags.iter().any(|tag| mntl_core::same_tag(tag, from)) {
        return None;
    }
    let edited = tags.iter().filter_map(|tag| {
        if mntl_core::same_tag(tag, from) {
            to.map(str::to_string)
        } else {
            Some(tag.clone())
        }
    });
    Some(clean_tags(&edited.collect::<Vec<_>>()))
}

/// Rewrite one note in place with `edit`, given its tags and body, which
/// returns whether it changed either. `Ok(true)` if the note was rewritten.
/// Shared by vault-wide edits that touch every note: tags here, links in
/// [`crate::links`].
pub(crate) fn edit_note(
    vault_root: &str,
    path: &Path,
    rel_path: &str,
    keys: &SessionKeys,
    edit: impl FnOnce(&mut Vec<String>, &mut String) -> bool,
) -> Result<bool, NoteEditError> {
    if rel_path.ends_with(EXT_ENCRYPTED) {
        let blob = fs::read(path).map_err(|e| e.to_string())?;
        let (profile_id, mk) = match master_key_for(vault_root, &blob, keys) {
            Ok(found) => found,
            Err(e) if e.starts_with(crate::vault::LOCKED_ERR_PREFIX) => return Err(NoteEditError::Locked),
            Err(e) => return Err(e.into()),
        };
        let document = mntl_core::decrypt_note(&mk, &blob).map_err(|e| e.to_string())?;
        let document = std::str::from_utf8(&document).map_err(|_| "Decrypted note is not UTF-8".to_string())?;
        let (mut frontmatter, body) = mntl_core::decode_note(document).map_err(|e| e.to_string())?;
        let mut body = zeroize::Zeroizing::new(body);
        if !edit(&mut frontmatter.tags, &mut body) {
            return Ok(false);
        }
        let encoded = zeroize::Zeroizing::new(
            mntl_core::encode_note(&frontmatter, &body).map_err(|e| e.to_string())?,
        );
        let resealed = mntl_core::encrypt_note_as(&mk, &profile_id, sealed_hidden(&blob), encoded.as_bytes())
            .map_err(|e| e.to_string())?;
        write_atomic(path, &resealed)?;
        return Ok(true);
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if is_markdown_note(rel_path) {
        let old_tags = mntl_core::markdown_tags(&raw);
        let mut tags = old_tags.clone();
        let (frontmatter, body) = mntl_core::split_markdown_frontmatter(&raw);
        let mut body = body.to_string();
        if !edit(&mut tags, &mut body) {
            return Ok(false);
        }
        // Only the lines that changed: the frontmatter is another tool's.
        let mut updated = format!("{frontmatter}{body}");
        if tags != old_tags {
            updated = mntl_core::set_markdown_tags(&updated, &tags);
        }
        fs::write(path, updated).map_err(|e| e.to_string())?;
        return Ok(true);
    }

    // A `.mntl` that doesn't parse can't be edited in any readable form;
    // leave it alone rather than failing the whole edit over it.
    let Ok((mut frontmatter, mut body)) = mntl_core::decode_note(&raw) else {
        return Ok(false);
    };
    if !edit(&mut frontmatter.tags, &mut body) {
        return Ok(false);
    }
    let encoded = mntl_core::encode_note(&frontmatter, &body).map_err(|e| e.to_string())?;
    fs::write(path, encoded).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::read_note_inner;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-tags-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn encrypted_with_tags(path: &Path, profile_id: &str, tags: &[&str]) -> mntl_core::MasterKey {
        let frontmatter = mntl_core::NoteFrontmatter {
            tags: tags.iter().map(|t| t.to_string()).collect(),
            ..Default::default()
        };
        let document = mntl_core::encode_note(&frontmatter, "Body").unwrap();
        let mk = mntl_core::MasterKey::generate().unwrap();
        fs::write(path, mntl_core::encrypt_note(&mk, profile_id, document.as_bytes()).unwrap()).unwrap();
        mk
    }

    #[test]
    fn edited_tags_renames_merges_and_removes_case_insensitively() {
        let tags: Vec<String> = ["Idea", "draft"].iter().map(|s| s.to_string()).collect();
        assert_eq!(edited_tags(&tags, "idea", Some("thought")), Some(vec!["thought".into(), "draft".into()]));
        assert_eq!(edited_tags(&tags, "IDEA", Some("Draft")), Some(vec!["Draft".into()]));
        assert_eq!(edited_tags(&tags, "idea", None), Some(vec!["draft".into()]));
        assert_eq!(edited_tags(&tags, "other", None), None);
    }

    #[test]
    fn rename_rewrites_every_readable_note_and_counts_locked_ones() {
        let root = temp_dir("rename");
        let root_str = root.to_string_lossy().into_owned();
        fs::create_dir(root.join("Work")).unwrap();
        fs::write(root.join("Work/plan.mntl"), "---\nv: 2\ntags:\n- idea\n- work\n---\nBody").unwrap();
        fs::write(root.join("readme.md"), "---\ntitle: R\ntags: [Idea]\n---\nBody").unwrap();
        fs::write(root.join("other.mntl"), "---\nv: 2\ntags:\n- work\n---\nBody").unwrap();
        let mk = encrypted_with_tags(&root.join("open.mntl.enc"), "open", &["idea"]);
        encrypted_with_tags(&root.join("shut.mntl.enc"), "shut", &["idea"]);

        let keys = SessionKeys::default();
        keys.unlock_for_test(&root_str, "open", mk).unwrap();

        let mut report = edit_tag_in_vault(&root_str, "IDEA", Some("thought"), &keys).unwrap();
        report.updated.sort();
        assert_eq!(report.updated, vec!["Work/plan.mntl", "open.mntl.enc", "readme.md"]);
        assert_eq!(report.locked_skipped, 1);

        assert_eq!(
            fs::read_to_string(root.join("Work/plan.mntl")).unwrap(),
            "---\nv: 2\ntags:\n- thought\n- work\n---\nBody"
        );
        assert_eq!(
            fs::read_to_string(root.join("readme.md")).unwrap(),
            "---\ntitle: R\ntags: [thought]\n---\nBody"
        );
        assert_eq!(read_note_inner(&root_str, "open.mntl.enc", &keys).unwrap().tags, vec!["thought"]);

        let report = edit_tag_in_vault(&root_str, "work", None, &keys).unwrap();
        assert_eq!(report.updated.len(), 2);
        assert_eq!(fs::read_to_string(root.join("other.mntl")).unwrap(), "---\nv: 2\n---\nBody");

        let _ = fs::remove_dir_all(&root);
    }
}
