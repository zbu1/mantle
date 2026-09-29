//! Credential profiles: named, password-protected key scopes for encrypted
//! notes.
//!
//! A profile owns one Argon2id salt and one master key. The master key is
//! stored only in wrapped form, in `.mantle/profiles.json` next to the vault's
//! other metadata, so profiles travel with the vault across machines and sync.
//! Unlocking a profile derives the KEK from the user's password, unwraps the
//! master key, and holds it in [`SessionKeys`] — process memory only — until
//! the user locks it or quits.
//!
//! Each `.mntl.enc` note names its profile in cleartext in its header, so the
//! app can group notes by profile and decrypt a whole profile's worth of them
//! from one password entry.
//!
//! # Two rules for anyone editing this module
//!
//! 1. **Every error returned from here is written verbatim to the on-disk log**
//!    by [`crate::logging::logged`]. Never interpolate a password, a key, or
//!    decrypted note content into one.
//! 2. **`profiles.json` holds the only copy of each wrapped master key.** Note
//!    headers deliberately do not duplicate the salt or the wrapped key, so
//!    losing this file makes every encrypted note in the vault unrecoverable
//!    even with the correct password. Hence the `.bak` written on every save.
//!
//! # Threat model
//!
//! This design provides at-rest confidentiality of the vault directory. It
//! does not resist an attacker who can read the memory of a running Mantle
//! process.

use crate::logging::logged;
use crate::vault_meta::STATE_DIR;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use mntl_core::{
    compute_verifier, derive_kek_with_params, unwrap_master_key,
    verify_master_key, wrap_master_key, KdfParams, MasterKey,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use zeroize::Zeroizing;

const PROFILES_FILE: &str = "profiles.json";
const CURRENT_VERSION: u32 = 1;

/// Length of a freshly generated per-profile Argon2id salt.
const SALT_LEN: usize = 16;

/// Longest generated profile slug, before any uniqueness suffix.
const MAX_SLUG_LEN: usize = 48;

/// Shown to the user when a KEK fails to unwrap a master key. AES-KW's
/// integrity check is what rejects a wrong password, so this is the message
/// for `MntlError::KeyWrapError` — never the raw error, which reads
/// "failed to wrap or unwrap key" and means nothing to someone typing a
/// password.
const INCORRECT_PASSWORD: &str = "Incorrect password";

// --- Registry ------------------------------------------------------------

/// One credential profile as persisted in `.mantle/profiles.json`.
///
/// Contains no secret: the salt and the wrapped master key are useless without
/// the password, and the verifier is a one-way tag over the master key.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialProfile {
    /// Immutable slug, generated from the display name at creation. This is
    /// the value written into every note header, and the header is the AEAD's
    /// associated data — so changing it would mean re-encrypting every note in
    /// the profile. It never changes; `display_name` is what users rename.
    pub id: String,
    /// User-facing name. Registry-only, so renaming is a single file write.
    pub display_name: String,
    /// Base64 Argon2id salt, unique per profile.
    pub salt: String,
    /// Argon2id cost parameters used with `salt` to derive this profile's KEK.
    #[serde(default)]
    pub kdf: KdfParams,
    /// Base64 AES-KW-wrapped master key. The only copy — see the module docs.
    pub wrapped_master_key: String,
    /// Base64 tag over the master key. Not the password check (AES-KW already
    /// is); this distinguishes a wrong password from a corrupt record.
    pub verifier: String,
}

/// The contents of `.mantle/profiles.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRegistry {
    #[serde(default = "current_version")]
    pub version: u32,
    #[serde(default)]
    pub profiles: Vec<CredentialProfile>,
}

fn current_version() -> u32 {
    CURRENT_VERSION
}

impl Default for ProfileRegistry {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            profiles: Vec::new(),
        }
    }
}

impl ProfileRegistry {
    fn find(&self, id: &str) -> Option<&CredentialProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut CredentialProfile> {
        self.profiles.iter_mut().find(|p| p.id == id)
    }
}

fn registry_path(vault_root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(vault_root)
        .canonicalize()
        .map_err(|e| format!("Invalid vault root: {e}"))?;
    Ok(root.join(STATE_DIR).join(PROFILES_FILE))
}

/// Read the profile registry for a vault. A vault with no profiles yet is not
/// an error — it just has an empty registry.
pub(crate) fn load_registry(vault_root: &str) -> Result<ProfileRegistry, String> {
    let path = registry_path(vault_root)?;
    read_registry_at(&path)
}

fn read_registry_at(path: &Path) -> Result<ProfileRegistry, String> {
    if !path.exists() {
        return Ok(ProfileRegistry::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read profiles: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse profiles: {e}"))
}

/// Write the profile registry atomically, keeping a `.bak` of what was there
/// before.
///
/// The temp-file-and-rename is the same pattern as `vault_meta::save_vault_meta`.
/// The extra backup is not: losing `state.json` costs a user their collapsed
/// folders, whereas losing `profiles.json` costs them every encrypted note in
/// the vault.
fn save_registry(vault_root: &str, registry: &ProfileRegistry) -> Result<(), String> {
    let path = registry_path(vault_root)?;
    let dir = path.parent().ok_or("Invalid profiles path")?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create {STATE_DIR}: {e}"))?;

    if path.exists() {
        let backup = dir.join(format!("{PROFILES_FILE}.bak"));
        fs::copy(&path, &backup).map_err(|e| format!("Failed to back up profiles: {e}"))?;
    }

    let json = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{PROFILES_FILE}.tmp"));
    fs::write(&tmp, json).map_err(|e| format!("Failed to write profiles: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to save profiles: {e}"))
}

// --- Session keys --------------------------------------------------------

/// Master keys for the profiles unlocked in this session.
///
/// Registered as Tauri managed state. Key bytes never cross the IPC boundary:
/// the frontend only ever learns *whether* a profile is unlocked.
#[derive(Default)]
pub struct SessionKeys(Mutex<SessionKeysInner>);

#[derive(Default)]
struct SessionKeysInner {
    /// Which vault these keys belong to. Opening a different vault clears them.
    vault_root: Option<PathBuf>,
    /// Boxed so that a `HashMap` resize, which relocates values byte-wise,
    /// moves only a pointer and leaves no un-zeroized copy of a key behind.
    keys: HashMap<String, Box<MasterKey>>,
}

impl SessionKeys {
    /// Run `f` with the key map, first clearing it if `vault_root` differs
    /// from the vault the current keys were unlocked for.
    fn with_vault<T>(
        &self,
        vault_root: &str,
        f: impl FnOnce(&mut SessionKeysInner) -> T,
    ) -> Result<T, String> {
        let canonical = PathBuf::from(vault_root)
            .canonicalize()
            .map_err(|e| format!("Invalid vault root: {e}"))?;

        let mut inner = self.0.lock().map_err(|e| e.to_string())?;
        if inner.vault_root.as_deref() != Some(canonical.as_path()) {
            inner.keys.clear();
            inner.vault_root = Some(canonical);
        }
        Ok(f(&mut inner))
    }

    /// The master key for `profile_id`, if that profile is unlocked for this vault.
    pub(crate) fn get(&self, vault_root: &str, profile_id: &str) -> Result<Option<MasterKey>, String> {
        self.with_vault(vault_root, |inner| {
            inner.keys.get(profile_id).map(|mk| (**mk).clone())
        })
    }

    fn insert(&self, vault_root: &str, profile_id: &str, mk: MasterKey) -> Result<(), String> {
        self.with_vault(vault_root, |inner| {
            inner.keys.insert(profile_id.to_string(), Box::new(mk));
        })
    }

    /// Forget one profile's key, leaving the rest unlocked.
    pub(crate) fn lock_one(&self, vault_root: &str, profile_id: &str) -> Result<(), String> {
        self.with_vault(vault_root, |inner| {
            inner.keys.remove(profile_id);
        })
    }

    fn unlocked_ids(&self, vault_root: &str) -> Result<Vec<String>, String> {
        self.with_vault(vault_root, |inner| inner.keys.keys().cloned().collect())
    }

    /// Unlock a profile directly, bypassing the password check.
    ///
    /// Test-only, so other modules' tests can exercise encryption without
    /// paying for an Argon2id derivation per test.
    #[cfg(test)]
    pub(crate) fn unlock_for_test(
        &self,
        vault_root: &str,
        profile_id: &str,
        mk: MasterKey,
    ) -> Result<(), String> {
        self.insert(vault_root, profile_id, mk)
    }

    /// Forget every unlocked key. Also called on app exit.
    pub fn lock_all(&self) -> Result<(), String> {
        let mut inner = self.0.lock().map_err(|e| e.to_string())?;
        inner.keys.clear();
        inner.vault_root = None;
        Ok(())
    }
}

// --- Slugs ---------------------------------------------------------------

/// Derive a URL-safe slug from a display name: lowercase, runs of
/// non-alphanumerics collapsed to a single `-`, trimmed, length-capped.
///
/// Returns `None` if nothing survives (e.g. a name of only punctuation).
fn slugify(display_name: &str) -> Option<String> {
    let mut slug = String::with_capacity(display_name.len());
    let mut pending_dash = false;

    for ch in display_name.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(ch.to_ascii_lowercase());
            if slug.len() >= MAX_SLUG_LEN {
                break;
            }
        } else {
            pending_dash = true;
        }
    }

    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

/// A slug not already used by `registry`, appending `-2`, `-3`, … as needed.
fn unique_slug(registry: &ProfileRegistry, base: &str) -> String {
    if registry.find(base).is_none() {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if registry.find(&candidate).is_none() {
            return candidate;
        }
        n += 1;
    }
}

// --- Commands ------------------------------------------------------------

/// A profile as the frontend sees it. Carries no key material — `kdf` is
/// cost parameters, not secret.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub id: String,
    pub display_name: String,
    pub unlocked: bool,
    pub kdf: KdfParams,
}

fn to_info(profile: &CredentialProfile, unlocked: bool) -> ProfileInfo {
    ProfileInfo {
        id: profile.id.clone(),
        display_name: profile.display_name.clone(),
        unlocked,
        kdf: profile.kdf.clone(),
    }
}

#[tauri::command]
pub fn list_credential_profiles(
    vault_root: String,
    keys: State<SessionKeys>,
) -> Result<Vec<ProfileInfo>, String> {
    logged("list_credential_profiles", || {
        let registry = load_registry(&vault_root)?;
        let unlocked = keys.unlocked_ids(&vault_root)?;
        Ok(registry
            .profiles
            .iter()
            .map(|p| to_info(p, unlocked.iter().any(|id| id == &p.id)))
            .collect())
    })
}

#[tauri::command]
pub fn create_credential_profile(
    vault_root: String,
    display_name: String,
    password: String,
    keys: State<SessionKeys>,
) -> Result<ProfileInfo, String> {
    let password = Zeroizing::new(password);
    logged("create_credential_profile", || {
        create_profile_inner(
            &vault_root,
            &display_name,
            &password,
            &KdfParams::default(),
            &keys,
        )
    })
}

/// The body of [`create_credential_profile`], with the Argon2id cost as a
/// parameter so tests can use something cheaper than the 19 MiB default.
fn create_profile_inner(
    vault_root: &str,
    display_name: &str,
    password: &str,
    kdf: &KdfParams,
    keys: &SessionKeys,
) -> Result<ProfileInfo, String> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err("Profile name must not be empty".to_string());
    }
    if password.is_empty() {
        return Err("Password must not be empty".to_string());
    }

    let base = slugify(display_name)
        .ok_or("Profile name must contain at least one letter or number")?;

    let mut registry = load_registry(vault_root)?;
    let id = unique_slug(&registry, &base);

    let mut salt = [0u8; SALT_LEN];
    OsRng
        .try_fill_bytes(&mut salt)
        .map_err(|e| format!("Failed to generate salt: {e}"))?;

    let kek = derive_kek_with_params(password, &salt, kdf).map_err(|e| e.to_string())?;
    let master_key = MasterKey::generate().map_err(|e| e.to_string())?;
    let wrapped = wrap_master_key(&kek, &master_key).map_err(|e| e.to_string())?;

    let profile = CredentialProfile {
        id: id.clone(),
        display_name: display_name.to_string(),
        salt: BASE64.encode(salt),
        kdf: kdf.clone(),
        wrapped_master_key: BASE64.encode(wrapped),
        verifier: compute_verifier(&master_key),
    };

    registry.profiles.push(profile.clone());
    save_registry(vault_root, &registry)?;

    // Unlock immediately: the KEK was just derived from a password the user
    // typed seconds ago, so asking for it again would be pure ceremony.
    keys.insert(vault_root, &id, master_key)?;

    Ok(to_info(&profile, true))
}

#[tauri::command]
pub fn unlock_credential_profile(
    vault_root: String,
    profile_id: String,
    password: String,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    let password = Zeroizing::new(password);
    logged("unlock_credential_profile", || {
        unlock_profile_inner(&vault_root, &profile_id, &password, &keys)
    })
}

fn unlock_profile_inner(
    vault_root: &str,
    profile_id: &str,
    password: &str,
    keys: &SessionKeys,
) -> Result<(), String> {
    let registry = load_registry(vault_root)?;
    let profile = registry
        .find(profile_id)
        .ok_or_else(|| format!("No credential profile \"{profile_id}\" in this vault"))?;

    let salt = BASE64
        .decode(&profile.salt)
        .map_err(|_| "Profile record is corrupt: invalid salt".to_string())?;
    let wrapped = BASE64
        .decode(&profile.wrapped_master_key)
        .map_err(|_| "Profile record is corrupt: invalid wrapped key".to_string())?;

    let kek = derive_kek_with_params(password, &salt, &profile.kdf).map_err(|e| e.to_string())?;

    // AES-KW's integrity check is the password check: a KEK from the wrong
    // password fails here rather than yielding a garbage key.
    let master_key = unwrap_master_key(&kek, &wrapped).map_err(|_| INCORRECT_PASSWORD.to_string())?;

    // The password was right, so a verifier mismatch means the stored record
    // is not the one this profile was created with.
    if !verify_master_key(&master_key, &profile.verifier) {
        return Err(
            "Profile record is corrupt: the stored key does not match this profile".to_string(),
        );
    }

    keys.insert(vault_root, profile_id, master_key)
}

#[tauri::command]
pub fn lock_credential_profile(
    vault_root: String,
    profile_id: String,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    logged("lock_credential_profile", || {
        keys.lock_one(&vault_root, &profile_id)
    })
}

#[tauri::command]
pub fn lock_all_credential_profiles(keys: State<SessionKeys>) -> Result<(), String> {
    logged("lock_all_credential_profiles", || keys.lock_all())
}

/// Rename a profile's display name. The immutable `id` (and every note header
/// naming it) is untouched, so this works whether or not the profile is
/// unlocked.
#[tauri::command]
pub fn rename_credential_profile(
    vault_root: String,
    profile_id: String,
    display_name: String,
    keys: State<SessionKeys>,
) -> Result<ProfileInfo, String> {
    logged("rename_credential_profile", || {
        rename_profile_inner(&vault_root, &profile_id, &display_name, &keys)
    })
}

fn rename_profile_inner(
    vault_root: &str,
    profile_id: &str,
    display_name: &str,
    keys: &SessionKeys,
) -> Result<ProfileInfo, String> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err("Profile name must not be empty".to_string());
    }

    let mut registry = load_registry(vault_root)?;
    let profile = registry
        .find_mut(profile_id)
        .ok_or_else(|| format!("No credential profile \"{profile_id}\" in this vault"))?;
    profile.display_name = display_name.to_string();
    let info = to_info(profile, keys.get(vault_root, profile_id)?.is_some());

    save_registry(vault_root, &registry)?;
    Ok(info)
}

/// Change a profile's password without touching any note.
///
/// Requires the profile already unlocked, so the master key is available to
/// rewrap: re-deriving a KEK from a brand new password can't unwrap the
/// *old* wrapped key, and asking for the old password again would just be
/// re-deriving what unlocking it already proved.
#[tauri::command]
pub fn change_credential_profile_password(
    vault_root: String,
    profile_id: String,
    new_password: String,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    let new_password = Zeroizing::new(new_password);
    logged("change_credential_profile_password", || {
        change_password_inner(&vault_root, &profile_id, &new_password, &keys)
    })
}

fn change_password_inner(
    vault_root: &str,
    profile_id: &str,
    new_password: &str,
    keys: &SessionKeys,
) -> Result<(), String> {
    if new_password.is_empty() {
        return Err("Password must not be empty".to_string());
    }

    let master_key = keys
        .get(vault_root, profile_id)?
        .ok_or_else(|| format!("Unlock \"{profile_id}\" before changing its password"))?;

    let mut registry = load_registry(vault_root)?;
    let profile = registry
        .find_mut(profile_id)
        .ok_or_else(|| format!("No credential profile \"{profile_id}\" in this vault"))?;

    let mut salt = [0u8; SALT_LEN];
    OsRng
        .try_fill_bytes(&mut salt)
        .map_err(|e| format!("Failed to generate salt: {e}"))?;

    let kek = derive_kek_with_params(new_password, &salt, &profile.kdf).map_err(|e| e.to_string())?;
    let wrapped = wrap_master_key(&kek, &master_key).map_err(|e| e.to_string())?;

    profile.salt = BASE64.encode(salt);
    profile.wrapped_master_key = BASE64.encode(wrapped);
    // `verifier` is a tag over the master key alone, which hasn't changed.

    save_registry(vault_root, &registry)
}

/// Delete a profile's registry entry and forget its session key, if any.
///
/// Does not touch any note. The frontend is responsible for decrypting a
/// profile's member notes to plaintext first — deleting a profile that still
/// has encrypted notes under it leaves them as unrecoverable orphans (the
/// same state as copying `.mntl.enc` files in from another vault).
#[tauri::command]
pub fn delete_credential_profile(
    vault_root: String,
    profile_id: String,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    logged("delete_credential_profile", || {
        delete_profile_inner(&vault_root, &profile_id, &keys)
    })
}

fn delete_profile_inner(vault_root: &str, profile_id: &str, keys: &SessionKeys) -> Result<(), String> {
    let mut registry = load_registry(vault_root)?;
    let before = registry.profiles.len();
    registry.profiles.retain(|p| p.id != profile_id);
    if registry.profiles.len() == before {
        return Err(format!("No credential profile \"{profile_id}\" in this vault"));
    }

    save_registry(vault_root, &registry)?;
    keys.lock_one(vault_root, profile_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Argon2id parameters cheap enough for a test suite; the production
    /// default is 19 MiB.
    fn test_kdf() -> KdfParams {
        KdfParams {
            m_cost: 8192,
            t_cost: 1,
            p_cost: 1,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mntl-credentials-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn root_of(dir: &Path) -> String {
        dir.to_string_lossy().into_owned()
    }

    // --- Slugs -----------------------------------------------------------

    #[test]
    fn slugify_lowercases_and_collapses_separators() {
        assert_eq!(slugify("My Diary").as_deref(), Some("my-diary"));
        assert_eq!(slugify("  Work   Notes  ").as_deref(), Some("work-notes"));
        assert_eq!(slugify("2024/Taxes!").as_deref(), Some("2024-taxes"));
        assert_eq!(slugify("Dear Diary").as_deref(), Some("dear-diary"));
    }

    #[test]
    fn slugify_rejects_names_with_nothing_to_slug() {
        assert_eq!(slugify(""), None);
        assert_eq!(slugify("   "), None);
        assert_eq!(slugify("!!! ???"), None);
        // Non-ASCII is dropped rather than transliterated, so an all-CJK name
        // has no slug and is rejected at the command layer with a clear message.
        assert_eq!(slugify("日記"), None);
    }

    #[test]
    fn slugify_caps_length() {
        let slug = slugify(&"a".repeat(200)).unwrap();
        assert_eq!(slug.len(), MAX_SLUG_LEN);
    }

    #[test]
    fn unique_slug_appends_a_numeric_suffix() {
        let mut registry = ProfileRegistry::default();
        assert_eq!(unique_slug(&registry, "diary"), "diary");

        registry.profiles.push(sample_profile("diary"));
        assert_eq!(unique_slug(&registry, "diary"), "diary-2");

        registry.profiles.push(sample_profile("diary-2"));
        assert_eq!(unique_slug(&registry, "diary"), "diary-3");
    }

    fn sample_profile(id: &str) -> CredentialProfile {
        CredentialProfile {
            id: id.to_string(),
            display_name: id.to_string(),
            salt: BASE64.encode([0u8; SALT_LEN]),
            kdf: test_kdf(),
            wrapped_master_key: BASE64.encode([0u8; 40]),
            verifier: String::new(),
        }
    }

    // --- Registry --------------------------------------------------------

    #[test]
    fn load_returns_an_empty_registry_when_missing() {
        let root = temp_dir("registry-missing");
        let registry = load_registry(&root_of(&root)).unwrap();

        assert_eq!(registry.version, CURRENT_VERSION);
        assert!(registry.profiles.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_then_load_round_trips() {
        let root = temp_dir("registry-roundtrip");
        let root_str = root_of(&root);

        let mut registry = ProfileRegistry::default();
        registry.profiles.push(sample_profile("diary"));
        save_registry(&root_str, &registry).unwrap();

        let loaded = load_registry(&root_str).unwrap();
        assert_eq!(loaded.profiles, registry.profiles);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_keeps_a_backup_of_the_previous_registry() {
        let root = temp_dir("registry-backup");
        let root_str = root_of(&root);

        let mut first = ProfileRegistry::default();
        first.profiles.push(sample_profile("diary"));
        save_registry(&root_str, &first).unwrap();

        let mut second = ProfileRegistry::default();
        second.profiles.push(sample_profile("work"));
        save_registry(&root_str, &second).unwrap();

        let backup = root.join(STATE_DIR).join(format!("{PROFILES_FILE}.bak"));
        let recovered = read_registry_at(&backup).unwrap();
        assert_eq!(recovered.profiles[0].id, "diary");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_fields_default_instead_of_failing_to_parse() {
        let root = temp_dir("registry-partial");
        let dir = root.join(STATE_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(PROFILES_FILE), "{}").unwrap();

        let registry = load_registry(&root_of(&root)).unwrap();
        assert_eq!(registry.version, CURRENT_VERSION);
        assert!(registry.profiles.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_registry_written_with_a_creation_time_still_loads_and_drops_it_on_save() {
        // Profiles used to record when they were created. That field is gone,
        // but the registry holds the only copy of each wrapped master key, so a
        // file that still carries it must parse rather than strand the vault.
        let root = temp_dir("registry-legacy-created-at");
        let dir = root.join(STATE_DIR);
        fs::create_dir_all(&dir).unwrap();
        let legacy = r#"{
            "version": 1,
            "profiles": [{
                "id": "diary",
                "displayName": "Diary",
                "salt": "AAAA",
                "wrappedMasterKey": "BBBB",
                "verifier": "CCCC",
                "createdAt": 1700000000000
            }]
        }"#;
        fs::write(dir.join(PROFILES_FILE), legacy).unwrap();

        let registry = load_registry(&root_of(&root)).unwrap();
        assert_eq!(registry.profiles.len(), 1);
        assert_eq!(registry.profiles[0].id, "diary");
        assert_eq!(registry.profiles[0].wrapped_master_key, "BBBB");

        save_registry(&root_of(&root), &registry).unwrap();
        let rewritten = fs::read_to_string(dir.join(PROFILES_FILE)).unwrap();
        assert!(!rewritten.contains("createdAt"));

        let _ = fs::remove_dir_all(&root);
    }

    // --- Create / unlock / lock ------------------------------------------

    #[test]
    fn create_then_unlock_with_the_correct_password() {
        let root = temp_dir("create-unlock");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        let info =
            create_profile_inner(&root_str, "My Diary", "hunter2", &test_kdf(), &keys).unwrap();
        assert_eq!(info.id, "my-diary");
        assert_eq!(info.display_name, "My Diary");
        assert!(info.unlocked, "creating a profile should unlock it");

        let created = keys.get(&root_str, "my-diary").unwrap().unwrap();

        keys.lock_all().unwrap();
        assert!(keys.get(&root_str, "my-diary").unwrap().is_none());

        unlock_profile_inner(&root_str, "my-diary", "hunter2", &keys).unwrap();
        let reopened = keys.get(&root_str, "my-diary").unwrap().unwrap();
        assert_eq!(created.expose(), reopened.expose());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unlock_with_wrong_password_reports_incorrect_password() {
        // Regression guard: the raw MntlError here is "failed to wrap or
        // unwrap key", which is both meaningless to a user and destined for
        // the on-disk log.
        let root = temp_dir("unlock-wrong");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        create_profile_inner(&root_str, "My Diary", "hunter2", &test_kdf(), &keys).unwrap();
        keys.lock_all().unwrap();

        let err = unlock_profile_inner(&root_str, "my-diary", "hunter3", &keys).unwrap_err();
        assert_eq!(err, INCORRECT_PASSWORD);
        assert!(keys.get(&root_str, "my-diary").unwrap().is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unlock_of_an_unknown_profile_fails() {
        let root = temp_dir("unlock-unknown");
        let keys = SessionKeys::default();

        let err = unlock_profile_inner(&root_of(&root), "nope", "hunter2", &keys).unwrap_err();
        assert!(err.contains("nope"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unlock_detects_a_corrupt_record_via_the_verifier() {
        let root = temp_dir("unlock-corrupt");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        create_profile_inner(&root_str, "My Diary", "hunter2", &test_kdf(), &keys).unwrap();
        keys.lock_all().unwrap();

        // Re-wrap a *different* master key under the same password, leaving
        // the original verifier in place: the password is still correct, so
        // AES-KW succeeds and only the verifier catches it.
        let mut registry = load_registry(&root_str).unwrap();
        let salt = BASE64.decode(&registry.profiles[0].salt).unwrap();
        let kek = derive_kek_with_params("hunter2", &salt, &test_kdf()).unwrap();
        let impostor = MasterKey::generate().unwrap();
        registry.profiles[0].wrapped_master_key =
            BASE64.encode(wrap_master_key(&kek, &impostor).unwrap());
        save_registry(&root_str, &registry).unwrap();

        let err = unlock_profile_inner(&root_str, "my-diary", "hunter2", &keys).unwrap_err();
        assert!(err.contains("corrupt"), "got: {err}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_profiles_with_the_same_name_get_distinct_ids() {
        let root = temp_dir("duplicate-names");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        let first =
            create_profile_inner(&root_str, "My Diary", "hunter2", &test_kdf(), &keys).unwrap();
        let second =
            create_profile_inner(&root_str, "My Diary", "hunter3", &test_kdf(), &keys).unwrap();

        assert_eq!(first.id, "my-diary");
        assert_eq!(second.id, "my-diary-2");
        assert_eq!(load_registry(&root_str).unwrap().profiles.len(), 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_rejects_empty_names_and_passwords() {
        let root = temp_dir("create-invalid");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        assert!(create_profile_inner(&root_str, "  ", "hunter2", &test_kdf(), &keys).is_err());
        assert!(create_profile_inner(&root_str, "Diary", "", &test_kdf(), &keys).is_err());
        assert!(create_profile_inner(&root_str, "!!!", "hunter2", &test_kdf(), &keys).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    // --- Session keys ----------------------------------------------------

    #[test]
    fn locking_one_profile_leaves_the_others_unlocked() {
        let root = temp_dir("lock-one");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        create_profile_inner(&root_str, "Diary", "hunter2", &test_kdf(), &keys).unwrap();
        create_profile_inner(&root_str, "Work", "hunter3", &test_kdf(), &keys).unwrap();

        keys.lock_one(&root_str, "diary").unwrap();

        assert!(keys.get(&root_str, "diary").unwrap().is_none());
        assert!(keys.get(&root_str, "work").unwrap().is_some());

        keys.lock_all().unwrap();
        assert!(keys.get(&root_str, "work").unwrap().is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn switching_vaults_clears_unlocked_keys() {
        // A key unlocked in one vault must not be reachable from another, even
        // if both happen to contain a profile with the same slug.
        let first = temp_dir("switch-a");
        let second = temp_dir("switch-b");
        let keys = SessionKeys::default();

        create_profile_inner(&root_of(&first), "Diary", "hunter2", &test_kdf(), &keys).unwrap();
        assert!(keys.get(&root_of(&first), "diary").unwrap().is_some());

        // Merely asking about the other vault switches context and clears.
        assert!(keys.get(&root_of(&second), "diary").unwrap().is_none());
        assert!(keys.get(&root_of(&first), "diary").unwrap().is_none());

        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&second);
    }

    // --- Rename / change password / delete --------------------------------

    #[test]
    fn rename_persists_the_new_display_name() {
        let root = temp_dir("rename");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        create_profile_inner(&root_str, "Diary", "hunter2", &test_kdf(), &keys).unwrap();
        let info = rename_profile_inner(&root_str, "diary", "My Diary", &keys).unwrap();
        assert_eq!(info.display_name, "My Diary");
        assert_eq!(info.id, "diary", "the slug must not change");

        let reloaded = load_registry(&root_str).unwrap();
        assert_eq!(reloaded.profiles[0].display_name, "My Diary");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_rejects_an_empty_name() {
        let root = temp_dir("rename-empty");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        create_profile_inner(&root_str, "Diary", "hunter2", &test_kdf(), &keys).unwrap();
        assert!(rename_profile_inner(&root_str, "diary", "   ", &keys).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn change_password_requires_the_profile_to_be_unlocked() {
        let root = temp_dir("change-password-locked");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        create_profile_inner(&root_str, "Diary", "hunter2", &test_kdf(), &keys).unwrap();
        keys.lock_all().unwrap();

        let err = change_password_inner(&root_str, "diary", "hunter3", &keys).unwrap_err();
        assert!(err.contains("Unlock"), "got: {err}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn change_password_swaps_which_password_unlocks_the_profile() {
        let root = temp_dir("change-password");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        let before = create_profile_inner(&root_str, "Diary", "hunter2", &test_kdf(), &keys).unwrap();
        let key_before = keys.get(&root_str, &before.id).unwrap().unwrap();

        change_password_inner(&root_str, "diary", "hunter3", &keys).unwrap();

        keys.lock_all().unwrap();
        let err = unlock_profile_inner(&root_str, "diary", "hunter2", &keys).unwrap_err();
        assert_eq!(err, INCORRECT_PASSWORD, "the old password must no longer work");

        unlock_profile_inner(&root_str, "diary", "hunter3", &keys).unwrap();
        let key_after = keys.get(&root_str, "diary").unwrap().unwrap();
        assert_eq!(
            key_before.expose(),
            key_after.expose(),
            "the master key — and so every note wrapped under it — must survive a password change"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_the_registry_entry_and_forgets_the_session_key() {
        let root = temp_dir("delete");
        let root_str = root_of(&root);
        let keys = SessionKeys::default();

        create_profile_inner(&root_str, "Diary", "hunter2", &test_kdf(), &keys).unwrap();
        create_profile_inner(&root_str, "Work", "hunter3", &test_kdf(), &keys).unwrap();

        delete_profile_inner(&root_str, "diary", &keys).unwrap();

        let reloaded = load_registry(&root_str).unwrap();
        assert_eq!(reloaded.profiles.len(), 1);
        assert_eq!(reloaded.profiles[0].id, "work");
        assert!(keys.get(&root_str, "diary").unwrap().is_none());
        assert!(keys.get(&root_str, "work").unwrap().is_some());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_of_an_unknown_profile_fails() {
        let root = temp_dir("delete-unknown");
        let keys = SessionKeys::default();

        let err = delete_profile_inner(&root_of(&root), "nope", &keys).unwrap_err();
        assert!(err.contains("nope"));

        let _ = fs::remove_dir_all(&root);
    }
}
