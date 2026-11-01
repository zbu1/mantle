//! Biometric unlock (Windows Hello), opt-in per profile and per device.
//!
//! A profile's master key is wrapped by a key derived from a Hello-protected
//! TPM key and stored in local app data, never in the vault. Signing a fixed
//! challenge with an RSA PKCS#1 v1.5 key is deterministic, and only after the
//! user passes Hello; the hash of that signature is the wrapping key.
//!
//! As in [`crate::credentials`], errors reach the on-disk log: never interpolate
//! a password, key or note content.

use crate::credentials::{load_registry, SessionKeys};
use crate::logging::logged;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use mntl_core::{unwrap_master_key, verify_master_key, wrap_master_key, KeyEncryptionKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

const NOT_SUPPORTED: &str = "Windows Hello isn't available on this device";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wrap {
    wrapped_master_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    available: bool,
    /// Profiles of this vault that can be unlocked with Hello on this device.
    enabled: Vec<String>,
}

#[cfg(windows)]
mod hello {
    use super::NOT_SUPPORTED;
    use mntl_core::KeyEncryptionKey;
    use sha2::{Digest, Sha256};
    use windows::core::{Array, HSTRING};
    use windows::Security::Credentials::{
        KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::CryptographicBuffer;

    const CHALLENGE: &[u8] = b"mantle-biometric-unlock-v1";

    pub fn available() -> bool {
        KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()).unwrap_or(false)
    }

    /// Create (or replace) the Hello key `name` and derive the wrapping key.
    pub fn create(name: &str) -> Result<KeyEncryptionKey, String> {
        let result = KeyCredentialManager::RequestCreateAsync(&HSTRING::from(name), KeyCredentialCreationOption::ReplaceExisting)
            .and_then(|op| op.join())
            .map_err(|_| NOT_SUPPORTED.to_string())?;
        match result.Status() {
            Ok(KeyCredentialStatus::Success) => derive(&result.Credential().map_err(|e| e.to_string())?),
            Ok(KeyCredentialStatus::UserCanceled) => Err("Windows Hello was cancelled".to_string()),
            _ => Err(NOT_SUPPORTED.to_string()),
        }
    }

    /// Prompt for Hello and derive the wrapping key of the key `name`.
    pub fn open(name: &str) -> Result<KeyEncryptionKey, String> {
        let result = KeyCredentialManager::OpenAsync(&HSTRING::from(name))
            .and_then(|op| op.join())
            .map_err(|_| NOT_SUPPORTED.to_string())?;
        match result.Status() {
            Ok(KeyCredentialStatus::Success) => derive(&result.Credential().map_err(|e| e.to_string())?),
            Ok(KeyCredentialStatus::NotFound) => Err("Windows Hello was reset on this device; use the password".to_string()),
            _ => Err(NOT_SUPPORTED.to_string()),
        }
    }

    pub fn delete(name: &str) {
        let _ = KeyCredentialManager::DeleteAsync(&HSTRING::from(name)).and_then(|op| op.join());
    }

    fn derive(credential: &KeyCredential) -> Result<KeyEncryptionKey, String> {
        let challenge = CryptographicBuffer::CreateFromByteArray(CHALLENGE).map_err(|e| e.to_string())?;
        let signed = credential
            .RequestSignAsync(&challenge)
            .and_then(|op| op.join())
            .map_err(|e| e.to_string())?;
        if signed.Status() != Ok(KeyCredentialStatus::Success) {
            return Err("Windows Hello verification failed or was cancelled".to_string());
        }
        let mut signature = Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(&signed.Result().map_err(|e| e.to_string())?, &mut signature)
            .map_err(|e| e.to_string())?;
        Ok(KeyEncryptionKey::from_bytes(Sha256::digest(&*signature).into()))
    }
}

#[cfg(not(windows))]
mod hello {
    use super::NOT_SUPPORTED;
    use mntl_core::KeyEncryptionKey;

    pub fn available() -> bool {
        false
    }
    pub fn create(_: &str) -> Result<KeyEncryptionKey, String> {
        Err(NOT_SUPPORTED.to_string())
    }
    pub fn open(_: &str) -> Result<KeyEncryptionKey, String> {
        Err(NOT_SUPPORTED.to_string())
    }
    pub fn delete(_: &str) {}
}

/// Names the Hello key and the wrap file of one profile in one vault.
fn slot(vault_root: &str, profile_id: &str) -> Result<String, String> {
    let root = PathBuf::from(vault_root)
        .canonicalize()
        .map_err(|e| format!("Invalid vault root: {e}"))?;
    if profile_id.is_empty() || !profile_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid profile id".to_string());
    }
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    let id: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("mantle-{id}-{profile_id}"))
}

fn wrap_path(app: &AppHandle, slot: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("biometric");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the biometric folder: {e}"))?;
    Ok(dir.join(format!("{slot}.json")))
}

/// Forget a profile's Hello unlock on this device, if it has one. Its master
/// key or its password changed, and the password is required again.
pub(crate) fn forget(app: &AppHandle, vault_root: &str, profile_id: &str) {
    let Ok(slot) = slot(vault_root, profile_id) else { return };
    if let Ok(path) = wrap_path(app, &slot) {
        if path.exists() {
            let _ = fs::remove_file(path);
            hello::delete(&slot);
        }
    }
}

#[tauri::command]
pub async fn biometric_status(app: AppHandle, vault_root: String) -> Result<BiometricStatus, String> {
    logged("biometric_status", || {
        let available = hello::available();
        let enabled = load_registry(&vault_root)?
            .profiles
            .iter()
            .filter(|p| slot(&vault_root, &p.id).and_then(|s| wrap_path(&app, &s)).is_ok_and(|path| path.exists()))
            .map(|p| p.id.clone())
            .collect();
        Ok(BiometricStatus { available, enabled })
    })
}

/// Turn Hello unlock on for an unlocked profile.
#[tauri::command]
pub async fn enable_biometric(
    app: AppHandle,
    vault_root: String,
    profile_id: String,
    keys: State<'_, SessionKeys>,
) -> Result<(), String> {
    logged("enable_biometric", || {
        let master = keys
            .get(&vault_root, &profile_id)?
            .ok_or_else(|| format!("Unlock \"{profile_id}\" before turning on Windows Hello"))?;
        let slot = slot(&vault_root, &profile_id)?;
        let kek = hello::create(&slot)?;
        let wrapped = wrap_master_key(&kek, &master).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec(&Wrap { wrapped_master_key: BASE64.encode(wrapped) }).map_err(|e| e.to_string())?;
        fs::write(wrap_path(&app, &slot)?, json).map_err(|e| {
            hello::delete(&slot);
            format!("Failed to save the Windows Hello unlock: {e}")
        })
    })
}

#[tauri::command]
pub async fn disable_biometric(app: AppHandle, vault_root: String, profile_id: String) -> Result<(), String> {
    logged("disable_biometric", || {
        forget(&app, &vault_root, &profile_id);
        Ok(())
    })
}

#[tauri::command]
pub async fn unlock_with_biometric(
    app: AppHandle,
    vault_root: String,
    profile_id: String,
    keys: State<'_, SessionKeys>,
) -> Result<(), String> {
    logged("unlock_with_biometric", || {
        let slot = slot(&vault_root, &profile_id)?;
        let corrupt = || "The Windows Hello unlock is corrupt; use the password".to_string();
        let raw = fs::read(wrap_path(&app, &slot)?).map_err(|_| "Windows Hello isn't set up for this profile".to_string())?;
        let wrap: Wrap = serde_json::from_slice(&raw).map_err(|_| corrupt())?;
        let wrapped = BASE64.decode(wrap.wrapped_master_key).map_err(|_| corrupt())?;
        let kek: KeyEncryptionKey = hello::open(&slot)?;
        let master = unwrap_master_key(&kek, &wrapped).map_err(|_| "Windows Hello didn't match; use the password".to_string())?;

        let registry = load_registry(&vault_root)?;
        let profile = registry
            .find(&profile_id)
            .ok_or_else(|| format!("No credential profile \"{profile_id}\" in this vault"))?;
        if !verify_master_key(&master, &profile.verifier) {
            // The key was replaced (recovery) without going through `forget`.
            forget(&app, &vault_root, &profile_id);
            return Err("The key changed since Windows Hello was set up; use the password".to_string());
        }
        keys.insert(&vault_root, &profile_id, master)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_differ_per_vault_and_profile_and_reject_bad_ids() {
        let a = std::env::temp_dir();
        let b = std::env::current_dir().unwrap();
        let (a, b) = (a.to_string_lossy(), b.to_string_lossy());
        assert_ne!(slot(&a, "x").unwrap(), slot(&b, "x").unwrap());
        assert_ne!(slot(&a, "x").unwrap(), slot(&a, "y").unwrap());
        assert!(slot(&a, "../x").is_err());
    }
}
