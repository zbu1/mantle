//! Converting notes between the plaintext `.mntl` and encrypted `.mntl.enc`
//! formats, converting plain Markdown (`.md`) files into either, and moving an
//! encrypted note between credential profiles.
//!
//! These are the only commands that destroy a file the user still wants, so
//! each one writes and *verifies* the replacement before removing the
//! original. See [`encrypt_note_to_profile`] for the ordering.
//!
//! As in [`crate::credentials`], every error here reaches the on-disk log via
//! [`crate::logging::logged`] — never interpolate a password, key, or
//! decrypted note content into one.

use crate::attachments::{reseal_attachments, unreferenced, Relink};
use crate::credentials::SessionKeys;
use crate::hidden;
use crate::logging::logged;
use crate::vault::{
    is_markdown_note, join_rel_note_path, master_key_for, note_display_name, resolve_rel_path,
    split_rel_note_path, write_atomic, CreatedNote, EXT_ENCRYPTED, EXT_PLAIN,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tauri::State;
use zeroize::Zeroizing;

/// Overwrite a file's bytes with zeros, then unlink it.
///
/// Used for the plaintext original after encrypting a note, instead of
/// `trash::delete` — sending the very thing the user just asked us to encrypt
/// to the recycle bin would quietly undo the point of encrypting it.
///
/// **This is best-effort hygiene, not a guarantee of erasure.** On SSDs with
/// wear levelling, and on copy-on-write or journaling filesystems (APFS,
/// Btrfs, NTFS with USN/VSS, ReFS), the overwrite may land in a fresh block
/// and leave the original plaintext recoverable. Volume shadow copies, search
/// indexes, editor swap files, and File History or Time Machine backups may
/// also retain copies. What it does reliably remove is the trivially
/// recoverable copy.
fn shred(path: &Path) -> Result<(), String> {
    let len = fs::metadata(path)
        .map_err(|e| format!("Failed to inspect the original note: {e}"))?
        .len();

    if len > 0 {
        let mut file = OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|e| format!("Failed to overwrite the original note: {e}"))?;

        const CHUNK: usize = 8192;
        let zeros = [0u8; CHUNK];
        let mut remaining = len as usize;
        while remaining > 0 {
            let n = remaining.min(CHUNK);
            file.write_all(&zeros[..n])
                .map_err(|e| format!("Failed to overwrite the original note: {e}"))?;
            remaining -= n;
        }
        file.sync_all()
            .map_err(|e| format!("Failed to flush the original note: {e}"))?;
    }

    fs::remove_file(path).map_err(|e| format!("Failed to remove the original note: {e}"))
}

/// Read a plaintext source note as a `.mntl` document, ready to encrypt or to
/// write out as a `.mntl` file.
///
/// A `.md` file is re-encoded as one: its body is kept, and its own YAML
/// frontmatter becomes the note's tags and properties. Frontmatter that can't
/// be read is refused rather than dropped, since the original goes.
fn read_plaintext_document(source: &Path, rel_path: &str) -> Result<Zeroizing<String>, String> {
    let raw = Zeroizing::new(
        fs::read_to_string(source).map_err(|e| format!("Failed to read note: {e}"))?,
    );
    if is_markdown_note(rel_path) {
        let (_, body) = mntl_core::split_markdown_frontmatter(&raw);
        let properties = mntl_core::markdown_properties(&raw).ok_or(
            "Its frontmatter isn't valid YAML, so it would be lost. Fix it in another editor first.",
        )?;
        let frontmatter = mntl_core::NoteFrontmatter {
            tags: mntl_core::markdown_tags(&raw),
            properties: properties.into_iter().map(|(key, value)| (key.into(), value)).collect(),
            ..Default::default()
        };
        return mntl_core::encode_note(&frontmatter, body)
            .map(Zeroizing::new)
            .map_err(|e| e.to_string());
    }
    mntl_core::extract_unencrypted_header(&raw)
        .map_err(|e| format!("Not a valid note, refusing to encrypt it: {e}"))?;
    Ok(raw)
}

/// [`reseal_attachments`] for a whole `.mntl` document, re-encoding it only if
/// a link changed. Returns it with the files copied from.
fn reseal_document(
    vault_root: &str,
    rel_path: &str,
    document: &str,
    target: Option<(&str, &mntl_core::MasterKey)>,
    keys: &SessionKeys,
    mode: Relink,
) -> Result<(Zeroizing<String>, BTreeSet<String>), String> {
    let (frontmatter, body) =
        mntl_core::decode_note(document).map_err(|e| format!("Not a valid note: {e}"))?;
    let body = Zeroizing::new(body);
    let (body, relinked, originals) = reseal_attachments(vault_root, rel_path, &body, target, keys, mode)?;
    if relinked.is_empty() {
        return Ok((Zeroizing::new(document.to_string()), originals));
    }
    let encoded = mntl_core::encode_note(&frontmatter, &body).map_err(|e| e.to_string())?;
    Ok((Zeroizing::new(encoded), originals))
}

/// Encrypt an existing plaintext note — a `.mntl`, or a plain Markdown file —
/// into its credential profile.
///
/// The order matters, because this deletes the user's plaintext:
///
/// 1. Validate the source really is a `.mntl` document (or re-encode a
///    Markdown file as one).
/// 2. Write the ciphertext atomically and fsync it — hidden, if the profile
///    hides (see [`hidden::seal_at`]).
/// 3. **Read it back and decrypt it**, checking it matches. One extra read,
///    and the difference between "we deleted your note and hope the ciphertext
///    is good" and "we proved it before deleting anything".
/// 4. Only then shred the original.
#[tauri::command]
pub fn encrypt_note_to_profile(
    vault_root: String,
    rel_path: String,
    profile_id: String,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("encrypt_note_to_profile", || {
        encrypt_note_inner(&vault_root, &rel_path, &profile_id, &keys)
    })
}

fn encrypt_note_inner(
    vault_root: &str,
    rel_path: &str,
    profile_id: &str,
    keys: &SessionKeys,
) -> Result<CreatedNote, String> {
    {
        let plaintext = rel_path.ends_with(EXT_PLAIN) || is_markdown_note(rel_path);
        if !plaintext || rel_path.ends_with(EXT_ENCRYPTED) {
            return Err("Only a plaintext note can be encrypted".to_string());
        }

        let mk = keys
            .get(vault_root, profile_id)?
            .ok_or_else(|| format!("Unlock \"{profile_id}\" before encrypting notes into it"))?;

        let source = resolve_rel_path(vault_root, rel_path)?;
        let (dir_rel, stem, _) = split_rel_note_path(rel_path);
        let dest_rel = join_rel_note_path(&dir_rel, &stem, EXT_ENCRYPTED);

        if hidden::taken(vault_root, &dest_rel, keys)? {
            return Err(format!(
                "\"{stem}\" already exists as an encrypted note in this folder"
            ));
        }

        let document = read_plaintext_document(&source, rel_path)?;
        // Its attachments get sealed copies too — for a Markdown file, every
        // file it links — and the plaintext originals stay, as other notes
        // may use them.
        let mode = if is_markdown_note(rel_path) { Relink::Import } else { Relink::Convert };
        let (document, _) = reseal_document(vault_root, rel_path, &document, Some((profile_id, &mk)), keys, mode)?;

        // `seal_at` proves the new file is readable before we destroy the only readable copy.
        hidden::seal_at(vault_root, keys, profile_id, &mk, &dest_rel, &document, None)
            .map_err(|e| format!("{e}; the original is untouched"))?;

        shred(&source)?;

        Ok(CreatedNote {
            name: stem,
            rel_path: dest_rel,
        })
    }
}

/// A Markdown file to convert, and the name (file stem) its note gets.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub rel_path: String,
    pub name: String,
}

/// One Markdown file that became a note.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conversion {
    pub from: String,
    pub name: String,
    pub rel_path: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvertFailure {
    pub rel_path: String,
    pub error: String,
}

/// What [`convert_markdown_notes`] did.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConvertReport {
    pub converted: Vec<Conversion>,
    pub failed: Vec<ConvertFailure>,
    /// The files the notes linked that were copied into `attachments/` and,
    /// as no other note uses them, moved to the OS trash.
    pub removed: Vec<String>,
}

/// Convert plain Markdown files into `.mntl` notes beside them, each named as
/// asked. A file's frontmatter becomes the note's tags and properties, and
/// every local file it links or embeds is copied into `attachments/`; with
/// `remove_originals`, those originals then go to the OS trash, unless
/// another note still uses one.
///
/// Like encrypting, each replacement is written and read back before its
/// original goes. The original is sent to the OS trash rather than shredded:
/// nothing here is secret, and the trash keeps the untouched `.md`
/// recoverable. A file that fails is reported and the rest carry on.
#[tauri::command]
pub fn convert_markdown_notes(
    vault_root: String,
    notes: Vec<ConvertRequest>,
    remove_originals: bool,
    keys: State<SessionKeys>,
) -> Result<ConvertReport, String> {
    logged("convert_markdown_notes", || {
        convert_markdown_batch(&vault_root, &notes, remove_originals, discard, &keys)
    })
}

/// [`convert_markdown_notes`], with `remove` taking each original away: to
/// the OS trash ([`discard`]), or for a copy made just to import, unlinked.
pub(crate) fn convert_markdown_batch(
    vault_root: &str,
    notes: &[ConvertRequest],
    remove_originals: bool,
    remove: fn(&Path) -> Result<(), String>,
    keys: &SessionKeys,
) -> Result<ConvertReport, String> {
    let mut report = ConvertReport::default();
    let mut originals = BTreeSet::new();
    for note in notes {
        match convert_markdown_inner(vault_root, &note.rel_path, &note.name, remove, keys) {
            Ok((created, copied)) => {
                originals.extend(copied);
                report.converted.push(Conversion {
                    from: note.rel_path.clone(),
                    name: created.name,
                    rel_path: created.rel_path,
                });
            }
            Err(error) => report.failed.push(ConvertFailure { rel_path: note.rel_path.clone(), error }),
        }
    }
    if remove_originals && !originals.is_empty() {
        for rel in unreferenced(vault_root, originals, &[], keys)? {
            if remove(&resolve_rel_path(vault_root, &rel)?).is_ok() {
                report.removed.push(rel);
            }
        }
    }
    Ok(report)
}

/// Send a file to the OS trash. Tests unlink it instead, rather than filling
/// the developer's recycle bin.
pub(crate) fn discard(path: &Path) -> Result<(), String> {
    #[cfg(not(test))]
    let result = trash::delete(path).map_err(|e| e.to_string());
    #[cfg(test)]
    let result = fs::remove_file(path).map_err(|e| e.to_string());
    result.map_err(|e| format!("Failed to move the original to the trash: {e}"))
}

/// Convert one Markdown file into the note `name`, returning it and the files
/// it linked that were copied into `attachments/`.
fn convert_markdown_inner(
    vault_root: &str,
    rel_path: &str,
    name: &str,
    remove: fn(&Path) -> Result<(), String>,
    keys: &SessionKeys,
) -> Result<(CreatedNote, BTreeSet<String>), String> {
    if !is_markdown_note(rel_path) {
        return Err("Only a Markdown file can be converted to a note".to_string());
    }
    if name.is_empty() || name.contains(['/', '\\', ':']) {
        return Err("Invalid note name".to_string());
    }

    let source = resolve_rel_path(vault_root, rel_path)?;
    let (dir_rel, _, _) = split_rel_note_path(rel_path);
    let dest_rel = join_rel_note_path(&dir_rel, name, EXT_PLAIN);
    let dest = resolve_rel_path(vault_root, &dest_rel)?;

    // A hidden note may be known by that path too.
    if hidden::taken(vault_root, &dest_rel, keys)? {
        return Err(format!("\"{name}\" already exists as a note in this folder"));
    }

    let document = read_plaintext_document(&source, rel_path)?;
    let (document, copied) = reseal_document(vault_root, rel_path, &document, None, keys, Relink::Import)?;
    write_atomic(&dest, document.as_bytes())?;

    let written =
        fs::read_to_string(&dest).map_err(|e| format!("Failed to verify converted note: {e}"))?;
    if written != *document {
        let _ = fs::remove_file(&dest);
        return Err("Converted note failed verification; the original is untouched".to_string());
    }

    remove(&source)?;

    Ok((CreatedNote { name: name.to_string(), rel_path: dest_rel }, copied))
}

/// Decrypt an encrypted note back to a plaintext `.mntl` file.
///
/// The leftover ciphertext reveals nothing without the key, so it is simply
/// removed — no shredding needed.
///
/// A hidden note goes back to its real path, or under `name` (a file stem)
/// in its folder when that's taken.
#[tauri::command]
pub fn decrypt_note_to_plaintext(
    vault_root: String,
    rel_path: String,
    name: Option<String>,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("decrypt_note_to_plaintext", || {
        decrypt_note_inner(&vault_root, &rel_path, name.as_deref(), &keys)
    })
}

fn decrypt_note_inner(
    vault_root: &str,
    rel_path: &str,
    name: Option<&str>,
    keys: &SessionKeys,
) -> Result<CreatedNote, String> {
    {
        if !rel_path.ends_with(EXT_ENCRYPTED) {
            return Err("This note is not encrypted".to_string());
        }
        if name.is_some_and(|n| n.is_empty() || n.contains(['/', '\\', ':'])) {
            return Err("Invalid note name".to_string());
        }

        let source = hidden::resolve_note(vault_root, rel_path, keys)?;
        let (dir_rel, stem, _) = split_rel_note_path(rel_path);
        let stem = name.map_or(stem, str::to_string);
        let dest_rel = join_rel_note_path(&dir_rel, &stem, EXT_PLAIN);
        // A hidden note's folder may only be virtual.
        hidden::ensure_rel_dir(vault_root, &dir_rel, keys)?;
        let dest = resolve_rel_path(vault_root, &dest_rel)?;

        if dest.exists() {
            return Err(format!(
                "\"{stem}\" already exists as a plaintext note in this folder"
            ));
        }

        let blob = fs::read(&source).map_err(|e| format!("Failed to read note: {e}"))?;
        let (_, mk) = master_key_for(vault_root, &blob, keys)?;
        let document = mntl_core::decrypt_note(&mk, &blob).map_err(|e| e.to_string())?;
        let document =
            std::str::from_utf8(&document).map_err(|_| "Decrypted note is not UTF-8".to_string())?;
        let (mut frontmatter, body) = mntl_core::decode_note(document)
            .map_err(|e| format!("Decrypted content is not a valid note: {e}"))?;
        let body = Zeroizing::new(body);
        // A plaintext note's favorite lives in `.mantle/state.json`, where the
        // frontend moves it; a stale sealed flag would come back on re-encrypting.
        frontmatter.favorite = false;
        frontmatter.location = None;
        frontmatter.name = None;
        let (body, _, _) = reseal_attachments(vault_root, rel_path, &body, None, keys, Relink::Convert)?;
        let document = Zeroizing::new(mntl_core::encode_note(&frontmatter, &body).map_err(|e| e.to_string())?);

        write_atomic(&dest, document.as_bytes())?;
        fs::remove_file(&source).map_err(|e| format!("Failed to remove the encrypted note: {e}"))?;
        keys.put_hidden(vault_root, rel_path, None)?;

        Ok(CreatedNote {
            name: stem,
            rel_path: dest_rel,
        })
    }
}

/// Re-home an encrypted note to a different credential profile.
///
/// Requires **both** profiles unlocked: the source's to read the note, the
/// destination's to seal it again. The note keeps its path, so no tree or tab
/// churn follows — though its file moves if one profile hides and the other
/// doesn't, and un-hiding it onto a taken path needs another `name`.
///
/// This fully re-encrypts rather than rewrapping the existing content key
/// under the new master key. It has to: the profile id lives in the header,
/// the header is the AEAD's associated data, so changing it necessarily
/// invalidates the existing ciphertext.
#[tauri::command]
pub fn move_note_to_profile(
    vault_root: String,
    rel_path: String,
    profile_id: String,
    name: Option<String>,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("move_note_to_profile", || {
        move_note_inner(&vault_root, &rel_path, &profile_id, name.as_deref(), &keys)
    })
}

fn move_note_inner(
    vault_root: &str,
    rel_path: &str,
    profile_id: &str,
    name: Option<&str>,
    keys: &SessionKeys,
) -> Result<CreatedNote, String> {
    {
        if !rel_path.ends_with(EXT_ENCRYPTED) {
            return Err("Only an encrypted note can be moved between profiles".to_string());
        }

        let destination_key = keys
            .get(vault_root, profile_id)?
            .ok_or_else(|| format!("Unlock \"{profile_id}\" before moving notes into it"))?;

        let disk = hidden::disk_rel(vault_root, rel_path, keys)?;
        let path = resolve_rel_path(vault_root, &disk)?;
        let blob = fs::read(&path).map_err(|e| format!("Failed to read note: {e}"))?;
        let (current_profile, source_key) = master_key_for(vault_root, &blob, keys)?;

        if current_profile == profile_id {
            return Ok(CreatedNote { name: note_display_name(rel_path), rel_path: rel_path.to_string() });
        }
        let target = match name {
            Some(name) if name.is_empty() || name.contains(['/', '\\', ':']) => return Err("Invalid note name".to_string()),
            Some(name) => join_rel_note_path(&split_rel_note_path(rel_path).0, name, EXT_ENCRYPTED),
            None => rel_path.to_string(),
        };

        let document = mntl_core::decrypt_note(&source_key, &blob).map_err(|e| e.to_string())?;
        let document =
            std::str::from_utf8(&document).map_err(|_| "Decrypted note is not UTF-8".to_string())?;
        let (document, _) = reseal_document(
            vault_root,
            rel_path,
            document,
            Some((profile_id, &destination_key)),
            keys,
            Relink::Convert,
        )?;
        hidden::seal_at(vault_root, keys, profile_id, &destination_key, &target, &document, Some((rel_path, &disk)))?;
        Ok(CreatedNote { name: note_display_name(&target), rel_path: target })
    }
}

/// Create a new, empty note directly inside a credential profile, so its
/// contents never touch the disk in plaintext.
#[tauri::command]
pub fn create_encrypted_note(
    vault_root: String,
    rel_dir: String,
    name: String,
    profile_id: String,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("create_encrypted_note", || {
        create_encrypted_note_inner(&vault_root, &rel_dir, &name, &profile_id, &keys)
    })
}

fn create_encrypted_note_inner(
    vault_root: &str,
    rel_dir: &str,
    name: &str,
    profile_id: &str,
    keys: &SessionKeys,
) -> Result<CreatedNote, String> {
    {
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains(':') {
            return Err("Invalid note name".to_string());
        }

        let mk = keys
            .get(vault_root, profile_id)?
            .ok_or_else(|| format!("Unlock \"{profile_id}\" before creating notes in it"))?;

        // Checking the directory first surfaces a bad `rel_dir` before we
        // build a path from it. It may be a virtual folder.
        if !rel_dir.is_empty() && !hidden::folder_exists(vault_root, keys, rel_dir)? {
            return Err("Destination folder does not exist".to_string());
        }
        let rel_path = join_rel_note_path(rel_dir, name, EXT_ENCRYPTED);
        hidden::check_components(&rel_path)?;

        if hidden::taken(vault_root, &rel_path, keys)? {
            return Err(format!(
                "A note named \"{name}\" already exists in this folder"
            ));
        }

        let document = mntl_core::encode_unencrypted_note("").map_err(|e| e.to_string())?;
        hidden::seal_at(vault_root, keys, profile_id, &mk, &rel_path, &document, None)?;

        Ok(CreatedNote {
            name: note_display_name(&rel_path),
            rel_path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{read_note_inner, write_note_inner, LOCKED_ERR_PREFIX};
    use std::path::PathBuf;

    const BODY: &str = "# Private\n\nBody text.";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("mntl-notes-crypto-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A `SessionKeys` with `profile_id` unlocked, skipping Argon2id — these
    /// tests are about the file choreography, not key derivation.
    fn unlocked(vault_root: &str, profile_ids: &[&str]) -> SessionKeys {
        let keys = SessionKeys::default();
        for id in profile_ids {
            keys.unlock_for_test(vault_root, id, mntl_core::MasterKey::generate().unwrap())
                .unwrap();
        }
        keys
    }

    fn write_plain(path: &Path, body: &str) {
        fs::write(path, mntl_core::encode_unencrypted_note(body).unwrap()).unwrap();
    }

    #[test]
    fn encrypt_then_decrypt_round_trips_content() {
        let root = temp_dir("roundtrip");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        write_plain(&root.join("secret.mntl"), BODY);

        let encrypted =
            encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();
        assert_eq!(encrypted.rel_path, "secret.mntl.enc");
        assert_eq!(encrypted.name, "secret");

        // Readable through the normal note-reading path while unlocked.
        assert_eq!(
            read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap().content,
            BODY
        );

        let decrypted =
            decrypt_note_inner(&root_str, "secret.mntl.enc", None, &keys).unwrap();
        assert_eq!(decrypted.rel_path, "secret.mntl");
        assert_eq!(
            read_note_inner(&root_str, "secret.mntl", &keys).unwrap().content,
            BODY
        );
        assert!(!root.join("secret.mntl.enc").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn decrypting_a_favorite_clears_its_sealed_flag() {
        let root = temp_dir("decrypt-favorite");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        write_plain(&root.join("secret.mntl"), BODY);
        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();
        crate::vault::set_note_favorite_inner(&root_str, "secret.mntl.enc", true, &keys).unwrap();

        decrypt_note_inner(&root_str, "secret.mntl.enc", None, &keys).unwrap();
        let plaintext = fs::read_to_string(root.join("secret.mntl")).unwrap();
        let (frontmatter, body) = mntl_core::decode_note(&plaintext).unwrap();
        assert!(!frontmatter.favorite);
        assert_eq!(body, BODY);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn encrypting_a_markdown_file_keeps_its_frontmatter_and_removes_it() {
        let root = temp_dir("encrypt-markdown");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        fs::write(root.join("secret.md"), format!("---\ntags: [x]\ndue: 2026-10-17\n---\n{BODY}")).unwrap();

        let encrypted = encrypt_note_inner(&root_str, "secret.md", "my-diary", &keys).unwrap();
        assert_eq!(encrypted.rel_path, "secret.mntl.enc");
        assert!(!root.join("secret.md").exists());
        let doc = read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap();
        assert_eq!((doc.content.as_str(), doc.tags), (BODY, vec!["x".to_string()]));
        assert_eq!(doc.properties.unwrap()[0].key, "due");
    }

    fn convert(root: &str, rel_path: &str, name: &str) -> Result<CreatedNote, String> {
        convert_markdown_inner(root, rel_path, name, discard, &SessionKeys::default()).map(|(created, _)| created)
    }

    #[test]
    fn converting_markdown_moves_its_frontmatter_into_the_note() {
        let root = temp_dir("convert-markdown");
        let root_str = root.to_string_lossy().into_owned();
        fs::write(root.join("readme.markdown"), format!("---\ntitle: Readme\ntags: [x]\n---\n{BODY}")).unwrap();

        let converted = convert(&root_str, "readme.markdown", "readme").unwrap();
        assert_eq!(converted.rel_path, "readme.mntl");
        assert_eq!(converted.name, "readme");
        assert!(!root.join("readme.markdown").exists());
        assert_eq!(
            fs::read_to_string(root.join("readme.mntl")).unwrap(),
            format!("---\nv: 2\ntags:\n- x\nproperties:\n  title: Readme\n---\n{BODY}")
        );
    }

    #[test]
    fn converting_markdown_refuses_collisions_bad_frontmatter_and_non_markdown_files() {
        let root = temp_dir("convert-markdown-collision");
        let root_str = root.to_string_lossy().into_owned();
        fs::write(root.join("readme.md"), BODY).unwrap();
        write_plain(&root.join("readme.mntl"), "existing");

        assert!(convert(&root_str, "readme.md", "readme").is_err());
        assert!(root.join("readme.md").is_file());
        assert!(convert(&root_str, "readme.mntl", "readme").is_err());
        assert!(convert(&root_str, "readme.md", "a/b").is_err());
        assert_eq!(convert(&root_str, "readme.md", "readme 2").unwrap().rel_path, "readme 2.mntl");

        fs::write(root.join("broken.md"), "---\n: not [valid\n---\nBody").unwrap();
        assert!(convert(&root_str, "broken.md", "broken").unwrap_err().contains("frontmatter"));
        assert!(root.join("broken.md").is_file());
    }

    #[test]
    fn converting_markdown_copies_its_files_in_and_can_remove_the_originals() {
        let root = temp_dir("convert-attachments");
        let root_str = root.to_string_lossy().into_owned();
        fs::create_dir_all(root.join("files")).unwrap();
        fs::write(root.join("files/spec.zip"), b"zip").unwrap();
        fs::write(root.join("files/shared.pdf"), b"pdf").unwrap();
        fs::write(root.join("files/cat.png"), b"meow").unwrap();
        fs::write(
            root.join("a.md"),
            "![[cat.png|300]] [spec](files/spec.zip) [[shared.pdf]] [web](https://x/y.pdf) [gone](nope.pdf) [[Other]]\n```\n[code](files/spec.zip)\n```\n",
        )
        .unwrap();
        fs::write(root.join("b.md"), "[keep](files/shared.pdf)").unwrap();

        let notes = vec![ConvertRequest { rel_path: "a.md".into(), name: "a".into() }];
        let report = convert_markdown_batch(&root_str, &notes, true, discard, &SessionKeys::default()).unwrap();
        assert_eq!(report.converted[0].rel_path, "a.mntl");
        assert!(report.failed.is_empty());
        assert_eq!(report.removed, ["files/cat.png", "files/spec.zip"], "b.md still uses shared.pdf");
        assert!(root.join("files/shared.pdf").is_file());

        let content = read_note_inner(&root_str, "a.mntl", &SessionKeys::default()).unwrap().content;
        let targets: Vec<&str> =
            crate::attachments::link_sources(&content).into_iter().map(|s| &content[s.range]).collect();
        assert_eq!(targets.len(), 6, "{content}");
        assert!(targets[..3].iter().all(|t| t.starts_with("attachments/")), "{content}");
        assert!(targets[0].ends_with(".png") && targets[1].ends_with(".zip"));
        assert_eq!(&targets[3..], ["https://x/y.pdf", "nope.pdf", "Other"]);
        assert!(content.contains("|300]]") && content.contains("[code](files/spec.zip)"), "code is untouched");
        assert_eq!(fs::read(root.join(targets[1])).unwrap(), b"zip");
    }

    #[test]
    fn encrypt_removes_the_plaintext_file_and_writes_a_real_envelope() {
        let root = temp_dir("encrypt-removes");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        write_plain(&root.join("secret.mntl"), BODY);

        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();

        assert!(!root.join("secret.mntl").exists(), "plaintext must be gone");
        let blob = fs::read(root.join("secret.mntl.enc")).unwrap();
        assert_eq!(&blob[0..4], mntl_core::MAGIC_MENC);

        // And the ciphertext really doesn't contain the plaintext.
        assert!(!blob.windows(BODY.len()).any(|w| w == BODY.as_bytes()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn encrypt_refuses_when_the_destination_exists() {
        // Never clobber: the existing `.mntl.enc` might be a different note
        // entirely, and overwriting it would be unrecoverable.
        let root = temp_dir("encrypt-collision");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        write_plain(&root.join("secret.mntl"), BODY);
        fs::write(root.join("secret.mntl.enc"), b"existing").unwrap();

        let err = encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");

        assert!(root.join("secret.mntl").exists(), "original must survive");
        assert_eq!(fs::read(root.join("secret.mntl.enc")).unwrap(), b"existing");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn encrypt_refuses_when_the_profile_is_locked() {
        let root = temp_dir("encrypt-locked");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        write_plain(&root.join("secret.mntl"), BODY);

        let err = encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap_err();
        assert!(err.contains("Unlock"), "got: {err}");
        assert!(root.join("secret.mntl").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn encrypt_refuses_a_file_that_is_not_a_valid_note() {
        let root = temp_dir("encrypt-invalid");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        fs::write(root.join("junk.mntl"), "no frontmatter here").unwrap();

        let err = encrypt_note_inner(&root_str, "junk.mntl", "my-diary", &keys).unwrap_err();
        assert!(err.contains("refusing to encrypt"), "got: {err}");
        assert!(root.join("junk.mntl").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reading_a_locked_note_returns_the_locked_sentinel() {
        let root = temp_dir("read-locked");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        write_plain(&root.join("secret.mntl"), BODY);
        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();

        keys.lock_one(&root_str, "my-diary").unwrap();

        let err = read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap_err();
        assert_eq!(err, format!("{LOCKED_ERR_PREFIX}my-diary"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn writing_an_encrypted_note_reseals_it_under_the_same_profile() {
        let root = temp_dir("write-reseal");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        write_plain(&root.join("secret.mntl"), BODY);
        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();

        let before = fs::read(root.join("secret.mntl.enc")).unwrap();
        let before_header = mntl_core::extract_encrypted_header(&before).unwrap();

        write_note_inner(&root_str, "secret.mntl.enc", "# Edited", &[], None, &keys).unwrap();

        assert_eq!(
            read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap().content,
            "# Edited"
        );

        let after = fs::read(root.join("secret.mntl.enc")).unwrap();
        let after_header = mntl_core::extract_encrypted_header(&after).unwrap();

        assert_eq!(after_header.credential_profile, "my-diary");
        // A fresh content key and nonce on every write — nothing carried over.
        assert_ne!(before_header.crypto.iv, after_header.crypto.iv);
        assert_ne!(
            before_header.crypto.wrapped_key,
            after_header.crypto.wrapped_key
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn writing_a_locked_note_fails_without_destroying_it() {
        let root = temp_dir("write-locked");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        write_plain(&root.join("secret.mntl"), BODY);
        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();
        let before = fs::read(root.join("secret.mntl.enc")).unwrap();

        keys.lock_one(&root_str, "my-diary").unwrap();
        let err = write_note_inner(&root_str, "secret.mntl.enc", "# Edited", &[], None, &keys).unwrap_err();

        assert_eq!(err, format!("{LOCKED_ERR_PREFIX}my-diary"));
        assert_eq!(fs::read(root.join("secret.mntl.enc")).unwrap(), before);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_note_to_profile_changes_the_header_and_preserves_content() {
        let root = temp_dir("move-profile");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary", "work"]);
        write_plain(&root.join("secret.mntl"), BODY);
        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();

        move_note_inner(&root_str, "secret.mntl.enc", "work", None, &keys).unwrap();

        let blob = fs::read(root.join("secret.mntl.enc")).unwrap();
        let header = mntl_core::extract_encrypted_header(&blob).unwrap();
        assert_eq!(header.credential_profile, "work");
        assert_eq!(
            read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap().content,
            BODY
        );

        // The old profile's key must no longer open it.
        keys.lock_one(&root_str, "work").unwrap();
        assert!(read_note_inner(&root_str, "secret.mntl.enc", &keys).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_note_to_profile_requires_both_profiles_unlocked() {
        let root = temp_dir("move-locked");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary", "work"]);
        write_plain(&root.join("secret.mntl"), BODY);
        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();

        // Source locked, destination unlocked.
        keys.lock_one(&root_str, "my-diary").unwrap();
        let err = move_note_inner(&root_str, "secret.mntl.enc", "work", None, &keys).unwrap_err();
        assert_eq!(err, format!("{LOCKED_ERR_PREFIX}my-diary"));

        // Destination locked.
        keys.lock_one(&root_str, "work").unwrap();
        let err = move_note_inner(&root_str, "secret.mntl.enc", "work", None, &keys).unwrap_err();
        assert!(err.contains("Unlock"), "got: {err}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_encrypted_note_never_writes_plaintext() {
        let root = temp_dir("create-encrypted");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        fs::create_dir_all(root.join("Work")).unwrap();

        let created =
            create_encrypted_note_inner(&root_str, "Work", "Journal", "my-diary", &keys).unwrap();

        assert_eq!(created.rel_path, "Work/Journal.mntl.enc");
        assert_eq!(created.name, "Journal");
        assert!(!root.join("Work").join("Journal.mntl").exists());
        assert_eq!(
            read_note_inner(&root_str, "Work/Journal.mntl.enc", &keys).unwrap().content,
            ""
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_encrypted_note_rejects_collisions_and_locked_profiles() {
        let root = temp_dir("create-encrypted-invalid");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);

        create_encrypted_note_inner(&root_str, "", "Journal", "my-diary", &keys).unwrap();
        assert!(create_encrypted_note_inner(&root_str, "", "Journal", "my-diary", &keys).is_err());
        assert!(create_encrypted_note_inner(&root_str, "", "a/b", "my-diary", &keys).is_err());

        keys.lock_all().unwrap();
        assert!(create_encrypted_note_inner(&root_str, "", "Other", "my-diary", &keys).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn images_follow_a_note_into_and_out_of_its_profiles() {
        let root = temp_dir("images");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary", "work"]);
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("attachments/cat.png"), b"meow").unwrap();
        write_plain(&root.join("secret.mntl"), "![cat](attachments/cat.png) ![[cat.png|200]] ![](https://x/y.png)");

        let src_of = |content: &str, nth: usize| {
            let sources = crate::attachments::link_sources(content);
            content[sources[nth].range.clone()].to_string()
        };

        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();
        let content = read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap().content;
        let sealed = src_of(&content, 0);
        assert!(sealed.starts_with("attachments/") && sealed.ends_with(".png.enc"), "{content}");
        assert_eq!(src_of(&content, 1), sealed, "one copy per image");
        assert_eq!(src_of(&content, 2), "https://x/y.png");
        assert!(content.contains("|200]]"));
        assert!(root.join("attachments/cat.png").is_file(), "the original stays");

        move_note_inner(&root_str, "secret.mntl.enc", "work", None, &keys).unwrap();
        let content = read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap().content;
        let moved = src_of(&content, 0);
        assert_ne!(moved, sealed);
        let header = mntl_core::extract_encrypted_header(&fs::read(root.join(&moved)).unwrap()).unwrap();
        assert_eq!(header.credential_profile, "work");

        decrypt_note_inner(&root_str, "secret.mntl.enc", None, &keys).unwrap();
        let content = read_note_inner(&root_str, "secret.mntl", &keys).unwrap().content;
        let plain = src_of(&content, 0);
        assert!(plain.ends_with(".png") && !plain.ends_with(".enc"), "{content}");
        assert_eq!(fs::read(root.join(&plain)).unwrap(), b"meow");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn shred_zeroes_and_removes_the_file() {
        let root = temp_dir("shred");
        let path = root.join("secret.mntl");
        fs::write(&path, "confidential").unwrap();

        shred(&path).unwrap();
        assert!(!path.exists());

        let _ = fs::remove_dir_all(&root);
    }
}
