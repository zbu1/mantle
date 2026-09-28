//! Tauri commands for browsing and persisting a vault: a directory tree of
//! `.mntl` (plaintext) and `.mntl.enc` (encrypted) note files, plus plain
//! Markdown (`.md` / `.markdown`) files written by other tools.
//!
//! Markdown files are opened and saved in place as-is. Their own YAML
//! frontmatter, if any, is hidden from the editor and written back verbatim,
//! and they are never converted to `.mntl` behind the user's back — that only
//! happens through [`crate::notes_crypto`].
//!
//! Reading and writing an encrypted note requires its credential profile to be
//! unlocked in [`crate::credentials::SessionKeys`]. Everything structural —
//! rename, move, duplicate, copy, delete — works regardless, because those
//! operations never look at a note's contents.

use crate::credentials::SessionKeys;
use crate::logging::logged;
use serde::Serialize;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::State;

/// Extension of a plaintext note file.
pub(crate) const EXT_PLAIN: &str = ".mntl";

/// Extension of an encrypted note file. A compound extension, so it must
/// always be tested before [`EXT_PLAIN`] — `.mntl.enc` also ends with `.enc`
/// but *starts* a `.mntl` suffix match only by accident of ordering.
pub(crate) const EXT_ENCRYPTED: &str = ".mntl.enc";

/// Extensions of plain Markdown files, which open as notes but keep their
/// own format on disk. Matched case-sensitively, like the `.mntl` extensions.
const EXT_MARKDOWN: [&str; 2] = [".md", ".markdown"];

/// The Markdown extension `file_name` ends with, if any.
fn markdown_ext(file_name: &str) -> Option<&'static str> {
    EXT_MARKDOWN.into_iter().find(|ext| file_name.ends_with(ext))
}

/// Whether the note at `rel_path` is a plain Markdown file rather than a
/// `.mntl` / `.mntl.enc` note.
pub(crate) fn is_markdown_note(rel_path: &str) -> bool {
    markdown_ext(rel_path).is_some()
}

/// Classify a filename as a note file this app understands, returning its
/// display title (filename stem) and whether it's the encrypted format.
///
/// `.mntl.enc` is a compound extension, so it must be checked before `.mntl`.
fn classify_note_file(filename: &str) -> Option<(String, bool)> {
    if let Some(stem) = filename.strip_suffix(EXT_ENCRYPTED) {
        return Some((stem.to_string(), true));
    }
    if let Some(stem) = filename.strip_suffix(EXT_PLAIN) {
        return Some((stem.to_string(), false));
    }
    if let Some(ext) = markdown_ext(filename) {
        return Some((filename[..filename.len() - ext.len()].to_string(), false));
    }
    None
}

/// Prefix of the error returned when a note's credential profile is locked,
/// followed by the profile's id (e.g. `mantle:locked:my-diary`).
///
/// The backend is the single authority on lock state: having the frontend
/// check before calling would duplicate that authority and force `NotesState`
/// to depend on `CredentialsState`, which already depends on it.
pub const LOCKED_ERR_PREFIX: &str = "mantle:locked:";

/// Largest `.mntl.enc` header we will allocate for during a scan. Real headers
/// are ~200 bytes; this only exists so a corrupt length prefix can't ask us
/// for gigabytes.
const MAX_SCANNED_HEADER_LEN: usize = 8192;

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
        /// Whether this is a `.mntl.enc` file. **Not** whether it is currently
        /// readable — that depends on session state the scan knows nothing
        /// about. The frontend derives "locked" as
        /// `encrypted && !unlockedProfiles.has(profile)`.
        encrypted: bool,
        /// Credential profile this note is encrypted under, read from its
        /// header. `None` for plaintext notes and for encrypted notes whose
        /// header could not be parsed.
        profile: Option<String>,
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

/// Read just the framing bytes and JSON header of a `.mntl.enc` file — enough
/// for [`mntl_core::extract_encrypted_header`], and nothing of the ciphertext.
///
/// A real header is a couple of hundred bytes, so this keeps both a vault scan
/// and an overwrite cheap regardless of how large the notes are.
pub(crate) fn read_header_prefix(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to read note: {e}"))?;

    let mut prefix = [0u8; mntl_core::HEADER_OFFSET];
    file.read_exact(&mut prefix)
        .map_err(|e| format!("Failed to read note header: {e}"))?;
    if &prefix[0..4] != mntl_core::MAGIC_MENC {
        return Err("Not an encrypted note".to_string());
    }

    let header_len = u32::from_le_bytes(
        prefix[4..8]
            .try_into()
            .map_err(|_| "Malformed note header".to_string())?,
    ) as usize;
    // Bound the allocation before trusting a length read off disk.
    if header_len == 0 || header_len > MAX_SCANNED_HEADER_LEN {
        return Err("Malformed note header".to_string());
    }

    let mut buf = vec![0u8; mntl_core::HEADER_OFFSET + header_len];
    buf[..mntl_core::HEADER_OFFSET].copy_from_slice(&prefix);
    file.read_exact(&mut buf[mntl_core::HEADER_OFFSET..])
        .map_err(|e| format!("Failed to read note header: {e}"))?;

    Ok(buf)
}

/// The credential profile id in a `.mntl.enc` file's header.
///
/// Returns `None` for anything malformed rather than an error: one corrupt
/// file must never make a whole vault fail to open. Such a note simply shows
/// up with no profile, which the UI presents as an orphan.
fn read_profile_id(path: &Path) -> Option<String> {
    let buf = read_header_prefix(path).ok()?;
    mntl_core::extract_encrypted_header(&buf)
        .ok()
        .map(|h| h.credential_profile)
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
            if let Some((title, encrypted)) = classify_note_file(&name) {
                let profile = if encrypted {
                    read_profile_id(&entry.path())
                } else {
                    None
                };
                notes.push(VaultNode::Note {
                    name: title,
                    rel_path: to_slash(&child_rel),
                    encrypted,
                    profile,
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
pub(crate) fn resolve_rel_path(vault_root: &str, rel_path: &str) -> Result<PathBuf, String> {
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

/// Creates a new, empty vault directory at `path` and seeds its
/// `.mantle/state.json`, returning `path` for the frontend to open.
///
/// The directory itself must not exist yet — creating a vault never adopts or
/// overwrites an existing folder (use "Open Vault" for that) — but its parent
/// must, so a typo in the location fails instead of silently creating a chain
/// of directories. `path` is returned as given rather than canonicalized, so
/// Windows callers don't get a `\\?\` verbatim prefix back.
#[tauri::command]
pub fn create_vault(path: String) -> Result<String, String> {
    logged("create_vault", || {
        let dir = PathBuf::from(&path);
        let name = dir
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid vault name")?;
        if name.is_empty() || name.contains(':') || name.starts_with('.') {
            return Err("Invalid vault name".to_string());
        }
        let parent = dir.parent().filter(|p| !p.as_os_str().is_empty()).ok_or("Invalid vault location")?;
        if !parent.is_dir() {
            return Err("The folder to create the vault in does not exist".to_string());
        }
        if dir.exists() {
            return Err(format!("A file or folder named \"{name}\" already exists in this location"));
        }
        fs::create_dir(&dir).map_err(|e| format!("Failed to create vault folder: {e}"))?;
        crate::vault_meta::write_vault_meta(&path, &crate::vault_meta::VaultMeta::default())?;
        Ok(path)
    })
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

/// The master key for the profile a `.mntl.enc` blob names, or the
/// `mantle:locked:<id>` sentinel if that profile is not unlocked.
pub(crate) fn master_key_for(
    vault_root: &str,
    blob: &[u8],
    keys: &SessionKeys,
) -> Result<(String, mntl_core::MasterKey), String> {
    let header = mntl_core::extract_encrypted_header(blob)
        .map_err(|e| format!("Not a readable encrypted note: {e}"))?;
    let profile_id = header.credential_profile;

    match keys.get(vault_root, &profile_id)? {
        Some(mk) => Ok((profile_id, mk)),
        None => Err(format!("{LOCKED_ERR_PREFIX}{profile_id}")),
    }
}

#[tauri::command]
pub fn read_note(
    vault_root: String,
    rel_path: String,
    keys: State<SessionKeys>,
) -> Result<String, String> {
    logged("read_note", || read_note_inner(&vault_root, &rel_path, &keys))
}

pub(crate) fn read_note_inner(
    vault_root: &str,
    rel_path: &str,
    keys: &SessionKeys,
) -> Result<String, String> {
    let path = resolve_rel_path(vault_root, rel_path)?;

    if rel_path.ends_with(EXT_ENCRYPTED) {
        let bytes = fs::read(&path).map_err(|e| format!("Failed to read note: {e}"))?;
        let (_, mk) = master_key_for(vault_root, &bytes, keys)?;
        let document = mntl_core::decrypt_note(&mk, &bytes).map_err(|e| e.to_string())?;
        let document =
            std::str::from_utf8(&document).map_err(|_| "Decrypted note is not UTF-8".to_string())?;
        return mntl_core::decode_unencrypted_note(document).map_err(|e| e.to_string());
    }

    let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {e}"))?;
    if is_markdown_note(rel_path) {
        // The frontmatter is another tool's; `write_note_inner` puts it back.
        let (_, body) = mntl_core::split_markdown_frontmatter(&raw);
        return Ok(body.to_string());
    }
    mntl_core::decode_unencrypted_note(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_note(
    vault_root: String,
    rel_path: String,
    content: String,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    logged("write_note", || {
        write_note_inner(&vault_root, &rel_path, &content, &keys)
    })
}

pub(crate) fn write_note_inner(
    vault_root: &str,
    rel_path: &str,
    content: &str,
    keys: &SessionKeys,
) -> Result<(), String> {
    let path = resolve_rel_path(vault_root, rel_path)?;

    if is_markdown_note(rel_path) {
        // Keep whatever frontmatter is on disk *now*, byte for byte, rather
        // than a copy from when the note was read: another tool may have
        // changed it since, and the editor never shows it.
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let (frontmatter, _) = mntl_core::split_markdown_frontmatter(&existing);
        return fs::write(&path, format!("{frontmatter}{content}"))
            .map_err(|e| format!("Failed to write note: {e}"));
    }

    let encoded = mntl_core::encode_unencrypted_note(content).map_err(|e| e.to_string())?;

    if rel_path.ends_with(EXT_ENCRYPTED) {
        // Re-seal under the profile the file already names. A write never
        // re-homes a note to a different profile — that is
        // `notes_crypto::move_note_to_profile`'s job, and it has to re-encrypt
        // rather than just relabel, since the header is the AAD.
        //
        // Read only the framing + header, not the (potentially large)
        // ciphertext we are about to replace wholesale.
        let existing = read_header_prefix(&path)?;
        let (profile_id, mk) = master_key_for(vault_root, &existing, keys)?;
        // `encrypt_note` generates a fresh content key and nonce on every
        // call, so nothing from the previous version of the file is reused.
        let blob =
            mntl_core::encrypt_note(&mk, &profile_id, encoded.as_bytes()).map_err(|e| e.to_string())?;
        return write_atomic(&path, &blob);
    }

    fs::write(&path, encoded).map_err(|e| format!("Failed to write note: {e}"))
}

/// Write `bytes` to `path` via a temp file and a rename, so an interrupted
/// write can't leave a truncated file behind.
///
/// Plaintext notes are written in place because a truncated Markdown file is
/// still partly readable; a truncated ciphertext is unrecoverable, so
/// atomicity matters more here, not less.
///
/// The temp file is dot-prefixed so `scan_dir` skips it if a crash leaves one
/// behind.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let dir = path.parent().ok_or("Invalid note path")?;
    let file_name = path
        .file_name()
        .ok_or("Invalid note path")?
        .to_string_lossy()
        .into_owned();
    let tmp = dir.join(format!(".{file_name}.tmp"));

    // Register before writing, so the notification can never beat us to it.
    // Both paths, because a rename event names the source and the destination
    // and the watcher only ignores an event when *all* of its paths are ours.
    crate::watcher::suppress(&tmp);
    crate::watcher::suppress(path);

    let mut file = File::create(&tmp).map_err(|e| format!("Failed to write note: {e}"))?;
    file.write_all(bytes)
        .map_err(|e| format!("Failed to write note: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to flush note: {e}"))?;
    drop(file);

    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to save note: {e}")
    })
}

#[derive(Serialize, Debug)]
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
        let rel_path = join_rel_note_path(&rel_dir, &name, EXT_PLAIN);
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
    // Works for encrypted notes too: a rename is a pure `fs::rename` that
    // never inspects content, so it needs no key and no unlocked profile.
    logged("rename_note", || {
        if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') || new_name.contains(':') {
            return Err("Invalid note name".to_string());
        }
        let source = resolve_rel_path(&vault_root, &rel_path)?;
        // Preserve the note's own extension: renaming an encrypted note must
        // not silently turn it into a `.mntl`.
        let (dir_rel, _, ext) = split_rel_note_path(&rel_path);
        let dest_rel = join_rel_note_path(&dir_rel, &new_name, ext);
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
pub(crate) fn resolve_rel_dir(vault_root: &str, rel_dir: &str) -> Result<PathBuf, String> {
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

/// Split a vault-relative note path into its parent dir (possibly empty),
/// file stem, and note extension.
///
/// Returning the extension is what keeps `.mntl.enc` intact through rename,
/// duplicate, copy and move: stripping only `.mntl` would leave the stem of
/// `secret.mntl.enc` as `secret.mntl` and rebuild it as `secret.mntl.mntl`, or
/// on the rename path hand a ciphertext file a plaintext extension.
///
/// A Markdown file keeps its own `.md` / `.markdown` extension. A path with
/// none of these extensions is treated as plaintext, matching the previous
/// `unwrap_or` behavior.
pub(crate) fn split_rel_note_path(rel_path: &str) -> (String, String, &'static str) {
    let (dir_rel, file_name) = match rel_path.rsplit_once('/') {
        Some((dir, file)) => (dir.to_string(), file.to_string()),
        None => (String::new(), rel_path.to_string()),
    };

    if let Some(stem) = file_name.strip_suffix(EXT_ENCRYPTED) {
        return (dir_rel, stem.to_string(), EXT_ENCRYPTED);
    }
    if let Some(ext) = markdown_ext(&file_name) {
        let stem = file_name[..file_name.len() - ext.len()].to_string();
        return (dir_rel, stem, ext);
    }
    let stem = file_name.strip_suffix(EXT_PLAIN).unwrap_or(&file_name);
    (dir_rel, stem.to_string(), EXT_PLAIN)
}

/// The display title of a note at `rel_path`, i.e. its filename with the note
/// extension removed.
///
/// Use this rather than `Path::file_stem`, which strips a single extension and
/// so leaves `"note.mntl"` for `"note.mntl.enc"`.
pub(crate) fn note_display_name(rel_path: &str) -> String {
    let (_, stem, _) = split_rel_note_path(rel_path);
    stem
}

/// Build a vault-relative note path from a directory, stem and extension.
pub(crate) fn join_rel_note_path(dir_rel: &str, stem: &str, ext: &str) -> String {
    if dir_rel.is_empty() {
        format!("{stem}{ext}")
    } else {
        format!("{dir_rel}/{stem}{ext}")
    }
}

/// Find a non-colliding filename for `stem` + `ext` inside `dir_abs`.
/// If `force_suffix` is true (or the plain name already collides), tries
/// "stem copy", "stem copy 2", etc. Returns the absolute path and the
/// resulting vault-relative path.
pub(crate) fn unique_sibling_note_path(
    dir_abs: &Path,
    dir_rel: &str,
    stem: &str,
    ext: &str,
    force_suffix: bool,
) -> (PathBuf, String) {
    if !force_suffix {
        let path = dir_abs.join(format!("{stem}{ext}"));
        if !path.exists() {
            return (path, join_rel_note_path(dir_rel, stem, ext));
        }
    }

    let mut n = 1;
    loop {
        let candidate_stem = if n == 1 { format!("{stem} copy") } else { format!("{stem} copy {n}") };
        let path = dir_abs.join(format!("{candidate_stem}{ext}"));
        if !path.exists() {
            return (path, join_rel_note_path(dir_rel, &candidate_stem, ext));
        }
        n += 1;
    }
}

#[tauri::command]
pub fn duplicate_note(vault_root: String, rel_path: String) -> Result<CreatedNote, String> {
    // Duplicating an encrypted note copies its bytes verbatim, so the copy
    // temporarily shares the original's content key and nonce. That is not
    // nonce reuse in the dangerous sense — the plaintexts are identical, so
    // the ciphertexts already were — and the first edit to either copy
    // regenerates both.
    logged("duplicate_note", || {
        let source = resolve_rel_path(&vault_root, &rel_path)?;
        let dir_abs = source.parent().ok_or("Invalid rel_path")?.to_path_buf();
        let (dir_rel, stem, ext) = split_rel_note_path(&rel_path);

        let (dest_abs, dest_rel) = unique_sibling_note_path(&dir_abs, &dir_rel, &stem, ext, true);
        fs::copy(&source, &dest_abs).map_err(|e| format!("Failed to duplicate note: {e}"))?;
        Ok(CreatedNote {
            // Not `dest_abs.file_stem()`: on "note copy.mntl.enc" that yields
            // "note copy.mntl", since `file_stem` strips one extension only.
            name: note_display_name(&dest_rel),
            rel_path: dest_rel,
        })
    })
}

#[tauri::command]
pub fn copy_note(vault_root: String, source_rel_path: String, dest_rel_dir: String) -> Result<CreatedNote, String> {
    // See `duplicate_note` on copying encrypted bytes verbatim.
    logged("copy_note", || {
        let source = resolve_rel_path(&vault_root, &source_rel_path)?;
        let dest_dir_abs = resolve_rel_dir(&vault_root, &dest_rel_dir)?;
        let (_, stem, ext) = split_rel_note_path(&source_rel_path);

        let (dest_abs, dest_rel) =
            unique_sibling_note_path(&dest_dir_abs, &dest_rel_dir, &stem, ext, false);
        fs::copy(&source, &dest_abs).map_err(|e| format!("Failed to copy note: {e}"))?;
        Ok(CreatedNote {
            name: note_display_name(&dest_rel),
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
    // Like `rename_note`, a move is a pure `fs::rename` and needs no key.
    logged("move_note", || {
        let source = resolve_rel_path(&vault_root, &source_rel_path)?;
        let dest_dir_abs = resolve_rel_dir(&vault_root, &dest_rel_dir)?;
        let (_, stem, ext) = split_rel_note_path(&source_rel_path);

        let (dest_abs, dest_rel) =
            unique_sibling_note_path(&dest_dir_abs, &dest_rel_dir, &stem, ext, false);
        fs::rename(&source, &dest_abs).map_err(|e| format!("Failed to move note: {e}"))?;
        Ok(CreatedNote {
            name: note_display_name(&dest_rel),
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
        assert_eq!(
            classify_note_file("readme.md"),
            Some(("readme".to_string(), false))
        );
        assert_eq!(
            classify_note_file("guide.markdown"),
            Some(("guide".to_string(), false))
        );
        assert_eq!(classify_note_file("image.png"), None);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-vault-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_vault_creates_the_folder_and_its_state_file() {
        let parent = temp_dir("create-vault");
        let path = parent.join("My Vault").to_string_lossy().into_owned();
        assert_eq!(create_vault(path.clone()).unwrap(), path);
        assert!(parent.join("My Vault").join(".mantle").join("state.json").is_file());
        assert!(matches!(scan_vault(path).unwrap(), VaultNode::Folder { children, .. } if children.is_empty()));
    }

    #[test]
    fn create_vault_rejects_existing_paths_and_missing_parents() {
        let parent = temp_dir("create-vault-reject");
        fs::create_dir(parent.join("taken")).unwrap();
        assert!(create_vault(parent.join("taken").to_string_lossy().into_owned()).is_err());
        assert!(create_vault(parent.join("missing").join("vault").to_string_lossy().into_owned()).is_err());
        assert!(create_vault(parent.join(".hidden").to_string_lossy().into_owned()).is_err());
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

    #[test]
    fn markdown_notes_hide_and_preserve_their_frontmatter() {
        let root = temp_dir("markdown");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        fs::write(root.join("readme.md"), "---
tags: [x]
---
# Old
").unwrap();

        assert_eq!(read_note_inner(&root_str, "readme.md", &keys).unwrap(), "# Old
");

        write_note_inner(&root_str, "readme.md", "# New
", &keys).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("readme.md")).unwrap(),
            "---
tags: [x]
---
# New
"
        );
    }

    #[test]
    fn markdown_notes_without_frontmatter_stay_plain_markdown() {
        let root = temp_dir("markdown-plain");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        fs::write(root.join("todo.markdown"), "- [ ] one
").unwrap();

        assert_eq!(read_note_inner(&root_str, "todo.markdown", &keys).unwrap(), "- [ ] one
");
        write_note_inner(&root_str, "todo.markdown", "- [x] one
", &keys).unwrap();
        assert_eq!(fs::read_to_string(root.join("todo.markdown")).unwrap(), "- [x] one
");
    }

    #[test]
    fn renaming_a_markdown_note_keeps_its_extension() {
        let root = temp_dir("markdown-rename");
        let root_str = root.to_string_lossy().into_owned();
        fs::write(root.join("readme.md"), "hi").unwrap();

        let renamed = rename_note(root_str, "readme.md".to_string(), "intro".to_string()).unwrap();
        assert_eq!(renamed.rel_path, "intro.md");
        assert!(root.join("intro.md").is_file());
    }

    // --- Compound `.mntl.enc` extension handling -------------------------

    #[test]
    fn split_rel_note_path_handles_double_extension() {
        assert_eq!(
            split_rel_note_path("Work/secret.mntl.enc"),
            ("Work".to_string(), "secret".to_string(), ".mntl.enc")
        );
        assert_eq!(
            split_rel_note_path("Work/todo.mntl"),
            ("Work".to_string(), "todo".to_string(), ".mntl")
        );
        assert_eq!(
            split_rel_note_path("Docs/readme.md"),
            ("Docs".to_string(), "readme".to_string(), ".md")
        );
        assert_eq!(
            split_rel_note_path("guide.markdown"),
            (String::new(), "guide".to_string(), ".markdown")
        );
        assert_eq!(
            split_rel_note_path("root.mntl.enc"),
            (String::new(), "root".to_string(), ".mntl.enc")
        );
        // A stem that itself ends in ".mntl" must survive a round trip.
        assert_eq!(
            split_rel_note_path("notes.mntl.mntl.enc"),
            (String::new(), "notes.mntl".to_string(), ".mntl.enc")
        );
    }

    #[test]
    fn note_display_name_strips_the_whole_compound_extension() {
        // `Path::file_stem` would return "secret.mntl" here.
        assert_eq!(note_display_name("Work/secret.mntl.enc"), "secret");
        assert_eq!(note_display_name("Work/todo.mntl"), "todo");
    }

    #[test]
    fn unique_sibling_note_path_preserves_enc_extension() {
        let root = temp_dir("unique-sibling-enc");
        fs::write(root.join("secret.mntl.enc"), b"MENC").unwrap();

        let (abs, rel) = unique_sibling_note_path(&root, "", "secret", ".mntl.enc", true);
        assert_eq!(rel, "secret copy.mntl.enc");
        assert!(abs.ends_with("secret copy.mntl.enc"));

        // And a non-colliding plaintext name is returned untouched.
        let (_, plain) = unique_sibling_note_path(&root, "Work", "todo", ".mntl", false);
        assert_eq!(plain, "Work/todo.mntl");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_note_keeps_the_enc_extension() {
        let root = temp_dir("rename-enc");
        fs::write(root.join("secret.mntl.enc"), b"MENC placeholder").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let renamed = rename_note(
            root_str,
            "secret.mntl.enc".to_string(),
            "diary".to_string(),
        )
        .unwrap();

        assert_eq!(renamed.rel_path, "diary.mntl.enc");
        assert_eq!(renamed.name, "diary");
        assert!(root.join("diary.mntl.enc").is_file());
        assert!(!root.join("diary.mntl").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn duplicate_note_of_encrypted_produces_an_enc_copy() {
        let root = temp_dir("duplicate-enc");
        fs::write(root.join("secret.mntl.enc"), b"MENC placeholder").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let copy = duplicate_note(root_str, "secret.mntl.enc".to_string()).unwrap();

        assert_eq!(copy.rel_path, "secret copy.mntl.enc");
        assert_eq!(copy.name, "secret copy");
        assert!(root.join("secret copy.mntl.enc").is_file());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_note_of_encrypted_keeps_the_enc_extension() {
        let root = temp_dir("move-enc");
        fs::create_dir_all(root.join("Work")).unwrap();
        fs::write(root.join("secret.mntl.enc"), b"MENC placeholder").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let moved = move_note(
            root_str,
            "secret.mntl.enc".to_string(),
            "Work".to_string(),
        )
        .unwrap();

        assert_eq!(moved.rel_path, "Work/secret.mntl.enc");
        assert_eq!(moved.name, "secret");
        assert!(root.join("Work").join("secret.mntl.enc").is_file());

        let _ = fs::remove_dir_all(&root);
    }

    // --- Scanning encrypted notes ----------------------------------------

    /// Seal a real `.mntl.enc` file so scan tests exercise the actual format
    /// rather than a hand-rolled approximation of it.
    fn write_encrypted(path: &Path, profile_id: &str, body: &str) -> mntl_core::MasterKey {
        let mk = mntl_core::generate_master_key().unwrap();
        let document = mntl_core::encode_unencrypted_note(body).unwrap();
        let blob = mntl_core::encrypt_note(&mk, profile_id, document.as_bytes()).unwrap();
        fs::write(path, blob).unwrap();
        mk
    }

    fn find_note<'a>(nodes: &'a [VaultNode], name: &str) -> &'a VaultNode {
        nodes
            .iter()
            .find(|n| node_name(n) == name)
            .unwrap_or_else(|| panic!("no node named {name}"))
    }

    #[test]
    fn scan_vault_reports_the_profile_of_encrypted_notes() {
        let root = temp_dir("scan-profile");
        write_encrypted(&root.join("secret.mntl.enc"), "my-diary", "# Private");
        fs::write(root.join("todo.mntl"), "---\nv: 2\n---\n# Public").unwrap();

        let tree = scan_vault(root.to_string_lossy().into_owned()).unwrap();
        let VaultNode::Folder { children, .. } = &tree else {
            panic!("root should be a folder");
        };

        match find_note(children, "secret") {
            VaultNode::Note {
                encrypted, profile, ..
            } => {
                assert!(encrypted);
                assert_eq!(profile.as_deref(), Some("my-diary"));
            }
            other => panic!("expected a note, got {other:?}"),
        }

        match find_note(children, "todo") {
            VaultNode::Note {
                encrypted, profile, ..
            } => {
                assert!(!encrypted);
                assert_eq!(profile.as_deref(), None);
            }
            other => panic!("expected a note, got {other:?}"),
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_vault_tolerates_a_corrupt_encrypted_header() {
        // One unreadable file must not make the whole vault fail to open.
        let root = temp_dir("scan-corrupt");
        fs::write(root.join("broken.mntl.enc"), b"MENC\xff\xff\xff\xffgarbage").unwrap();
        fs::write(root.join("truncated.mntl.enc"), b"MEN").unwrap();
        fs::write(root.join("todo.mntl"), "---\nv: 2\n---\n# Public").unwrap();

        let tree = scan_vault(root.to_string_lossy().into_owned()).unwrap();
        let VaultNode::Folder { children, .. } = &tree else {
            panic!("root should be a folder");
        };
        assert_eq!(children.len(), 3);

        for name in ["broken", "truncated"] {
            match find_note(children, name) {
                VaultNode::Note {
                    encrypted, profile, ..
                } => {
                    assert!(encrypted, "{name} should still be listed as encrypted");
                    assert_eq!(profile.as_deref(), None, "{name} should have no profile");
                }
                other => panic!("expected a note, got {other:?}"),
            }
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_header_prefix_rejects_an_absurd_header_length() {
        // Guards the allocation bound: the length prefix comes off disk and is
        // not to be trusted.
        let root = temp_dir("header-bound");
        let path = root.join("huge.mntl.enc");
        fs::write(&path, b"MENC\xff\xff\xff\xffgarbage").unwrap();

        assert!(read_header_prefix(&path).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_atomic_replaces_content_and_leaves_no_temp_file() {
        let root = temp_dir("write-atomic");
        let path = root.join("note.mntl.enc");
        fs::write(&path, b"old contents").unwrap();

        write_atomic(&path, b"new contents").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new contents");
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left temp files: {leftovers:?}");

        let _ = fs::remove_dir_all(&root);
    }
}
