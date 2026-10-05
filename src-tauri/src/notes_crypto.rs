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

use crate::attachments::reseal_images;
use crate::credentials::SessionKeys;
use crate::logging::logged;
use crate::vault::{
    is_markdown_note, join_rel_note_path, master_key_for, note_display_name, resolve_rel_dir,
    resolve_rel_path, split_rel_note_path, write_atomic, CreatedNote, EXT_ENCRYPTED, EXT_PLAIN,
};
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
/// A `.md` file is re-encoded as one: its body and tags are kept, and the
/// rest of its own YAML frontmatter dropped, since none of that means
/// anything to a `.mntl` note.
fn read_plaintext_document(source: &Path, rel_path: &str) -> Result<Zeroizing<String>, String> {
    let raw = Zeroizing::new(
        fs::read_to_string(source).map_err(|e| format!("Failed to read note: {e}"))?,
    );
    if is_markdown_note(rel_path) {
        let (_, body) = mntl_core::split_markdown_frontmatter(&raw);
        let frontmatter = mntl_core::NoteFrontmatter {
            tags: mntl_core::markdown_tags(&raw),
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

/// Encrypt an existing plaintext note — a `.mntl`, or a plain Markdown file —
/// into its credential profile.
///
/// The order matters, because this deletes the user's plaintext:
///
/// 1. Validate the source really is a `.mntl` document (or re-encode a
///    Markdown file as one).
/// 2. Write the ciphertext atomically and fsync it.
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
        let dest = resolve_rel_path(vault_root, &dest_rel)?;

        if dest.exists() {
            return Err(format!(
                "\"{stem}\" already exists as an encrypted note in this folder"
            ));
        }

        let document = read_plaintext_document(&source, rel_path)?;
        // Its images get sealed copies too; the plaintext originals stay, as
        // other notes may show them.
        let document = reseal_images(vault_root, rel_path, &document, Some((profile_id, &mk)), keys)?;

        let blob =
            mntl_core::encrypt_note(&mk, profile_id, document.as_bytes()).map_err(|e| e.to_string())?;
        write_atomic(&dest, &blob)?;

        // Prove the new file is readable before destroying the only readable copy.
        let written = fs::read(&dest).map_err(|e| format!("Failed to verify encrypted note: {e}"))?;
        let roundtrip = mntl_core::decrypt_note(&mk, &written)
            .map_err(|e| format!("Failed to verify encrypted note: {e}"))?;
        if roundtrip.as_slice() != document.as_bytes() {
            let _ = fs::remove_file(&dest);
            return Err("Encrypted note failed verification; the original is untouched".to_string());
        }

        shred(&source)?;

        Ok(CreatedNote {
            name: stem,
            rel_path: dest_rel,
        })
    }
}

/// Convert a plain Markdown file into a `.mntl` note beside it, dropping the
/// file's own YAML frontmatter.
///
/// Like encrypting, the replacement is written and read back before the
/// original goes. The original is sent to the OS trash rather than shredded:
/// nothing here is secret, and the trash keeps the untouched `.md` — with its
/// frontmatter — recoverable.
#[tauri::command]
pub fn convert_markdown_to_note(vault_root: String, rel_path: String) -> Result<CreatedNote, String> {
    logged("convert_markdown_to_note", || {
        convert_markdown_inner(&vault_root, &rel_path)
    })
}

/// Send a converted Markdown file to the OS trash. Tests unlink it instead,
/// rather than filling the developer's recycle bin.
fn discard_markdown_original(path: &Path) -> Result<(), String> {
    #[cfg(not(test))]
    let result = trash::delete(path).map_err(|e| e.to_string());
    #[cfg(test)]
    let result = fs::remove_file(path).map_err(|e| e.to_string());
    result.map_err(|e| format!("Failed to remove the original Markdown file: {e}"))
}

fn convert_markdown_inner(vault_root: &str, rel_path: &str) -> Result<CreatedNote, String> {
    if !is_markdown_note(rel_path) {
        return Err("Only a Markdown file can be converted to a note".to_string());
    }

    let source = resolve_rel_path(vault_root, rel_path)?;
    let (dir_rel, stem, _) = split_rel_note_path(rel_path);
    let dest_rel = join_rel_note_path(&dir_rel, &stem, EXT_PLAIN);
    let dest = resolve_rel_path(vault_root, &dest_rel)?;

    if dest.exists() {
        return Err(format!("\"{stem}\" already exists as a note in this folder"));
    }

    let document = read_plaintext_document(&source, rel_path)?;
    write_atomic(&dest, document.as_bytes())?;

    let written =
        fs::read_to_string(&dest).map_err(|e| format!("Failed to verify converted note: {e}"))?;
    if written != *document {
        let _ = fs::remove_file(&dest);
        return Err("Converted note failed verification; the original is untouched".to_string());
    }

    discard_markdown_original(&source)?;

    Ok(CreatedNote {
        name: stem,
        rel_path: dest_rel,
    })
}

/// Decrypt an encrypted note back to a plaintext `.mntl` file.
///
/// The leftover ciphertext reveals nothing without the key, so it is simply
/// removed — no shredding needed.
#[tauri::command]
pub fn decrypt_note_to_plaintext(
    vault_root: String,
    rel_path: String,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("decrypt_note_to_plaintext", || {
        decrypt_note_inner(&vault_root, &rel_path, &keys)
    })
}

fn decrypt_note_inner(
    vault_root: &str,
    rel_path: &str,
    keys: &SessionKeys,
) -> Result<CreatedNote, String> {
    {
        if !rel_path.ends_with(EXT_ENCRYPTED) {
            return Err("This note is not encrypted".to_string());
        }

        let source = resolve_rel_path(vault_root, rel_path)?;
        let (dir_rel, stem, _) = split_rel_note_path(rel_path);
        let dest_rel = join_rel_note_path(&dir_rel, &stem, EXT_PLAIN);
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
        let cleared;
        let document = if frontmatter.favorite {
            frontmatter.favorite = false;
            cleared = Zeroizing::new(mntl_core::encode_note(&frontmatter, &body).map_err(|e| e.to_string())?);
            cleared.as_str()
        } else {
            document
        };
        let document = reseal_images(vault_root, rel_path, document, None, keys)?;

        write_atomic(&dest, document.as_bytes())?;
        fs::remove_file(&source).map_err(|e| format!("Failed to remove the encrypted note: {e}"))?;

        Ok(CreatedNote {
            name: stem,
            rel_path: dest_rel,
        })
    }
}

/// Re-home an encrypted note to a different credential profile.
///
/// Requires **both** profiles unlocked: the source's to read the note, the
/// destination's to seal it again. The filename does not change, so no tree or
/// tab churn follows.
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
    keys: State<SessionKeys>,
) -> Result<(), String> {
    logged("move_note_to_profile", || {
        move_note_inner(&vault_root, &rel_path, &profile_id, &keys)
    })
}

fn move_note_inner(
    vault_root: &str,
    rel_path: &str,
    profile_id: &str,
    keys: &SessionKeys,
) -> Result<(), String> {
    {
        if !rel_path.ends_with(EXT_ENCRYPTED) {
            return Err("Only an encrypted note can be moved between profiles".to_string());
        }

        let destination_key = keys
            .get(vault_root, profile_id)?
            .ok_or_else(|| format!("Unlock \"{profile_id}\" before moving notes into it"))?;

        let path = resolve_rel_path(vault_root, rel_path)?;
        let blob = fs::read(&path).map_err(|e| format!("Failed to read note: {e}"))?;
        let (current_profile, source_key) = master_key_for(vault_root, &blob, keys)?;

        if current_profile == profile_id {
            return Ok(());
        }

        let document = mntl_core::decrypt_note(&source_key, &blob).map_err(|e| e.to_string())?;
        let document =
            std::str::from_utf8(&document).map_err(|_| "Decrypted note is not UTF-8".to_string())?;
        let document =
            reseal_images(vault_root, rel_path, document, Some((profile_id, &destination_key)), keys)?;
        let resealed = mntl_core::encrypt_note(&destination_key, profile_id, document.as_bytes())
            .map_err(|e| e.to_string())?;

        write_atomic(&path, &resealed)
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

        // Resolving the directory first surfaces a bad `rel_dir` before we
        // build a path from it.
        resolve_rel_dir(vault_root, rel_dir)?;
        let rel_path = join_rel_note_path(rel_dir, name, EXT_ENCRYPTED);
        let path = resolve_rel_path(vault_root, &rel_path)?;

        if path.exists() {
            return Err(format!(
                "A note named \"{name}\" already exists in this folder"
            ));
        }

        let document = mntl_core::encode_unencrypted_note("").map_err(|e| e.to_string())?;
        let blob =
            mntl_core::encrypt_note(&mk, profile_id, document.as_bytes()).map_err(|e| e.to_string())?;
        write_atomic(&path, &blob)?;

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
            decrypt_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap();
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

        decrypt_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap();
        let plaintext = fs::read_to_string(root.join("secret.mntl")).unwrap();
        let (frontmatter, body) = mntl_core::decode_note(&plaintext).unwrap();
        assert!(!frontmatter.favorite);
        assert_eq!(body, BODY);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn encrypting_a_markdown_file_drops_its_frontmatter_and_removes_it() {
        let root = temp_dir("encrypt-markdown");
        let root_str = root.to_string_lossy().into_owned();
        let keys = unlocked(&root_str, &["my-diary"]);
        fs::write(root.join("secret.md"), format!("---
tags: [x]
---
{BODY}")).unwrap();

        let encrypted = encrypt_note_inner(&root_str, "secret.md", "my-diary", &keys).unwrap();
        assert_eq!(encrypted.rel_path, "secret.mntl.enc");
        assert!(!root.join("secret.md").exists());
        assert_eq!(read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap().content, BODY);
    }

    #[test]
    fn converting_markdown_writes_a_mntl_note_keeping_only_its_tags() {
        let root = temp_dir("convert-markdown");
        let root_str = root.to_string_lossy().into_owned();
        fs::write(root.join("readme.markdown"), format!("---\ntitle: Readme\ntags: [x]\n---\n{BODY}")).unwrap();

        let converted = convert_markdown_inner(&root_str, "readme.markdown").unwrap();
        assert_eq!(converted.rel_path, "readme.mntl");
        assert_eq!(converted.name, "readme");
        assert!(!root.join("readme.markdown").exists());
        assert_eq!(
            fs::read_to_string(root.join("readme.mntl")).unwrap(),
            format!("---\nv: 2\ntags:\n- x\n---\n{BODY}")
        );
    }

    #[test]
    fn converting_markdown_refuses_collisions_and_non_markdown_files() {
        let root = temp_dir("convert-markdown-collision");
        let root_str = root.to_string_lossy().into_owned();
        fs::write(root.join("readme.md"), BODY).unwrap();
        write_plain(&root.join("readme.mntl"), "existing");

        assert!(convert_markdown_inner(&root_str, "readme.md").is_err());
        assert!(root.join("readme.md").is_file());
        assert!(convert_markdown_inner(&root_str, "readme.mntl").is_err());
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

        write_note_inner(&root_str, "secret.mntl.enc", "# Edited", &[], &keys).unwrap();

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
        let err = write_note_inner(&root_str, "secret.mntl.enc", "# Edited", &[], &keys).unwrap_err();

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

        move_note_inner(&root_str, "secret.mntl.enc", "work", &keys).unwrap();

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
        let err = move_note_inner(&root_str, "secret.mntl.enc", "work", &keys).unwrap_err();
        assert_eq!(err, format!("{LOCKED_ERR_PREFIX}my-diary"));

        // Destination locked.
        keys.lock_one(&root_str, "work").unwrap();
        let err = move_note_inner(&root_str, "secret.mntl.enc", "work", &keys).unwrap_err();
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
            let ranges = crate::attachments::image_sources(content);
            content[ranges[nth].clone()].to_string()
        };

        encrypt_note_inner(&root_str, "secret.mntl", "my-diary", &keys).unwrap();
        let content = read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap().content;
        let sealed = src_of(&content, 0);
        assert!(sealed.starts_with("attachments/") && sealed.ends_with(".png.enc"), "{content}");
        assert_eq!(src_of(&content, 1), sealed, "one copy per image");
        assert_eq!(src_of(&content, 2), "https://x/y.png");
        assert!(content.contains("|200]]"));
        assert!(root.join("attachments/cat.png").is_file(), "the original stays");

        move_note_inner(&root_str, "secret.mntl.enc", "work", &keys).unwrap();
        let content = read_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap().content;
        let moved = src_of(&content, 0);
        assert_ne!(moved, sealed);
        let header = mntl_core::extract_encrypted_header(&fs::read(root.join(&moved)).unwrap()).unwrap();
        assert_eq!(header.credential_profile, "work");

        decrypt_note_inner(&root_str, "secret.mntl.enc", &keys).unwrap();
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
