//! Note snapshots in `.mantle/history/`.
//!
//! A plaintext note's snapshot is `<id>.snap` (its Markdown body) listed in
//! `index.json`. An encrypted note's is `<id>.snapx`: its path, time and body
//! sealed under the profile's master key, so a locked vault shows nothing but
//! file names. The path is the one the frontend knows (virtual for hidden notes).

use crate::credentials::SessionKeys;
use crate::logging::logged;
use crate::vault::{read_header_prefix, resolve_rel_dir, split_rel_note_path, write_atomic, CreatedNote};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

const INDEX: &str = "index.json";
const QUIET_MS: u64 = 5 * 60 * 1000;
const EXT_PLAIN: &str = "snap";
const EXT_SEALED: &str = "snapx";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    id: String,
    path: String,
    time: u64,
}

/// What a sealed snapshot holds.
#[derive(Serialize, Deserialize)]
struct Sealed {
    path: String,
    time: u64,
    content: String,
}

struct Snap {
    entry: Entry,
    content: String,
    /// The profile it's sealed under; `None` for a plaintext snapshot.
    profile: Option<String>,
}

/// Where a snapshot is kept after [`follow`].
pub(crate) enum Scope<'a> {
    Keep,
    Plain,
    Profile(&'a str, &'a mntl_core::MasterKey),
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub time: u64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeletedNote {
    /// Its snapshots' newest id, to restore from.
    pub id: String,
    pub path: String,
    pub time: u64,
}

// ponytail: one lock for the whole store; fine while saves are debounced.
static LOCK: Mutex<()> = Mutex::new(());
/// The snapshot a note's saves are currently folding into, by (vault, path).
static OPEN: Mutex<Option<HashMap<(String, String), (String, u64)>>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn with_open<T>(f: impl FnOnce(&mut HashMap<(String, String), (String, u64)>) -> T) -> T {
    let mut guard = OPEN.lock().unwrap_or_else(|p| p.into_inner());
    f(guard.get_or_insert_with(HashMap::new))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn new_id() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn dir(vault_root: &str) -> PathBuf {
    PathBuf::from(vault_root).join(crate::vault_meta::STATE_DIR).join("history")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn read_index(vault_root: &str) -> Result<Vec<Entry>, String> {
    match fs::read_to_string(dir(vault_root).join(INDEX)) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("Failed to read the history index: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Failed to read the history index: {e}")),
    }
}

fn write_index(vault_root: &str, entries: &[Entry]) -> Result<(), String> {
    let json = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    write_atomic(&dir(vault_root).join(INDEX), &json)
}

fn write_plain(vault_root: &str, entry: &Entry, content: &str) -> Result<(), String> {
    write_atomic(&dir(vault_root).join(format!("{}.{EXT_PLAIN}", entry.id)), content.as_bytes())
}

fn write_sealed(
    vault_root: &str,
    entry: &Entry,
    content: &str,
    profile: &str,
    mk: &mntl_core::MasterKey,
) -> Result<(), String> {
    let body = zeroize::Zeroizing::new(
        serde_json::to_vec(&Sealed { path: entry.path.clone(), time: entry.time, content: content.to_string() })
            .map_err(|e| e.to_string())?,
    );
    let blob = mntl_core::encrypt_stream(mk, profile, &body, mntl_core::STREAM_CHUNK).map_err(|e| e.to_string())?;
    write_atomic(&dir(vault_root).join(format!("{}.{EXT_SEALED}", entry.id)), &blob)
}

fn write_snap(vault_root: &str, entry: &Entry, content: &str, scope: Option<(&str, &mntl_core::MasterKey)>) -> Result<(), String> {
    fs::create_dir_all(dir(vault_root)).map_err(|e| format!("Failed to create the history folder: {e}"))?;
    match scope {
        Some((profile, mk)) => write_sealed(vault_root, entry, content, profile, mk),
        None => {
            write_plain(vault_root, entry, content)?;
            let mut index = read_index(vault_root)?;
            match index.iter_mut().find(|e| e.id == entry.id) {
                Some(existing) => *existing = entry.clone(),
                None => index.push(entry.clone()),
            }
            write_index(vault_root, &index)
        }
    }
}

/// The sealed snapshot files, with whether each opened: a locked profile's
/// stay closed and are left alone.
fn sealed_snaps(vault_root: &str, keys: &SessionKeys) -> Vec<Snap> {
    let Ok(read) = fs::read_dir(dir(vault_root)) else { return Vec::new() };
    let mut out = Vec::new();
    for item in read.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some(EXT_SEALED) {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        let opened = (|| {
            let head = read_header_prefix(&path).ok()?;
            let profile = mntl_core::extract_encrypted_header(&head).ok()?.credential_profile;
            let mk = keys.get(vault_root, &profile).ok()??;
            let blob = fs::read(&path).ok()?;
            let plain = mntl_core::decrypt_stream(&mk, &blob).ok()?;
            let sealed: Sealed = serde_json::from_slice(&plain).ok()?;
            Some(Snap {
                entry: Entry { id: id.clone(), path: sealed.path, time: sealed.time },
                content: sealed.content,
                profile: Some(profile),
            })
        })();
        out.extend(opened);
    }
    out
}

/// Every snapshot this session can read.
// ponytail: decrypts every unlocked sealed snapshot per call; add a sealed index if big vaults feel it.
fn all(vault_root: &str, keys: &SessionKeys) -> Result<Vec<Snap>, String> {
    let mut out = Vec::new();
    for entry in read_index(vault_root)? {
        if let Ok(content) = fs::read_to_string(dir(vault_root).join(format!("{}.{EXT_PLAIN}", entry.id))) {
            out.push(Snap { entry, content, profile: None });
        }
    }
    out.extend(sealed_snaps(vault_root, keys));
    Ok(out)
}

fn remove_files(vault_root: &str, snap: &Snap) {
    let ext = if snap.profile.is_some() { EXT_SEALED } else { EXT_PLAIN };
    let _ = fs::remove_file(dir(vault_root).join(format!("{}.{ext}", snap.entry.id)));
}

/// Fold a save of `rel_path` into its open snapshot, or start a new one once
/// 5 minutes have passed without a save.
pub(crate) fn record(
    vault_root: &str,
    rel_path: &str,
    content: &str,
    scope: Option<(&str, &mntl_core::MasterKey)>,
) -> Result<(), String> {
    let meta = crate::vault_meta::load_vault_meta(vault_root.to_string())?;
    if !meta.snapshots_enabled {
        return Ok(());
    }
    let _guard = lock();
    let now = now_ms();
    let key = (vault_root.to_string(), rel_path.to_string());
    let open = with_open(|open| open.get(&key).cloned()).filter(|(_, time)| now.saturating_sub(*time) < QUIET_MS);
    let entry = Entry { id: open.map_or_else(new_id, |(id, _)| id), path: rel_path.to_string(), time: now };
    write_snap(vault_root, &entry, content, scope)?;
    with_open(|open| open.insert(key, (entry.id, now)));
    Ok(())
}

/// Drop the open snapshot of `rel_path`, so its next save starts a new one.
pub(crate) fn close(vault_root: &str, rel_path: &str) {
    with_open(|open| open.remove(&(vault_root.to_string(), rel_path.to_string())));
}

#[tauri::command]
pub fn close_snapshot(vault_root: String, rel_path: String) {
    close(&vault_root, &rel_path);
}

/// Log a failed snapshot without failing the save it came from.
pub(crate) fn record_quietly(
    vault_root: &str,
    rel_path: &str,
    content: &str,
    scope: Option<(&str, &mntl_core::MasterKey)>,
) {
    if let Err(e) = record(vault_root, rel_path, content, scope) {
        log::warn!("snapshot of a note failed: {e}");
    }
}

fn moved_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        return Some(to.to_string());
    }
    path.strip_prefix(from).and_then(|rest| rest.starts_with('/').then(|| format!("{to}{rest}")))
}

/// Re-path the snapshots of `from` (a note, or a folder and everything in it)
/// to `to`, and re-home them per `scope`. Snapshots of a locked profile can't
/// be rewritten and keep their old path, which lists them as a deleted note.
pub(crate) fn follow(vault_root: &str, from: &str, to: &str, scope: Scope, keys: &SessionKeys) {
    if let Err(e) = follow_inner(vault_root, from, to, scope, keys) {
        log::warn!("moving note history failed: {e}");
    }
}

fn follow_inner(vault_root: &str, from: &str, to: &str, scope: Scope, keys: &SessionKeys) -> Result<(), String> {
    let _guard = lock();
    with_open(|open| open.retain(|(root, path), _| root != vault_root || moved_path(path, from, to).is_none()));
    if !dir(vault_root).is_dir() {
        return Ok(());
    }
    let mut index = read_index(vault_root)?;
    let mut changed = false;
    for snap in all(vault_root, keys)? {
        let Some(path) = moved_path(&snap.entry.path, from, to) else { continue };
        let entry = Entry { path, ..snap.entry.clone() };
        match (&scope, &snap.profile) {
            (Scope::Profile(profile, mk), _) => {
                write_sealed(vault_root, &entry, &snap.content, profile, mk)?;
                if snap.profile.is_none() {
                    fs::remove_file(dir(vault_root).join(format!("{}.{EXT_PLAIN}", entry.id))).ok();
                    index.retain(|e| e.id != entry.id);
                    changed = true;
                }
            }
            (Scope::Plain, Some(_)) => {
                write_plain(vault_root, &entry, &snap.content)?;
                index.push(entry.clone());
                changed = true;
                fs::remove_file(dir(vault_root).join(format!("{}.{EXT_SEALED}", entry.id))).ok();
            }
            (_, Some(profile)) => {
                let mk = keys.get(vault_root, profile)?.ok_or("History's profile is locked")?;
                write_sealed(vault_root, &entry, &snap.content, profile, &mk)?;
            }
            (_, None) => {
                if let Some(existing) = index.iter_mut().find(|e| e.id == entry.id) {
                    existing.path = entry.path;
                    changed = true;
                }
            }
        }
    }
    if changed {
        write_index(vault_root, &index)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_snapshots(vault_root: String, rel_path: String, keys: State<SessionKeys>) -> Result<Vec<SnapshotInfo>, String> {
    logged("list_snapshots", || {
        let mut found: Vec<_> = all(&vault_root, &keys)?
            .into_iter()
            .filter(|s| s.entry.path == rel_path)
            .map(|s| SnapshotInfo { id: s.entry.id, time: s.entry.time })
            .collect();
        found.sort_by(|a, b| b.time.cmp(&a.time));
        Ok(found)
    })
}

#[tauri::command]
pub fn read_snapshot(vault_root: String, id: String, keys: State<SessionKeys>) -> Result<String, String> {
    logged("read_snapshot", || find(&vault_root, &id, &keys).map(|s| s.content))
}

fn find(vault_root: &str, id: &str, keys: &SessionKeys) -> Result<Snap, String> {
    if !valid_id(id) {
        return Err("Invalid snapshot".to_string());
    }
    all(vault_root, keys)?
        .into_iter()
        .find(|s| s.entry.id == id)
        .ok_or_else(|| "That snapshot no longer exists, or its profile is locked".to_string())
}

fn exists(vault_root: &str, path: &str, keys: &SessionKeys) -> Result<bool, String> {
    Ok(keys.hidden_note(vault_root, path)?.is_some() || resolve_rel_dir(vault_root, "")?.join(path).exists())
}

/// Notes that are gone but still have history, newest first.
#[tauri::command]
pub fn list_deleted_notes(vault_root: String, keys: State<SessionKeys>) -> Result<Vec<DeletedNote>, String> {
    logged("list_deleted_notes", || {
        let mut newest: HashMap<String, Entry> = HashMap::new();
        for snap in all(&vault_root, &keys)? {
            let slot = newest.entry(snap.entry.path.clone()).or_insert_with(|| snap.entry.clone());
            if snap.entry.time > slot.time {
                *slot = snap.entry;
            }
        }
        let mut gone = Vec::new();
        for (path, entry) in newest {
            if !exists(&vault_root, &path, &keys)? {
                gone.push(DeletedNote { id: entry.id, path, time: entry.time });
            }
        }
        gone.sort_by(|a, b| b.time.cmp(&a.time));
        Ok(gone)
    })
}

/// Recreate a deleted note from one of its snapshots, at its old path or, if
/// that's taken, a free name beside it.
#[tauri::command]
pub fn restore_deleted_note(vault_root: String, id: String, keys: State<SessionKeys>) -> Result<CreatedNote, String> {
    logged("restore_deleted_note", || {
        let snap = find(&vault_root, &id, &keys)?;
        let (dir_rel, stem, ext) = split_rel_note_path(&snap.entry.path);
        let rel = crate::hidden::unique_note_path(&vault_root, &keys, &dir_rel, &stem, ext, false)?;
        let document = mntl_core::encode_note(&mntl_core::NoteFrontmatter::default(), &snap.content)
            .map_err(|e| e.to_string())?;
        match &snap.profile {
            Some(profile) => {
                let mk = keys.get(&vault_root, profile)?.ok_or("Unlock the note's profile first")?;
                crate::hidden::seal_at(&vault_root, &keys, profile, &mk, &rel, &document, None)?;
            }
            None => {
                crate::hidden::ensure_rel_dir(&vault_root, &dir_rel, &keys)?;
                let path = crate::vault::resolve_rel_path(&vault_root, &rel)?;
                write_atomic(&path, document.as_bytes())?;
            }
        }
        Ok(CreatedNote { name: crate::vault::note_display_name(&rel), rel_path: rel })
    })
}

/// Delete snapshots older than the vault's retention. Sealed ones are only
/// judged once their profile is unlocked, since their time is sealed.
#[tauri::command]
pub fn prune_history(vault_root: String, keys: State<SessionKeys>) -> Result<(), String> {
    logged("prune_history", || {
        let meta = crate::vault_meta::load_vault_meta(vault_root.clone())?;
        let cutoff = now_ms().saturating_sub(u64::from(meta.snapshot_days) * 24 * 60 * 60 * 1000);
        let _guard = lock();
        let (old, _): (Vec<_>, Vec<_>) = all(&vault_root, &keys)?.into_iter().partition(|s| s.entry.time < cutoff);
        if old.is_empty() {
            return Ok(());
        }
        let mut index = read_index(&vault_root)?;
        for snap in &old {
            remove_files(&vault_root, snap);
            index.retain(|e| e.id != snap.entry.id);
        }
        write_index(&vault_root, &index)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("mantle-history-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn listed(vault: &str, path: &str, keys: &SessionKeys) -> Vec<String> {
        all(vault, keys)
            .unwrap()
            .into_iter()
            .filter(|s| s.entry.path == path)
            .map(|s| s.content)
            .collect()
    }

    #[test]
    fn saves_fold_into_one_snapshot_until_closed() {
        let vault = root("fold");
        let keys = SessionKeys::default();
        record(&vault, "a.mntl", "one", None).unwrap();
        record(&vault, "a.mntl", "two", None).unwrap();
        assert_eq!(listed(&vault, "a.mntl", &keys), ["two"]);
        close(&vault, "a.mntl");
        record(&vault, "a.mntl", "three", None).unwrap();
        assert_eq!(listed(&vault, "a.mntl", &keys).len(), 2);
    }

    #[test]
    fn follow_repaths_a_note_and_its_folder() {
        let vault = root("follow");
        let keys = SessionKeys::default();
        record(&vault, "dir/a.mntl", "x", None).unwrap();
        follow(&vault, "dir", "moved", Scope::Keep, &keys);
        assert_eq!(listed(&vault, "moved/a.mntl", &keys), ["x"]);
        assert!(listed(&vault, "dir/a.mntl", &keys).is_empty());
    }

    #[test]
    fn sealed_snapshots_need_their_profile_and_rehome_to_plain() {
        let vault = root("sealed");
        let keys = SessionKeys::default();
        let mk = mntl_core::MasterKey::from_bytes([7; 32]);
        keys.unlock_for_test(&vault, "p", mntl_core::MasterKey::from_bytes([7; 32])).unwrap();
        record(&vault, "n.mntl.enc", "secret", Some(("p", &mk))).unwrap();
        let on_disk = fs::read_dir(dir(&vault)).unwrap().flatten().map(|e| e.path()).collect::<Vec<_>>();
        assert!(!fs::read(&on_disk[0]).unwrap().windows(6).any(|w| w == b"secret"));
        assert_eq!(listed(&vault, "n.mntl.enc", &keys), ["secret"]);
        follow(&vault, "n.mntl.enc", "n.mntl", Scope::Plain, &keys);
        assert_eq!(listed(&vault, "n.mntl", &keys), ["secret"]);
        assert!(read_index(&vault).unwrap().iter().any(|e| e.path == "n.mntl"));
    }

    #[test]
    fn disabled_snapshots_record_nothing() {
        let vault = root("off");
        let meta = crate::vault_meta::VaultMeta { snapshots_enabled: false, ..Default::default() };
        crate::vault_meta::write_vault_meta(&vault, &meta).unwrap();
        record(&vault, "a.mntl", "x", None).unwrap();
        assert!(!dir(&vault).exists());
    }
}
