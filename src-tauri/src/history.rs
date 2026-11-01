//! Note snapshots in `.mantle/history/`.
//!
//! A plaintext note's snapshot is `<id>.snap` (its Markdown body) listed in
//! `index.json`. An encrypted note's is `<id>.snapx`: its path, time and body
//! sealed under the profile's master key, so a locked vault shows nothing but
//! file names. The path is the one the frontend knows (virtual for hidden notes).

use crate::session::ActiveVault;

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
        // The index travels with the vault and its ids become file names, so a
        // hostile one mustn't name anything but a snapshot.
        Ok(raw) => serde_json::from_str::<Vec<Entry>>(&raw)
            .map(|mut entries| {
                entries.retain(|e| valid_id(&e.id));
                entries
            })
            .map_err(|e| format!("Failed to read the history index: {e}")),
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

/// What an index of sealed snapshots keeps of each: enough to list them without opening them.
#[derive(Serialize, Deserialize, Clone)]
struct SnapMeta {
    path: String,
    time: u64,
}

/// Every snapshot this session can list, with the profile each is sealed
/// under (`None` for plaintext), but not its content. Sealed ones come from a
/// sealed index, so only those that changed are opened; a locked profile's
/// are left alone.
fn entries(vault_root: &str, keys: &SessionKeys) -> Result<Vec<(Entry, Option<String>)>, String> {
    let mut out = Vec::new();
    for entry in read_index(vault_root)? {
        if dir(vault_root).join(format!("{}.{EXT_PLAIN}", entry.id)).is_file() {
            out.push((entry, None));
        }
    }
    let Ok(read) = fs::read_dir(dir(vault_root)) else { return Ok(out) };
    let mut metas = crate::scan_index::Store::<SnapMeta>::open(dir(vault_root), "", "meta-");
    for item in read.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some(EXT_SEALED) {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        let Some(profile) = read_header_prefix(&path)
            .ok()
            .and_then(|head| mntl_core::extract_encrypted_header(&head).ok())
            .map(|h| h.credential_profile)
        else {
            continue;
        };
        let Some(mk) = keys.get(vault_root, &profile).ok().flatten() else { continue };
        let stamp = item.metadata().map_or((0, 0), |m| (m.len(), m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)));
        let meta = metas.sealed(&profile, &mk, &id, stamp, || open_sealed(vault_root, keys, &path, id.clone()).map(|s| SnapMeta { path: s.entry.path, time: s.entry.time }));
        if let Some(meta) = meta {
            out.push((Entry { id, path: meta.path, time: meta.time }, Some(profile)));
        }
    }
    metas.save();
    Ok(out)
}

/// The content of a snapshot listed by [`entries`].
fn load(vault_root: &str, keys: &SessionKeys, entry: Entry, profile: Option<String>) -> Option<Snap> {
    match profile {
        None => {
            let content = fs::read_to_string(dir(vault_root).join(format!("{}.{EXT_PLAIN}", entry.id))).ok()?;
            Some(Snap { entry, content, profile: None })
        }
        Some(_) => open_sealed(vault_root, keys, &dir(vault_root).join(format!("{}.{EXT_SEALED}", entry.id)), entry.id),
    }
}

/// The sealed snapshot `id` at `path`, if its profile is unlocked.
fn open_sealed(vault_root: &str, keys: &SessionKeys, path: &std::path::Path, id: String) -> Option<Snap> {
    let head = read_header_prefix(path).ok()?;
    let profile = mntl_core::extract_encrypted_header(&head).ok()?.credential_profile;
    let mk = keys.get(vault_root, &profile).ok()??;
    let blob = fs::read(path).ok()?;
    let plain = mntl_core::decrypt_stream(&mk, &blob).ok()?;
    let sealed: Sealed = serde_json::from_slice(&plain).ok()?;
    Some(Snap {
        entry: Entry { id, path: sealed.path, time: sealed.time },
        content: sealed.content,
        profile: Some(profile),
    })
}

/// Every snapshot this session can read, with its content.
#[cfg(test)]
fn all(vault_root: &str, keys: &SessionKeys) -> Result<Vec<Snap>, String> {
    Ok(entries(vault_root, keys)?.into_iter().filter_map(|(entry, profile)| load(vault_root, keys, entry, profile)).collect())
}

fn remove_files(vault_root: &str, id: &str, sealed: bool) {
    let ext = if sealed { EXT_SEALED } else { EXT_PLAIN };
    let _ = fs::remove_file(dir(vault_root).join(format!("{id}.{ext}")));
}

/// Fold a save of `rel_path` into its open snapshot, or start a new one once
/// 5 minutes have passed without a save.
pub(crate) fn record(
    vault_root: &str,
    rel_path: &str,
    content: &str,
    scope: Option<(&str, &mntl_core::MasterKey)>,
) -> Result<(), String> {
    let meta = crate::vault_meta::read_vault_meta(vault_root)?;
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
pub fn close_snapshot(active_vault: State<'_, ActiveVault>, rel_path: String) {
    let Ok(vault_root) = active_vault.root() else { return };
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
    for (listed, profile) in entries(vault_root, keys)? {
        let Some(path) = moved_path(&listed.path, from, to) else { continue };
        let Some(snap) = load(vault_root, keys, listed, profile) else { continue };
        let entry = Entry { path, ..snap.entry.clone() };
        match (&scope, &snap.profile) {
            (Scope::Profile(profile, mk), _) => {
                // One snapshot failing mustn't leave the rest in plaintext.
                if let Err(e) = write_sealed(vault_root, &entry, &snap.content, profile, mk) {
                    log::warn!("sealing a snapshot failed: {e}");
                    continue;
                }
                if snap.profile.is_none() {
                    // The snapshot was readable text: overwrite it, as the note itself was.
                    let _ = crate::notes_crypto::shred(&dir(vault_root).join(format!("{}.{EXT_PLAIN}", entry.id)));
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
pub fn list_snapshots(active_vault: State<'_, ActiveVault>, rel_path: String, keys: State<SessionKeys>) -> Result<Vec<SnapshotInfo>, String> {
    let vault_root = active_vault.root()?;
    logged("list_snapshots", || {
        let mut found: Vec<_> = entries(&vault_root, &keys)?
            .into_iter()
            .filter(|(e, _)| e.path == rel_path)
            .map(|(e, _)| SnapshotInfo { id: e.id, time: e.time })
            .collect();
        found.sort_by(|a, b| b.time.cmp(&a.time));
        Ok(found)
    })
}

#[tauri::command]
pub fn read_snapshot(active_vault: State<'_, ActiveVault>, id: String, keys: State<SessionKeys>) -> Result<String, String> {
    let vault_root = active_vault.root()?;
    logged("read_snapshot", || find(&vault_root, &id, &keys).map(|s| s.content))
}

fn find(vault_root: &str, id: &str, keys: &SessionKeys) -> Result<Snap, String> {
    if !valid_id(id) {
        return Err("Invalid snapshot".to_string());
    }
    let plain = read_index(vault_root)?.into_iter().find(|e| e.id == id).and_then(|entry| {
        let content = fs::read_to_string(dir(vault_root).join(format!("{id}.{EXT_PLAIN}"))).ok()?;
        Some(Snap { entry, content, profile: None })
    });
    plain
        .or_else(|| open_sealed(vault_root, keys, &dir(vault_root).join(format!("{id}.{EXT_SEALED}")), id.to_string()))
        .ok_or_else(|| "That snapshot no longer exists, or its profile is locked".to_string())
}

fn exists(vault_root: &str, path: &str, keys: &SessionKeys) -> Result<bool, String> {
    Ok(keys.hidden_note(vault_root, path)?.is_some() || resolve_rel_dir(vault_root, "")?.join(path).exists())
}

/// Notes that are gone but still have history, newest first.
#[tauri::command(async)]
pub fn list_deleted_notes(active_vault: State<'_, ActiveVault>, keys: State<SessionKeys>) -> Result<Vec<DeletedNote>, String> {
    let vault_root = active_vault.root()?;
    logged("list_deleted_notes", || {
        let mut newest: HashMap<String, Entry> = HashMap::new();
        for (entry, _) in entries(&vault_root, &keys)? {
            let slot = newest.entry(entry.path.clone()).or_insert_with(|| entry.clone());
            if entry.time > slot.time {
                *slot = entry;
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
pub fn restore_deleted_note(active_vault: State<'_, ActiveVault>, id: String, keys: State<SessionKeys>) -> Result<CreatedNote, String> {
    let vault_root = active_vault.root()?;
    logged("restore_deleted_note", || {
        let snap = find(&vault_root, &id, &keys)?;
        let (dir_rel, stem, ext) = split_rel_note_path(&snap.entry.path);
        let rel = crate::hidden::unique_note_path(&vault_root, &keys, &dir_rel, &stem, ext, false)?;
        // A Markdown file has no Mantle frontmatter to restore.
        let document = if crate::vault::is_markdown_note(&rel) {
            snap.content.clone()
        } else {
            mntl_core::encode_note(&mntl_core::NoteFrontmatter::default(), &snap.content).map_err(|e| e.to_string())?
        };
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
#[tauri::command(async)]
pub fn prune_history(active_vault: State<'_, ActiveVault>, keys: State<SessionKeys>) -> Result<(), String> {
    let vault_root = active_vault.root()?;
    logged("prune_history", || {
        let meta = crate::vault_meta::read_vault_meta(&vault_root)?;
        let cutoff = now_ms().saturating_sub(u64::from(meta.snapshot_days) * 24 * 60 * 60 * 1000);
        let _guard = lock();
        let old: Vec<_> = entries(&vault_root, &keys)?.into_iter().filter(|(e, _)| e.time < cutoff).collect();
        if old.is_empty() {
            return Ok(());
        }
        let mut index = read_index(&vault_root)?;
        for (entry, profile) in &old {
            remove_files(&vault_root, &entry.id, profile.is_some());
            index.retain(|e| e.id != entry.id);
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

    #[test]
    fn a_hostile_index_cannot_name_files_outside_history() {
        let vault = root("hostile");
        fs::create_dir_all(dir(&vault)).unwrap();
        let index = r#"[{"id":"../../x","path":"a.mntl","time":1},{"id":"ab12","path":"b.mntl","time":2}]"#;
        fs::write(dir(&vault).join(INDEX), index).unwrap();
        let ids: Vec<_> = read_index(&vault).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, ["ab12"]);
    }

    #[test]
    fn find_opens_a_plain_and_a_sealed_snapshot_by_id() {
        let vault = root("find");
        let keys = SessionKeys::default();
        let mk = mntl_core::MasterKey::from_bytes([9; 32]);
        keys.unlock_for_test(&vault, "p", mntl_core::MasterKey::from_bytes([9; 32])).unwrap();
        record(&vault, "a.mntl", "plain", None).unwrap();
        record(&vault, "b.mntl.enc", "secret", Some(("p", &mk))).unwrap();
        for snap in all(&vault, &keys).unwrap() {
            assert_eq!(find(&vault, &snap.entry.id, &keys).unwrap().content, snap.content);
        }
        assert!(find(&vault, "../x", &keys).is_err());
        assert!(find(&vault, "abcd", &keys).is_err());
    }
}
