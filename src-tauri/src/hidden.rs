//! Hidden note locations and names: a credential profile can keep where its
//! notes sit and what they're called sealed inside them, rather than in the
//! file system.
//!
//! With "Hide locations" a profile's note files sit in the vault root; with
//! "Hide names" they get random names. Either way the note's real folder and
//! name go into its [`mntl_core::NoteFrontmatter`] (`location`, `name`), and
//! its `.mntl.enc` header says it's hidden, so a locked vault can leave it out
//! of the tree.
//!
//! The frontend only ever knows an unlocked hidden note by its *virtual* path
//! — its real folder and name, e.g. `Journal/Ideas.mntl.enc`. Where its file
//! really is lives in [`SessionKeys`], rebuilt by every scan and dropped on
//! lock, and every command that takes a note path goes through
//! [`resolve_note`] to find it.

use crate::credentials::{load_registry, save_registry, HiddenNote, SessionKeys};
use crate::logging::logged;
use crate::vault::{
    join_rel_note_path, note_paths, read_header, resolve_rel_dir, resolve_rel_path, split_rel_note_path,
    write_atomic, CreatedNote, EXT_ENCRYPTED, LOCKED_ERR_PREFIX,
};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::State;
use zeroize::Zeroizing;

/// A profile's two hiding settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Hiding {
    pub locations: bool,
    pub names: bool,
}

impl Hiding {
    pub fn any(self) -> bool {
        self.locations || self.names
    }
}

/// The hiding settings of `profile_id`; none for a profile not in the registry.
pub(crate) fn profile_hiding(vault_root: &str, profile_id: &str) -> Result<Hiding, String> {
    Ok(load_registry(vault_root)?
        .find(profile_id)
        .map(|p| Hiding { locations: p.hide_locations, names: p.hide_names })
        .unwrap_or_default())
}

/// The file of the note the frontend knows as `rel_path`: a hidden note's
/// disk file, or `rel_path` itself.
pub(crate) fn resolve_note(vault_root: &str, rel_path: &str, keys: &SessionKeys) -> Result<PathBuf, String> {
    resolve_rel_path(vault_root, &disk_rel(vault_root, rel_path, keys)?)
}

/// The vault-relative disk path of the note the frontend knows as `rel_path`.
pub(crate) fn disk_rel(vault_root: &str, rel_path: &str, keys: &SessionKeys) -> Result<String, String> {
    Ok(keys.hidden_note(vault_root, rel_path)?.map_or_else(|| rel_path.to_string(), |note| note.disk))
}

/// Check a vault-relative path's components without touching the disk.
pub(crate) fn check_components(rel: &str) -> Result<(), String> {
    for component in rel.split('/') {
        if component.is_empty() || component == "." || component == ".." || component.contains(['\\', ':']) {
            return Err(format!("Invalid path component in \"{rel}\""));
        }
    }
    Ok(())
}

/// Whether `rel_dir` exists only as the location of some hidden note.
fn is_virtual_dir(vault_root: &str, rel_dir: &str, keys: &SessionKeys) -> Result<bool, String> {
    let prefix = format!("{rel_dir}/");
    Ok(keys.hidden_notes(vault_root)?.keys().any(|rel| rel.starts_with(&prefix)))
}

/// [`resolve_rel_dir`], creating the folder first if it's a virtual one: a
/// plaintext note moved into a hidden note's folder needs a real one.
pub(crate) fn ensure_rel_dir(vault_root: &str, rel_dir: &str, keys: &SessionKeys) -> Result<PathBuf, String> {
    if let Ok(dir) = resolve_rel_dir(vault_root, rel_dir) {
        return Ok(dir);
    }
    if !is_virtual_dir(vault_root, rel_dir, keys)? {
        return resolve_rel_dir(vault_root, rel_dir);
    }
    create_rel_dir(vault_root, rel_dir)
}

fn create_rel_dir(vault_root: &str, rel_dir: &str) -> Result<PathBuf, String> {
    if !rel_dir.is_empty() {
        check_components(rel_dir)?;
        let root = resolve_rel_dir(vault_root, "")?;
        fs::create_dir_all(root.join(rel_dir)).map_err(|e| format!("Failed to create folder: {e}"))?;
    }
    resolve_rel_dir(vault_root, rel_dir)
}

/// Whether a note can't go at `rel`: a file is there, or a hidden note is
/// known by that path.
pub(crate) fn taken(vault_root: &str, rel: &str, keys: &SessionKeys) -> Result<bool, String> {
    taken_by_other(vault_root, rel, keys, None)
}

/// [`taken`], not counting the note `own` (its id and disk path) itself.
fn taken_by_other(vault_root: &str, rel: &str, keys: &SessionKeys, own: Option<(&str, &str)>) -> Result<bool, String> {
    if keys.hidden_note(vault_root, rel)?.is_some() && own.map(|(id, _)| id) != Some(rel) {
        return Ok(true);
    }
    let path = resolve_rel_dir(vault_root, "")?.join(rel);
    Ok(path.exists() && own.map(|(_, disk)| disk) != Some(rel))
}

/// A free note path in `dir` for `stem`, as [`crate::vault::unique_sibling_note_path`]
/// picks one ("stem copy", "stem copy 2"), counting hidden notes as taken.
pub(crate) fn unique_note_path(
    vault_root: &str,
    keys: &SessionKeys,
    dir: &str,
    stem: &str,
    ext: &str,
    force_suffix: bool,
) -> Result<String, String> {
    if !force_suffix {
        let rel = join_rel_note_path(dir, stem, ext);
        if !taken(vault_root, &rel, keys)? {
            return Ok(rel);
        }
    }
    for n in 1.. {
        let candidate = if n == 1 { format!("{stem} copy") } else { format!("{stem} copy {n}") };
        let rel = join_rel_note_path(dir, &candidate, ext);
        if !taken(vault_root, &rel, keys)? {
            return Ok(rel);
        }
    }
    unreachable!()
}

const RANDOM_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
const RANDOM_STEM_LEN: usize = 20;

fn random_stem() -> String {
    let mut bytes = [0u8; RANDOM_STEM_LEN];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| RANDOM_ALPHABET[(b % 32) as usize] as char).collect()
}

fn is_random_stem(stem: &str) -> bool {
    stem.len() == RANDOM_STEM_LEN && stem.bytes().all(|b| RANDOM_ALPHABET.contains(&b))
}

/// Whether `stem` is `base` or `base (N)`.
fn is_stem_or_suffixed(stem: &str, base: &str) -> bool {
    stem == base
        || stem
            .strip_prefix(base)
            .and_then(|rest| rest.strip_prefix(" ("))
            .and_then(|rest| rest.strip_suffix(')'))
            .is_some_and(|n| n.parse::<u32>().is_ok())
}

/// Whether the file at `disk` is where `hiding` would put the note `virtual_rel`.
fn placed(hiding: Hiding, virtual_rel: &str, disk: &str) -> bool {
    let (vdir, vstem, _) = split_rel_note_path(virtual_rel);
    let (ddir, dstem, _) = split_rel_note_path(disk);
    let want_dir = if hiding.locations { "" } else { vdir.as_str() };
    if ddir != want_dir {
        return false;
    }
    if hiding.names {
        is_random_stem(&dstem)
    } else if hiding.locations {
        is_stem_or_suffixed(&dstem, &vstem)
    } else {
        disk == virtual_rel
    }
}

/// A new disk path for the note `virtual_rel` under `hiding`: a random name,
/// or its name in the root with ` (2)`, ` (3)`… if that's taken, or its own path.
fn new_disk_path(vault_root: &str, keys: &SessionKeys, hiding: Hiding, virtual_rel: &str) -> Result<String, String> {
    let (vdir, vstem, _) = split_rel_note_path(virtual_rel);
    let dir = if hiding.locations { String::new() } else { vdir };
    if hiding.names {
        loop {
            let rel = join_rel_note_path(&dir, &random_stem(), EXT_ENCRYPTED);
            if !taken(vault_root, &rel, keys)? {
                return Ok(rel);
            }
        }
    }
    if hiding.locations {
        for n in 1.. {
            let stem = if n == 1 { vstem.clone() } else { format!("{vstem} ({n})") };
            let rel = join_rel_note_path("", &stem, EXT_ENCRYPTED);
            if !taken(vault_root, &rel, keys)? {
                return Ok(rel);
            }
        }
    }
    Ok(virtual_rel.to_string())
}

/// Remove the folders above the file `rel_file` that are empty now, up to the
/// root: moving a note's file out of a folder for hiding mustn't leave the
/// folder behind to give its name away.
fn remove_emptied_dirs(vault_root: &str, rel_file: &str) {
    let mut dir = rel_file.rsplit_once('/').map(|(dir, _)| dir.to_string());
    while let Some(rel_dir) = dir.filter(|d| !d.is_empty()) {
        let Ok(path) = resolve_rel_dir(vault_root, &rel_dir) else { return };
        if fs::read_dir(&path).map_or(true, |mut entries| entries.next().is_some()) {
            return;
        }
        crate::watcher::suppress(&path);
        if fs::remove_dir(&path).is_err() {
            return;
        }
        dir = rel_dir.rsplit_once('/').map(|(dir, _)| dir.to_string());
    }
}

/// Seal `document` (a whole `.mntl` document) as the note the frontend knows
/// as `virtual_rel`, in `profile_id`, placed as that profile's settings say.
/// `current` is the note's present id and disk file, if it has one, which
/// this replaces. Returns the new disk path.
///
/// Every write that may change whether or where a note is hidden comes
/// through here: creating, encrypting, re-homing, renaming and moving a
/// hidden note, and changing a profile's settings. Like encrypting, the new
/// file is read back and checked before the old one goes.
pub(crate) fn seal_at(
    vault_root: &str,
    keys: &SessionKeys,
    profile_id: &str,
    mk: &mntl_core::MasterKey,
    virtual_rel: &str,
    document: &str,
    current: Option<(&str, &str)>,
) -> Result<String, String> {
    check_components(virtual_rel)?;
    let hiding = profile_hiding(vault_root, profile_id)?;
    let (mut frontmatter, body) =
        mntl_core::decode_note(document).map_err(|e| format!("Not a valid note: {e}"))?;
    let body = Zeroizing::new(body);
    if hiding.any() {
        let (dir, stem, _) = split_rel_note_path(virtual_rel);
        frontmatter.location = Some(dir);
        frontmatter.name = Some(stem);
    } else {
        frontmatter.location = None;
        frontmatter.name = None;
    }
    let encoded = Zeroizing::new(mntl_core::encode_note(&frontmatter, &body).map_err(|e| e.to_string())?);

    let current_disk = current.map(|(_, disk)| disk);
    let disk = match current_disk {
        Some(disk) if placed(hiding, virtual_rel, disk) => disk.to_string(),
        _ => new_disk_path(vault_root, keys, hiding, virtual_rel)?,
    };
    let replacing = current_disk == Some(disk.as_str());
    if !replacing && taken_by_other(vault_root, &disk, keys, current)? {
        let (_, stem, _) = split_rel_note_path(virtual_rel);
        return Err(format!("A note named \"{stem}\" already exists in this folder"));
    }
    create_rel_dir(vault_root, disk.rsplit_once('/').map_or("", |(dir, _)| dir))?;
    let path = resolve_rel_path(vault_root, &disk)?;

    let blob = mntl_core::encrypt_note_as(mk, profile_id, hiding.any(), encoded.as_bytes()).map_err(|e| e.to_string())?;
    write_atomic(&path, &blob)?;
    let verified = fs::read(&path)
        .ok()
        .and_then(|written| mntl_core::decrypt_note(mk, &written).ok())
        .is_some_and(|roundtrip| roundtrip.as_slice() == encoded.as_bytes());
    if !verified {
        if !replacing {
            let _ = fs::remove_file(&path);
        }
        return Err("The encrypted note failed verification".to_string());
    }

    if let Some((id, old_disk)) = current {
        if old_disk != disk {
            let old = resolve_rel_path(vault_root, old_disk)?;
            crate::watcher::suppress(&old);
            fs::remove_file(&old).map_err(|e| format!("Failed to remove the old note file: {e}"))?;
            if hiding.locations {
                remove_emptied_dirs(vault_root, old_disk);
            }
        }
        keys.put_hidden(vault_root, id, None)?;
    }
    if hiding.any() {
        keys.put_hidden(vault_root, virtual_rel, Some(HiddenNote { disk: disk.clone(), profile: profile_id.to_string() }))?;
    }
    Ok(disk)
}

/// Decrypt the hidden note `note` to its `.mntl` document.
fn open_hidden(
    vault_root: &str,
    keys: &SessionKeys,
    note: &HiddenNote,
) -> Result<(Zeroizing<String>, mntl_core::MasterKey), String> {
    let mk = keys
        .get(vault_root, &note.profile)?
        .ok_or_else(|| format!("{LOCKED_ERR_PREFIX}{}", note.profile))?;
    let blob = fs::read(resolve_rel_path(vault_root, &note.disk)?).map_err(|e| format!("Failed to read note: {e}"))?;
    let document = mntl_core::decrypt_note(&mk, &blob).map_err(|e| e.to_string())?;
    let document = String::from_utf8(document.to_vec()).map_err(|_| "Decrypted note is not UTF-8".to_string())?;
    Ok((Zeroizing::new(document), mk))
}

/// Rename or move the hidden note `rel_path` to `new_rel`, resealing its
/// location and name. Its file only moves if its profile places it elsewhere
/// now — a location-only note's root file follows its new name.
pub(crate) fn relocate(vault_root: &str, keys: &SessionKeys, rel_path: &str, note: &HiddenNote, new_rel: &str) -> Result<(), String> {
    if rel_path == new_rel {
        return Ok(());
    }
    let (document, mk) = open_hidden(vault_root, keys, note)?;
    seal_at(vault_root, keys, &note.profile, &mk, new_rel, &document, Some((rel_path, &note.disk)))?;
    Ok(())
}

/// Copy the hidden note `note` to `new_rel`, under a new disk name.
pub(crate) fn copy(vault_root: &str, keys: &SessionKeys, note: &HiddenNote, new_rel: &str) -> Result<(), String> {
    let (document, mk) = open_hidden(vault_root, keys, note)?;
    seal_at(vault_root, keys, &note.profile, &mk, new_rel, &document, None)?;
    Ok(())
}

/// The unlocked hidden notes inside the folder `rel_dir`, by virtual path.
pub(crate) fn hidden_inside(vault_root: &str, keys: &SessionKeys, rel_dir: &str) -> Result<Vec<(String, HiddenNote)>, String> {
    let prefix = format!("{rel_dir}/");
    let mut inside: Vec<_> = keys
        .hidden_notes(vault_root)?
        .into_iter()
        .filter(|(rel, _)| rel.starts_with(&prefix))
        .collect();
    inside.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(inside)
}

/// Move the folder `from` to `to`, both vault-relative: its real folder, if
/// it has one, and every unlocked hidden note inside, resealed at its new
/// path. A virtual folder has only the latter.
pub(crate) fn move_folder_tree(vault_root: &str, keys: &SessionKeys, from: &str, to: &str) -> Result<(), String> {
    check_components(to)?;
    let hidden = hidden_inside(vault_root, keys, from)?;
    if resolve_rel_dir(vault_root, "")?.join(from).exists() {
        let source = resolve_rel_path(vault_root, from)?;
        create_rel_dir(vault_root, to.rsplit_once('/').map_or("", |(dir, _)| dir))?;
        let dest = resolve_rel_path(vault_root, to)?;
        fs::rename(&source, &dest).map_err(|e| format!("Failed to move folder: {e}"))?;
    } else if hidden.is_empty() {
        return Err(format!("\"{from}\" no longer exists"));
    }
    let moved = |path: &str| path.strip_prefix(from).map(|rest| format!("{to}{rest}"));
    for (rel, mut note) in hidden {
        // A file that sat in the real folder moved with it.
        if let Some(disk) = note.disk.strip_prefix(&format!("{from}/")) {
            note.disk = format!("{to}/{disk}");
        }
        keys.put_hidden(vault_root, &rel, Some(note.clone()))?;
        let new_rel = moved(&rel).ok_or("Invalid hidden note path")?;
        relocate(vault_root, keys, &rel, &note, &new_rel)?;
    }
    crate::history::follow(vault_root, from, to, crate::history::Scope::Keep, keys);
    Ok(())
}

/// Whether the folder `rel_dir` exists, really or virtually.
pub(crate) fn folder_exists(vault_root: &str, keys: &SessionKeys, rel_dir: &str) -> Result<bool, String> {
    Ok(resolve_rel_dir(vault_root, "")?.join(rel_dir).exists() || is_virtual_dir(vault_root, rel_dir, keys)?)
}

/// A note whose real path is taken, so un-hiding it needs another name.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HidingClash {
    pub rel_path: String,
    /// A free name (file stem) to un-hide it under instead.
    pub suggestion: String,
}

/// The notes of `profile_id` that turning hiding off would put on a path
/// that's taken, each with a free name to use instead. Only un-hiding can
/// clash: hiding picks a free disk name by itself.
#[tauri::command]
pub fn hiding_clashes(
    vault_root: String,
    profile_id: String,
    hide_locations: bool,
    hide_names: bool,
    keys: State<SessionKeys>,
) -> Result<Vec<HidingClash>, String> {
    logged("hiding_clashes", || {
        hiding_clashes_inner(&vault_root, &profile_id, Hiding { locations: hide_locations, names: hide_names }, &keys)
    })
}

fn hiding_clashes_inner(vault_root: &str, profile_id: &str, hiding: Hiding, keys: &SessionKeys) -> Result<Vec<HidingClash>, String> {
    if hiding.any() {
        return Ok(Vec::new());
    }
    let root = resolve_rel_dir(vault_root, "")?;
    let mut clashes = Vec::new();
    let mut notes: Vec<_> = keys.hidden_notes(vault_root)?.into_iter().filter(|(_, n)| n.profile == profile_id).collect();
    notes.sort_by(|a, b| a.0.cmp(&b.0));
    for (rel, note) in notes {
        if rel == note.disk || !root.join(&rel).exists() {
            continue;
        }
        let (dir, stem, ext) = split_rel_note_path(&rel);
        let suggestion = (2..)
            .map(|n| format!("{stem} {n}"))
            .find(|name| !taken(vault_root, &join_rel_note_path(&dir, name, ext), keys).unwrap_or(true))
            .unwrap_or_default();
        clashes.push(HidingClash { rel_path: rel, suggestion });
    }
    Ok(clashes)
}

/// What [`set_profile_hiding`] did.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HidingReport {
    /// Notes that came out under another name, to follow in tabs.
    pub renamed: Vec<CreatedNote>,
    /// The paths they had before, in the same order.
    pub renamed_from: Vec<String>,
    pub failed: Vec<HidingFailure>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HidingFailure {
    pub rel_path: String,
    pub error: String,
}

/// Change `profile_id`'s hiding settings and convert every one of its notes
/// to match. The profile must be unlocked. `renames` gives a note (by path)
/// another name to un-hide under, where its own is taken; notes in `skip`
/// are left as they are.
#[tauri::command]
pub fn set_profile_hiding(
    vault_root: String,
    profile_id: String,
    hide_locations: bool,
    hide_names: bool,
    renames: HashMap<String, String>,
    skip: Vec<String>,
    keys: State<SessionKeys>,
) -> Result<HidingReport, String> {
    logged("set_profile_hiding", || {
        let hiding = Hiding { locations: hide_locations, names: hide_names };
        set_profile_hiding_inner(&vault_root, &profile_id, hiding, &renames, &skip, &keys)
    })
}

pub(crate) fn set_profile_hiding_inner(
    vault_root: &str,
    profile_id: &str,
    hiding: Hiding,
    renames: &HashMap<String, String>,
    skip: &[String],
    keys: &SessionKeys,
) -> Result<HidingReport, String> {
    let mk = keys
        .get(vault_root, profile_id)?
        .ok_or_else(|| format!("Unlock \"{profile_id}\" before changing what it hides"))?;
    let mut registry = load_registry(vault_root)?;
    let profile = registry
        .find_mut(profile_id)
        .ok_or_else(|| format!("No credential profile \"{profile_id}\" in this vault"))?;
    profile.hide_locations = hiding.locations;
    profile.hide_names = hiding.names;
    save_registry(vault_root, &registry)?;

    let mut report = HidingReport::default();
    for (id, disk) in note_paths(vault_root, keys)? {
        if !disk.ends_with(EXT_ENCRYPTED) || skip.contains(&id) {
            continue;
        }
        let Ok(path) = resolve_rel_path(vault_root, &disk) else { continue };
        if read_header(&path).map(|h| h.credential_profile).as_deref() != Some(profile_id) {
            continue;
        }
        let mut target = String::new();
        let result = fs::read(&path)
            .map_err(|e| format!("Failed to read note: {e}"))
            .and_then(|blob| mntl_core::decrypt_note(&mk, &blob).map_err(|e| e.to_string()))
            .and_then(|document| String::from_utf8(document.to_vec()).map_err(|_| "Decrypted note is not UTF-8".to_string()))
            .and_then(|document| {
                let document = Zeroizing::new(document);
                // Listed by its disk path, a hidden note wasn't in the last
                // scan; its sealed path is still the one to keep.
                let sealed = mntl_core::extract_unencrypted_header(&document)
                    .ok()
                    .filter(|_| id == disk)
                    .and_then(|fm| Some(join_rel_note_path(&fm.location?, &fm.name?, EXT_ENCRYPTED)));
                let own = sealed.unwrap_or_else(|| id.clone());
                target = match renames.get(&own) {
                    Some(name) => join_rel_note_path(&split_rel_note_path(&own).0, name, EXT_ENCRYPTED),
                    None => own.clone(),
                };
                seal_at(vault_root, keys, profile_id, &mk, &target, &document, Some((&own, &disk)))
            });
        match result {
            Ok(_) if target != id => {
                report.renamed.push(CreatedNote { name: crate::vault::note_display_name(&target), rel_path: target });
                report.renamed_from.push(id);
            }
            Ok(_) => {}
            Err(error) => report.failed.push(HidingFailure { rel_path: id, error }),
        }
    }
    Ok(report)
}

/// The absolute path of the file the note `rel_path` is stored in, for
/// "Show in File Explorer": a hidden note's random or root file.
#[tauri::command]
pub fn note_disk_path(vault_root: String, rel_path: String, keys: State<SessionKeys>) -> Result<String, String> {
    logged("note_disk_path", || {
        let path = resolve_note(&vault_root, &rel_path, &keys)?;
        let text = path.to_string_lossy();
        Ok(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialProfile, ProfileRegistry};
    use crate::vault::{copy_note_inner, read_note_inner, rename_note_inner, scan_vault_inner, write_note_inner, VaultNode};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-hidden-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(id: &str) -> CredentialProfile {
        CredentialProfile {
            id: id.into(),
            display_name: id.into(),
            salt: String::new(),
            kdf: Default::default(),
            wrapped_master_key: String::new(),
            verifier: String::new(),
            hide_locations: false,
            hide_names: false,
        }
    }

    fn seal(root: &std::path::Path, rel: &str, profile: &str, mk: &mntl_core::MasterKey) {
        let document = mntl_core::encode_unencrypted_note("Body").unwrap();
        fs::write(root.join(rel), mntl_core::encrypt_note(mk, profile, document.as_bytes()).unwrap()).unwrap();
    }

    /// `(relPath, hidden)` of every note in the tree, and the root's locked counts.
    fn listing(root: &str, keys: &SessionKeys) -> (Vec<(String, bool)>, std::collections::BTreeMap<String, usize>) {
        fn walk(nodes: &[VaultNode], out: &mut Vec<(String, bool)>) {
            for node in nodes {
                match node {
                    VaultNode::Folder { children, .. } => walk(children, out),
                    VaultNode::Note { rel_path, hidden, .. } => out.push((rel_path.clone(), *hidden)),
                    VaultNode::File { .. } => {}
                }
            }
        }
        let VaultNode::Folder { children, locked_hidden, .. } = scan_vault_inner(root, keys).unwrap() else { panic!() };
        let mut out = Vec::new();
        walk(&children, &mut out);
        (out, locked_hidden)
    }

    fn files(root: &std::path::Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn hiding_a_profile_seals_paths_and_unhiding_puts_them_back() {
        let dir = temp_dir("round-trip");
        let root = dir.to_string_lossy().into_owned();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let other = mntl_core::MasterKey::generate().unwrap();
        let mut registry = ProfileRegistry::default();
        registry.profiles.push(profile("diary"));
        registry.profiles.push(profile("other"));
        save_registry(&root, &registry).unwrap();
        fs::create_dir(dir.join("Journal")).unwrap();
        seal(&dir, "Journal/Ideas.mntl.enc", "diary", &mk);
        let keys = SessionKeys::default();
        keys.unlock_for_test(&root, "diary", mk.clone()).unwrap();
        keys.unlock_for_test(&root, "other", other.clone()).unwrap();
        listing(&root, &keys);

        // Hiding both: the file goes to the root under a random name, and the
        // folder it left is removed.
        let both = Hiding { locations: true, names: true };
        set_profile_hiding_inner(&root, "diary", both, &HashMap::new(), &[], &keys).unwrap();
        let on_disk = files(&dir);
        assert_eq!(on_disk.len(), 1);
        assert!(is_random_stem(on_disk[0].trim_end_matches(EXT_ENCRYPTED)), "{on_disk:?}");
        assert!(read_header(&dir.join(&on_disk[0])).unwrap().hidden);

        // Unlocked, it's listed (and read and saved) at its real path; locked, only counted.
        assert_eq!(listing(&root, &keys).0, [("Journal/Ideas.mntl.enc".to_string(), true)]);
        write_note_inner(&root, "Journal/Ideas.mntl.enc", "Edited", &[], None, &keys).unwrap();
        assert_eq!(read_note_inner(&root, "Journal/Ideas.mntl.enc", &keys).unwrap().content, "Edited");
        assert!(read_header(&dir.join(&on_disk[0])).unwrap().hidden, "a save keeps it hidden");
        let locked = SessionKeys::default();
        let (notes, counts) = listing(&root, &locked);
        assert!(notes.is_empty());
        assert_eq!(counts.get("diary"), Some(&1));

        // Renaming reseals in place; duplicating gets a new random file.
        rename_note_inner(&root, "Journal/Ideas.mntl.enc", "Plans", &keys).unwrap();
        assert_eq!(files(&dir), on_disk);
        copy_note_inner(&root, "Journal/Plans.mntl.enc", "Journal", true, &keys).unwrap();
        assert_eq!(files(&dir).len(), 2);

        // Locations only: real names, in the root.
        let locations = Hiding { locations: true, names: false };
        set_profile_hiding_inner(&root, "diary", locations, &HashMap::new(), &[], &keys).unwrap();
        assert_eq!(files(&dir), ["Plans copy.mntl.enc", "Plans.mntl.enc"]);

        // Another note now holds the real path, so the hidden one is listed as "(2)"…
        fs::create_dir(dir.join("Journal")).unwrap();
        seal(&dir, "Journal/Plans.mntl.enc", "other", &other);
        let mut listed = listing(&root, &keys).0;
        listed.sort();
        assert_eq!(
            listed,
            [
                ("Journal/Plans (2).mntl.enc".to_string(), true),
                ("Journal/Plans copy.mntl.enc".to_string(), true),
                ("Journal/Plans.mntl.enc".to_string(), false),
            ]
        );

        // …and un-hiding puts it there, next to the other.
        assert!(hiding_clashes_inner(&root, "diary", Hiding::default(), &keys).unwrap().is_empty());
        let report = set_profile_hiding_inner(&root, "diary", Hiding::default(), &HashMap::new(), &[], &keys).unwrap();
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(files(&dir), ["Journal"]);
        let mut journal = files(&dir.join("Journal"));
        journal.sort();
        assert_eq!(journal, ["Plans (2).mntl.enc", "Plans copy.mntl.enc", "Plans.mntl.enc"]);
        assert!(!read_header(&dir.join("Journal/Plans (2).mntl.enc")).unwrap().hidden);
        assert!(listing(&root, &keys).0.iter().all(|(_, hidden)| !hidden));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn placement_follows_the_settings() {
        let none = Hiding::default();
        let locations = Hiding { locations: true, names: false };
        let names = Hiding { locations: false, names: true };
        let both = Hiding { locations: true, names: true };
        let random = format!("{}.mntl.enc", random_stem());

        assert!(placed(none, "Work/Ideas.mntl.enc", "Work/Ideas.mntl.enc"));
        assert!(!placed(none, "Work/Ideas.mntl.enc", &random));
        assert!(placed(locations, "Work/Ideas.mntl.enc", "Ideas.mntl.enc"));
        assert!(placed(locations, "Work/Ideas.mntl.enc", "Ideas (3).mntl.enc"));
        assert!(!placed(locations, "Work/Ideas.mntl.enc", "Work/Ideas.mntl.enc"));
        assert!(!placed(locations, "Work/Ideas.mntl.enc", "Other.mntl.enc"));
        assert!(placed(names, "Work/Ideas.mntl.enc", &format!("Work/{random}")));
        assert!(!placed(names, "Work/Ideas.mntl.enc", &random));
        assert!(placed(both, "Work/Ideas.mntl.enc", &random));
        assert!(!placed(both, "Work/Ideas.mntl.enc", "Ideas.mntl.enc"));
    }
}
