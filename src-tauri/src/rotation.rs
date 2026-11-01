//! Rotating a profile's master key: every note, sealed attachment and history
//! snapshot under it is re-encrypted under a fresh key.
//!
//! The new key is kept, wrapped by the old one, in `.mantle/rotation/<id>.json`
//! until the registry switches over, so both keys exist throughout and an
//! interrupted rotation resumes with the same new key. Files already moved open
//! under the new key and are skipped ([`mntl_core::rotate_envelope`]).
//!
//! As in [`crate::credentials`], errors reach the on-disk log: never interpolate
//! a password, key or note content.

use crate::credentials::{install_rotated_key, state_file, unlock_profile_inner, SessionKeys};
use crate::logging::logged;
use crate::vault::{note_paths, read_header_prefix, resolve_rel_path, write_atomic, EXT_ENCRYPTED};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use mntl_core::{unwrap_master_key, wrap_master_key, KeyEncryptionKey, MasterKey};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::State;
use zeroize::Zeroizing;

const PENDING_DIR: &str = "rotation";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    /// The new master key, wrapped by the old one.
    wrapped_new_key: String,
}

/// Re-encrypt everything under `profile_id` with a new master key, protect it
/// with `password` (the current one, or a new one) and return the profile's new
/// recovery key. Resumes an interrupted rotation.
///
/// The caller flushes pending note saves first: a save racing a rotation could
/// leave a note under the old key. Biometric wraps would have to be dropped
/// here too; none exist yet.
#[tauri::command]
pub fn rotate_master_key(
    vault_root: String,
    profile_id: String,
    password: String,
    keys: State<SessionKeys>,
) -> Result<String, String> {
    let password = Zeroizing::new(password);
    logged("rotate_master_key", || rotate_inner(&vault_root, &profile_id, &password, &keys))
}

fn rotate_inner(vault_root: &str, profile_id: &str, password: &str, keys: &SessionKeys) -> Result<String, String> {
    if password.is_empty() {
        return Err("Password must not be empty".to_string());
    }
    let old = keys
        .get(vault_root, profile_id)?
        .ok_or_else(|| format!("Unlock \"{profile_id}\" before rotating its key"))?;
    // Same check as unlocking, so a typo can't become the profile's password.
    unlock_profile_inner(vault_root, profile_id, password, keys)?;

    let pending = state_file(vault_root, PENDING_DIR, profile_id)?;
    let new = resume_or_start(&pending, &old)?;
    sweep(vault_root, profile_id, &old, &new, keys)?;
    let recovery_key = install_rotated_key(vault_root, profile_id, password, new, keys)?;
    let _ = fs::remove_file(&pending);
    Ok(recovery_key)
}

/// The new key of an interrupted rotation, or a fresh one. A record the old
/// key can't open is left over from a rotation that finished.
fn resume_or_start(pending: &PathBuf, old: &MasterKey) -> Result<MasterKey, String> {
    let wrapper = KeyEncryptionKey::from_bytes(*old.expose());
    let resumed = fs::read_to_string(pending)
        .ok()
        .and_then(|raw| serde_json::from_str::<Pending>(&raw).ok())
        .and_then(|p| BASE64.decode(p.wrapped_new_key).ok())
        .and_then(|wrapped| unwrap_master_key(&wrapper, &wrapped).ok());
    if let Some(key) = resumed {
        return Ok(key);
    }

    let new = MasterKey::generate().map_err(|e| e.to_string())?;
    let wrapped = wrap_master_key(&wrapper, &new).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec(&Pending { wrapped_new_key: BASE64.encode(wrapped) }).map_err(|e| e.to_string())?;
    fs::create_dir_all(pending.parent().ok_or("Invalid rotation path")?)
        .map_err(|e| format!("Failed to create the rotation folder: {e}"))?;
    write_atomic(pending, &json)?;
    Ok(new)
}

/// Every file that may be sealed under the profile, vault-relative.
fn candidates(vault_root: &str, keys: &SessionKeys) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = note_paths(vault_root, keys)?
        .into_iter()
        .map(|(_, disk)| disk)
        .filter(|disk| disk.ends_with(EXT_ENCRYPTED))
        .collect();
    for (dir, ext) in [(crate::attachments::ATTACHMENTS_DIR.to_string(), crate::attachments::EXT_SEALED), (format!("{}/history", crate::vault_meta::STATE_DIR), ".snapx")] {
        let Ok(read) = fs::read_dir(PathBuf::from(vault_root).join(&dir)) else { continue };
        for item in read.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.ends_with(ext) {
                out.push(format!("{dir}/{name}"));
            }
        }
    }
    Ok(out)
}

/// Move every file of the profile to `new`. All are tried and failures reported
/// together: the registry must not switch while one is still under the old key.
fn sweep(vault_root: &str, profile_id: &str, old: &MasterKey, new: &MasterKey, keys: &SessionKeys) -> Result<(), String> {
    let mut failed = Vec::new();
    for rel in candidates(vault_root, keys)? {
        let path = resolve_rel_path(vault_root, &rel)?;
        let mine = read_header_prefix(&path)
            .ok()
            .and_then(|head| mntl_core::extract_encrypted_header(&head).ok())
            .is_some_and(|header| header.credential_profile == profile_id);
        if !mine {
            continue;
        }
        let moved = fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|blob| mntl_core::rotate_envelope(old, new, &blob).map_err(|e| e.to_string()))
            .and_then(|sealed| sealed.map_or(Ok(()), |blob| write_atomic(&path, &blob)));
        if let Err(e) = moved {
            failed.push(format!("{rel} ({e})"));
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Couldn't re-encrypt {} file(s), so the key was not changed. Run it again after fixing: {}",
            failed.len(),
            failed.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::create_profile_inner;
    use mntl_core::KdfParams;

    fn vault(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("mntl-rotation-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("attachments")).unwrap();
        fs::create_dir_all(dir.join(".mantle/history")).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn cheap() -> KdfParams {
        KdfParams { m_cost: 8192, t_cost: 1, p_cost: 1 }
    }

    #[test]
    fn rotation_reseals_everything_and_resumes_after_an_interruption() {
        let root = vault("all");
        let keys = SessionKeys::default();
        create_profile_inner(&root, "Diary", "pw", &cheap(), &keys).unwrap();
        create_profile_inner(&root, "Work", "pw", &cheap(), &keys).unwrap();
        let (diary, work) = (keys.get(&root, "diary").unwrap().unwrap(), keys.get(&root, "work").unwrap().unwrap());

        let files = [
            ("note.mntl.enc", mntl_core::encrypt_note(&diary, "diary", b"n").unwrap()),
            ("attachments/a.png.enc", mntl_core::encrypt_note(&diary, "diary", b"png").unwrap()),
            ("attachments/b.mp4.enc", mntl_core::encrypt_stream(&diary, "diary", b"video", 2).unwrap()),
            (".mantle/history/s.snapx", mntl_core::encrypt_stream(&diary, "diary", b"snap", 64).unwrap()),
        ];
        for (rel, blob) in &files {
            fs::write(PathBuf::from(&root).join(rel), blob).unwrap();
        }
        let other = mntl_core::encrypt_note(&work, "work", b"w").unwrap();
        fs::write(PathBuf::from(&root).join("work.mntl.enc"), &other).unwrap();

        // Interrupt after the first file: a pending record and one file moved.
        let pending = state_file(&root, PENDING_DIR, "diary").unwrap();
        let new = resume_or_start(&pending, &diary).unwrap();
        let first = PathBuf::from(&root).join("note.mntl.enc");
        let moved = mntl_core::rotate_envelope(&diary, &new, &files[0].1).unwrap().unwrap();
        fs::write(&first, moved).unwrap();

        let recovery = rotate_inner(&root, "diary", "pw2", &keys);
        assert!(recovery.is_err(), "a typo of the current password must not rotate");
        let recovery = rotate_inner(&root, "diary", "pw", &keys).unwrap();

        let now = keys.get(&root, "diary").unwrap().unwrap();
        assert_ne!(now.expose(), diary.expose());
        assert_eq!(now.expose(), new.expose(), "the resumed rotation keeps its key");
        for (rel, _) in &files {
            let blob = fs::read(PathBuf::from(&root).join(rel)).unwrap();
            assert!(mntl_core::decrypt_note(&now, &blob).is_ok(), "{rel}");
            assert!(mntl_core::decrypt_note(&diary, &blob).is_err(), "{rel}");
        }
        assert_eq!(fs::read(PathBuf::from(&root).join("work.mntl.enc")).unwrap(), other);
        assert!(!pending.exists());

        // The new password and recovery key both open the new key.
        keys.lock_all().unwrap();
        unlock_profile_inner(&root, "diary", "pw", &keys).unwrap();
        assert_eq!(keys.get(&root, "diary").unwrap().unwrap().expose(), now.expose());
        crate::credentials::recover_profile_inner(&root, "diary", &recovery, "pw3", &cheap(), &keys).unwrap();
        assert_eq!(keys.get(&root, "diary").unwrap().unwrap().expose(), now.expose());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unreadable_file_stops_the_switch() {
        let root = vault("bad");
        let keys = SessionKeys::default();
        create_profile_inner(&root, "Diary", "pw", &cheap(), &keys).unwrap();
        let before = keys.get(&root, "diary").unwrap().unwrap();
        let stranger = MasterKey::generate().unwrap();
        let blob = mntl_core::encrypt_note(&stranger, "diary", b"x").unwrap();
        fs::write(PathBuf::from(&root).join("lost.mntl.enc"), blob).unwrap();

        let err = rotate_inner(&root, "diary", "pw", &keys).unwrap_err();
        assert!(err.contains("lost.mntl.enc"), "{err}");
        assert_eq!(keys.get(&root, "diary").unwrap().unwrap().expose(), before.expose());
        let _ = fs::remove_dir_all(&root);
    }
}
