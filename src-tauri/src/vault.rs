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
//! operations never look at a note's contents. The exception is a hidden note
//! (see [`crate::hidden`]), whose path is sealed inside it: a scan only lists
//! it while its profile is unlocked, and moving it means resealing it.

use crate::attachments::{reseal_attachments, Relink};
use crate::credentials::{HiddenNote, SessionKeys};
use crate::hidden::{self, resolve_note};
use crate::logging::logged;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
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

/// Whether `filename` is a note file: `.mntl`, `.mntl.enc` or Markdown.
pub(crate) fn is_note_file(filename: &str) -> bool {
    classify_note_file(filename).is_some()
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
        modified: u64,
        created: u64,
        /// A folder with no folder on disk, there only because hidden notes
        /// are sealed as being in it.
        #[serde(rename = "virtual", skip_serializing_if = "std::ops::Not::not")]
        is_virtual: bool,
        /// On the vault root only: how many hidden notes each locked profile
        /// has, which the tree can't list.
        #[serde(skip_serializing_if = "BTreeMap::is_empty")]
        locked_hidden: BTreeMap<String, usize>,
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
        /// The note's tags, or `None` if they can't be read right now: an
        /// encrypted note whose profile is locked (its tags are sealed inside
        /// the ciphertext), or a file that can't be read or parsed.
        tags: Option<Vec<String>>,
        /// The targets of the note's `[[wikilinks]]`, as written (without any
        /// `#heading` or `|alias`), or `None` when they can't be read right
        /// now, as for `tags`.
        links: Option<Vec<String>>,
        /// Whether this encrypted note is a favorite, sealed in its
        /// frontmatter. Always false for a locked note and for plaintext
        /// notes, whose favorites live in `.mantle/state.json`.
        favorite: bool,
        /// A sealed icon and color, known only while the profile is unlocked;
        /// a plaintext note's live in `.mantle/state.json`.
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        /// Last modified, in milliseconds since the Unix epoch (0 if unknown).
        modified: u64,
        /// Created, in milliseconds since the Unix epoch (0 where the file system doesn't record it).
        created: u64,
        /// Whether this note is hidden: listed at the path sealed inside it,
        /// which isn't where its file is.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        hidden: bool,
    },
    /// Any other file — an image, a PDF — kept in the vault by the user.
    #[serde(rename_all = "camelCase")]
    File { name: String, rel_path: String, modified: u64, created: u64 },
}

/// A file's modified and created times, in milliseconds since the Unix epoch; 0 for either one that's unknown.
fn file_times(meta: std::io::Result<fs::Metadata>) -> (u64, u64) {
    let millis = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64)
    };
    meta.map_or((0, 0), |meta| (millis(meta.modified()), millis(meta.created())))
}

fn node_name(node: &VaultNode) -> &str {
    match node {
        VaultNode::Folder { name, .. } | VaultNode::Note { name, .. } | VaultNode::File { name, .. } => name,
    }
}

fn node_rel_path(node: &VaultNode) -> &str {
    match node {
        VaultNode::Folder { rel_path, .. } | VaultNode::Note { rel_path, .. } | VaultNode::File { rel_path, .. } => rel_path,
    }
}

fn node_times(node: &VaultNode) -> (u64, u64) {
    match node {
        VaultNode::Folder { modified, created, .. }
        | VaultNode::Note { modified, created, .. }
        | VaultNode::File { modified, created, .. } => (*modified, *created),
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
pub(crate) fn read_profile_id(path: &Path) -> Option<String> {
    read_header(path).map(|h| h.credential_profile)
}

/// The header of the `.mntl.enc` file at `path`, or `None` if it's malformed,
/// as for [`read_profile_id`].
pub(crate) fn read_header(path: &Path) -> Option<mntl_core::EncryptedHeader> {
    mntl_core::extract_encrypted_header(&read_header_prefix(path).ok()?).ok()
}

/// What a vault scan reads of a note: its tags and wikilink targets, and
/// whether it's a sealed favorite.
#[derive(Default)]
struct NoteInfo {
    tags: Option<Vec<String>>,
    links: Option<Vec<String>>,
    favorite: bool,
    icon: Option<String>,
    color: Option<String>,
}

/// The [`NoteInfo`] of the note at `path`: read from a plaintext note, or by
/// decrypting an encrypted one whose profile is unlocked. Tags and links are
/// `None` when they can't be known right now; like [`read_profile_id`], a
/// scan never fails over one unreadable note.
// ponytail: reads every note whole on every scan, for its links; keep a link
// index if big vaults scan slowly.
fn read_note_info(path: &Path, file_name: &str, profile: Option<&str>, vault_root: &str, keys: &SessionKeys) -> NoteInfo {
    if file_name.ends_with(EXT_ENCRYPTED) {
        return read_sealed_note(path, profile, vault_root, keys).map_or_else(NoteInfo::default, |(h, links)| NoteInfo {
            tags: Some(h.tags),
            links: Some(links),
            favorite: h.favorite,
            icon: h.icon,
            color: h.color,
        });
    }
    let Ok(raw) = fs::read_to_string(path) else { return NoteInfo::default() };
    if is_markdown_note(file_name) {
        let (_, body) = mntl_core::split_markdown_frontmatter(&raw);
        return NoteInfo { tags: Some(mntl_core::markdown_tags(&raw)), links: Some(wikilink_targets(body)), ..NoteInfo::default() };
    }
    mntl_core::decode_note(&raw).map_or_else(
        |_| NoteInfo::default(),
        |(h, body)| NoteInfo { tags: Some(h.tags), links: Some(wikilink_targets(&body)), ..NoteInfo::default() },
    )
}

/// The distinct targets of the `[[wikilinks]]` in `body`, outside code.
pub(crate) fn wikilink_targets(body: &str) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for source in crate::attachments::link_sources(body).into_iter().filter(|s| s.wiki) {
        let target = body[source.range].trim();
        if !target.is_empty() && !targets.iter().any(|t| t == target) {
            targets.push(target.to_string());
        }
    }
    targets
}

/// Decrypt the `.mntl.enc` at `path` if its profile is unlocked, for its
/// frontmatter and wikilink targets.
fn read_sealed_note(
    path: &Path,
    profile: Option<&str>,
    vault_root: &str,
    keys: &SessionKeys,
) -> Option<(mntl_core::NoteFrontmatter, Vec<String>)> {
    let mk = keys.get(vault_root, profile?).ok()??;
    let blob = fs::read(path).ok()?;
    let document = mntl_core::decrypt_note(&mk, &blob).ok()?;
    let document = std::str::from_utf8(&document).ok()?;
    let (frontmatter, body) = mntl_core::decode_note(document).ok()?;
    let links = wikilink_targets(&body);
    Some((frontmatter, links))
}

/// The hidden notes a scan came across, which it lists at their sealed path
/// rather than where their files are.
#[derive(Default)]
struct HiddenScan {
    /// Those of unlocked profiles: disk path, profile, sealed frontmatter, links and times.
    open: Vec<(String, String, mntl_core::NoteFrontmatter, Vec<String>, u64, u64)>,
    /// How many each locked profile has.
    locked: BTreeMap<String, usize>,
    /// Every hidden note's disk path, which no listed path may take.
    disk: HashSet<String>,
}

fn scan_dir(
    abs_dir: &Path,
    rel_dir: &Path,
    vault_root: &str,
    keys: &SessionKeys,
    hidden: &mut HiddenScan,
) -> std::io::Result<Vec<VaultNode>> {
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

        // Mantle's own attachment store: its files are reached through the
        // notes that show them, not browsed.
        if file_type.is_dir() && rel_dir.as_os_str().is_empty() && name == crate::attachments::ATTACHMENTS_DIR {
            continue;
        }
        let (modified, created) = file_times(entry.metadata());
        if file_type.is_dir() {
            let children = scan_dir(&entry.path(), &child_rel, vault_root, keys, hidden)?;
            folders.push(VaultNode::Folder {
                name,
                rel_path: to_slash(&child_rel),
                children,
                modified,
                created,
                is_virtual: false,
                locked_hidden: BTreeMap::new(),
            });
        } else if file_type.is_file() {
            if let Some((title, encrypted)) = classify_note_file(&name) {
                let header = if encrypted { read_header(&entry.path()) } else { None };
                let profile = header.as_ref().map(|h| h.credential_profile.clone());
                if let Some(profile) = profile.clone().filter(|_| header.as_ref().is_some_and(|h| h.hidden)) {
                    let rel = to_slash(&child_rel);
                    match read_sealed_note(&entry.path(), Some(&profile), vault_root, keys) {
                        Some((frontmatter, links)) => {
                            hidden.open.push((rel.clone(), profile, frontmatter, links, modified, created))
                        }
                        None => *hidden.locked.entry(profile).or_default() += 1,
                    }
                    hidden.disk.insert(rel);
                    continue;
                }
                let NoteInfo { tags, links, favorite, icon, color } =
                    read_note_info(&entry.path(), &name, profile.as_deref(), vault_root, keys);
                notes.push(VaultNode::Note {
                    name: title,
                    rel_path: to_slash(&child_rel),
                    encrypted,
                    profile,
                    tags,
                    links,
                    favorite,
                    icon,
                    color,
                    modified,
                    created,
                    hidden: false,
                });
            } else {
                notes.push(VaultNode::File { name, rel_path: to_slash(&child_rel), modified, created });
            }
        }
    }

    folders.extend(notes);
    sort_nodes(&mut folders);
    Ok(folders)
}

/// Folders first, then everything else, each by name.
fn sort_nodes(nodes: &mut [VaultNode]) {
    nodes.sort_by(|a, b| {
        let folder = |n: &VaultNode| matches!(n, VaultNode::Folder { .. });
        folder(b).cmp(&folder(a)).then_with(|| node_name(a).cmp(node_name(b)))
    });
}

/// Put each unlocked hidden note into `root` (the vault root's children) at
/// its sealed location under its sealed name, adding virtual folders on the
/// way. A path that's already taken gets " (2)", " (3)"… in the tree only;
/// renaming the note fixes it. Returns where each one's file really is, by
/// the path it was listed at.
fn insert_hidden(root: &mut Vec<VaultNode>, hidden: HiddenScan) -> HashMap<String, HiddenNote> {
    let mut map = HashMap::new();
    let mut open = hidden.open;
    open.sort_by(|a, b| a.0.cmp(&b.0));
    for (disk, profile, frontmatter, links, modified, created) in open {
        let (_, disk_stem, _) = split_rel_note_path(&disk);
        let location = frontmatter
            .location
            .clone()
            .filter(|l| l.is_empty() || hidden::check_components(l).is_ok())
            .unwrap_or_default();
        let name = frontmatter
            .name
            .clone()
            .filter(|n| !n.is_empty() && !n.contains(['/', '\\', ':']))
            .unwrap_or(disk_stem);

        let mut folder = &mut *root;
        let mut rel_dir = String::new();
        for part in location.split('/').filter(|p| !p.is_empty()) {
            rel_dir = if rel_dir.is_empty() { part.to_string() } else { format!("{rel_dir}/{part}") };
            let index = match folder.iter().position(|n| matches!(n, VaultNode::Folder { name, .. } if name == part)) {
                Some(index) => index,
                None => {
                    folder.push(VaultNode::Folder {
                        name: part.to_string(),
                        rel_path: rel_dir.clone(),
                        children: Vec::new(),
                        modified: 0,
                        created: 0,
                        is_virtual: true,
                        locked_hidden: BTreeMap::new(),
                    });
                    folder.len() - 1
                }
            };
            folder = match &mut folder[index] {
                VaultNode::Folder { children, .. } => children,
                _ => unreachable!(),
            };
        }

        let taken = |rel: &str| {
            folder.iter().any(|n| node_rel_path(n) == rel) || (rel != disk && hidden.disk.contains(rel))
        };
        let (mut title, mut rel) = (name.clone(), join_rel_note_path(&rel_dir, &name, EXT_ENCRYPTED));
        let mut n = 1;
        while taken(&rel) {
            n += 1;
            title = format!("{name} ({n})");
            rel = join_rel_note_path(&rel_dir, &title, EXT_ENCRYPTED);
        }
        folder.push(VaultNode::Note {
            name: title,
            rel_path: rel.clone(),
            encrypted: true,
            profile: Some(profile.clone()),
            tags: Some(frontmatter.tags),
            links: Some(links),
            favorite: frontmatter.favorite,
            icon: frontmatter.icon,
            color: frontmatter.color,
            modified,
            created,
            hidden: true,
        });
        map.insert(rel, HiddenNote { disk, profile });
    }
    settle(root);
    map
}

/// Sort every folder again after [`insert_hidden`], giving each virtual
/// folder its newest child's times. Returns the newest times among `nodes`.
fn settle(nodes: &mut [VaultNode]) -> (u64, u64) {
    for node in nodes.iter_mut() {
        if let VaultNode::Folder { children, modified, created, is_virtual, .. } = node {
            let newest = settle(children);
            if *is_virtual {
                (*modified, *created) = newest;
            }
        }
    }
    sort_nodes(nodes);
    nodes.iter().map(node_times).fold((0, 0), |(m, c), (nm, nc)| (m.max(nm), c.max(nc)))
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
        check_new_vault_path(&dir)?;
        fs::create_dir(&dir).map_err(|e| format!("Failed to create vault folder: {e}"))?;
        crate::vault_meta::write_vault_meta(&path, &crate::vault_meta::VaultMeta::default())?;
        Ok(path)
    })
}

/// A folder in [`list_folders`]' listing.
#[derive(Serialize)]
pub struct FolderEntry {
    name: String,
    /// Holds a `.mantle/` folder: a vault Mantle has opened before.
    vault: bool,
}

/// The visible subfolders of the absolute directory `path`, by name, for the
/// in-app folder browser that stands in for a native folder dialog on Android.
#[tauri::command]
pub fn list_folders(path: String) -> Result<Vec<FolderEntry>, String> {
    logged("list_folders", || {
        let mut folders: Vec<FolderEntry> = fs::read_dir(&path)
            .map_err(|e| format!("Failed to read folder: {e}"))?
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.starts_with('.'))
            .map(|name| FolderEntry { vault: Path::new(&path).join(&name).join(".mantle").is_dir(), name })
            .collect();
        folders.sort_by_key(|f| f.name.to_lowercase());
        Ok(folders)
    })
}

/// Renames or moves the vault directory `from` to `to`, returning `to`.
///
/// `to` is checked like a new vault's path: its parent must exist and it must
/// not. A plain `fs::rename`, so moving to another drive fails rather than
/// copying.
#[tauri::command]
pub fn move_vault(from: String, to: String) -> Result<String, String> {
    logged("move_vault", || {
        if !Path::new(&from).is_dir() {
            return Err("The vault folder no longer exists".to_string());
        }
        check_new_vault_path(Path::new(&to))?;
        fs::rename(&from, &to).map_err(|e| format!("Failed to move vault folder: {e}"))?;
        Ok(to)
    })
}

/// Checks that `dir` is a valid place for a vault folder that doesn't exist yet.
fn check_new_vault_path(dir: &Path) -> Result<(), String> {
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid vault name")?;
    if name.is_empty() || name.contains(':') || name.starts_with('.') {
        return Err("Invalid vault name".to_string());
    }
    let parent = dir.parent().filter(|p| !p.as_os_str().is_empty()).ok_or("Invalid vault location")?;
    if !parent.is_dir() {
        return Err("The folder to put the vault in does not exist".to_string());
    }
    if dir.exists() {
        return Err(format!("A file or folder named \"{name}\" already exists in this location"));
    }
    Ok(())
}

/// Lists the vault's folders and notes, with each note's tags.
///
/// Reading tags means decrypting every note of every unlocked profile, so the
/// frontend rescans when a profile is unlocked or locked, to add or drop them.
#[tauri::command]
pub fn scan_vault(vault_root: String, keys: State<SessionKeys>) -> Result<VaultNode, String> {
    logged("scan_vault", || scan_vault_inner(&vault_root, &keys))
}

pub(crate) fn scan_vault_inner(vault_root: &str, keys: &SessionKeys) -> Result<VaultNode, String> {
    let root = PathBuf::from(vault_root);
    if !root.is_dir() {
        return Err(format!(
            "Vault root does not exist or is not a directory: {vault_root}"
        ));
    }
    let mut hidden = HiddenScan::default();
    let mut children =
        scan_dir(&root, Path::new(""), vault_root, keys, &mut hidden).map_err(|e| e.to_string())?;
    let locked_hidden = std::mem::take(&mut hidden.locked);
    keys.set_hidden(vault_root, insert_hidden(&mut children, hidden))?;
    Ok(VaultNode::Folder {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        rel_path: String::new(),
        children,
        modified: 0,
        created: 0,
        is_virtual: false,
        locked_hidden,
    })
}

/// Every note in the vault, skipping hidden folders as a scan does — without
/// reading any of them. Each comes as the path the frontend knows it by (a
/// hidden note's virtual path, while its profile is unlocked) and the
/// vault-relative path of its file.
pub(crate) fn note_paths(vault_root: &str, keys: &SessionKeys) -> Result<Vec<(String, String)>, String> {
    fn walk(dir: &Path, rel_dir: &str, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
            match entry.file_type() {
                Ok(t) if t.is_dir() => walk(&entry.path(), &rel, out),
                Ok(t) if t.is_file() && classify_note_file(&name).is_some() => out.push(rel),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(&resolve_rel_dir(vault_root, "")?, "", &mut out);
    let by_disk: HashMap<String, String> =
        keys.hidden_notes(vault_root)?.into_iter().map(|(rel, note)| (note.disk, rel)).collect();
    Ok(out
        .into_iter()
        .map(|disk| (by_disk.get(&disk).cloned().unwrap_or_else(|| disk.clone()), disk))
        .collect())
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

/// A note as the editor sees it: its Markdown body, its tags and its other
/// properties.
#[derive(Serialize, Debug, PartialEq)]
pub struct NoteDocument {
    pub content: String,
    pub tags: Vec<String>,
    /// `None` for a Markdown file whose frontmatter can't be read, which is
    /// then left as it is.
    pub properties: Option<Vec<NoteProperty>>,
}

/// One of a note's properties, with its value as JSON for the editor.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct NoteProperty {
    pub key: String,
    pub value: serde_json::Value,
}

/// YAML properties as the editor sees them. A value JSON can't hold (a map
/// with non-string keys, say) is left out, so it's never rewritten either.
// ponytail: such a value is hidden rather than shown read-only; show its raw YAML if anyone has one.
fn json_properties(pairs: impl IntoIterator<Item = (String, serde_yaml::Value)>) -> Vec<NoteProperty> {
    pairs
        .into_iter()
        .filter_map(|(key, value)| Some(NoteProperty { key, value: serde_json::to_value(value).ok()? }))
        .collect()
}

fn mapping_properties(map: &serde_yaml::Mapping) -> Vec<NoteProperty> {
    json_properties(map.iter().filter_map(|(key, value)| Some((key.as_str()?.to_string(), value.clone()))))
}

fn yaml_value(value: &serde_json::Value) -> serde_yaml::Value {
    serde_yaml::to_value(value).unwrap_or(serde_yaml::Value::Null)
}

fn properties_mapping(properties: &[NoteProperty]) -> serde_yaml::Mapping {
    properties.iter().map(|p| (p.key.clone().into(), yaml_value(&p.value))).collect()
}

/// Whether two property values are the same, counting `1` and `1.0` as
/// equal: a number makes the round trip through JavaScript without its
/// `.0`, and that alone mustn't make a save rewrite the line.
fn same_json(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value::*;
    match (a, b) {
        (Number(x), Number(y)) => x == y || x.as_f64() == y.as_f64(),
        (Array(x), Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same_json(x, y)),
        (Object(x), Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w)))
        }
        _ => a == b,
    }
}

/// Properties as the frontend sent them, minus blank names, repeats and
/// `tags`, which has its own field.
fn clean_properties(properties: &[NoteProperty]) -> Vec<NoteProperty> {
    let mut seen = std::collections::HashSet::new();
    properties
        .iter()
        .filter(|p| !p.key.trim().is_empty() && p.key != "tags" && seen.insert(p.key.clone()))
        .cloned()
        .collect()
}

#[tauri::command]
pub fn read_note(
    vault_root: String,
    rel_path: String,
    keys: State<SessionKeys>,
) -> Result<NoteDocument, String> {
    logged("read_note", || read_note_inner(&vault_root, &rel_path, &keys))
}

pub(crate) fn read_note_inner(
    vault_root: &str,
    rel_path: &str,
    keys: &SessionKeys,
) -> Result<NoteDocument, String> {
    let path = resolve_note(vault_root, rel_path, keys)?;

    if rel_path.ends_with(EXT_ENCRYPTED) {
        let bytes = fs::read(&path).map_err(|e| format!("Failed to read note: {e}"))?;
        let (_, mk) = master_key_for(vault_root, &bytes, keys)?;
        let document = mntl_core::decrypt_note(&mk, &bytes).map_err(|e| e.to_string())?;
        let document =
            std::str::from_utf8(&document).map_err(|_| "Decrypted note is not UTF-8".to_string())?;
        let (frontmatter, content) = mntl_core::decode_note(document).map_err(|e| e.to_string())?;
        let properties = Some(mapping_properties(&frontmatter.properties));
        return Ok(NoteDocument { content, tags: frontmatter.tags, properties });
    }

    let raw = fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {e}"))?;
    if is_markdown_note(rel_path) {
        // The frontmatter is another tool's; `write_note_inner` puts it back.
        let (_, body) = mntl_core::split_markdown_frontmatter(&raw);
        return Ok(NoteDocument {
            content: body.to_string(),
            tags: mntl_core::markdown_tags(&raw),
            properties: mntl_core::markdown_properties(&raw).map(json_properties),
        });
    }
    let (frontmatter, content) = mntl_core::decode_note(&raw).map_err(|e| e.to_string())?;
    let properties = Some(mapping_properties(&frontmatter.properties));
    Ok(NoteDocument { content, tags: frontmatter.tags, properties })
}

/// Saves a note, returning each attachment source it re-pointed (see
/// [`write_note_inner`]) with its new one, for the editor to follow.
#[tauri::command]
pub fn write_note(
    vault_root: String,
    rel_path: String,
    content: String,
    tags: Vec<String>,
    properties: Option<Vec<NoteProperty>>,
    keys: State<SessionKeys>,
) -> Result<HashMap<String, String>, String> {
    logged("write_note", || {
        write_note_inner(&vault_root, &rel_path, &content, &tags, properties.as_deref(), &keys)
    })
}

/// Save a note's body, tags and properties. `tags` and `properties` replace
/// the note's own wholesale, the same way `content` replaces its body;
/// `properties` of `None` leaves them as they are.
///
/// An attachment the note shows that belongs elsewhere — pasted in from a
/// note of another profile, or a plaintext one into an encrypted note — is
/// copied to belong to this note's profile first, and the link re-pointed
/// (see [`reseal_attachments`]).
pub(crate) fn write_note_inner(
    vault_root: &str,
    rel_path: &str,
    content: &str,
    tags: &[String],
    properties: Option<&[NoteProperty]>,
    keys: &SessionKeys,
) -> Result<HashMap<String, String>, String> {
    let path = resolve_note(vault_root, rel_path, keys)?;
    let tags = clean_tags(tags);
    let properties = properties.map(clean_properties);

    if rel_path.ends_with(EXT_ENCRYPTED) {
        let (profile_id, mk) = master_key_for(vault_root, &read_header_prefix(&path)?, keys)?;
        let (content, relinked, _) =
            reseal_attachments(vault_root, rel_path, content, Some((&profile_id, &mk)), keys, Relink::Save)?;
        // Decrypting the old version, not just reading its header, is what
        // keeps the note's sealed favorite flag across a save.
        reseal_note(vault_root, &path, keys, |frontmatter, body| {
            frontmatter.tags = tags;
            if let Some(properties) = &properties {
                frontmatter.properties = properties_mapping(properties);
            }
            *body = content.to_string();
        })?;
        crate::history::record_quietly(vault_root, rel_path, &content, Some((&profile_id, &mk)));
        return Ok(relinked);
    }

    let (content, relinked, _) = reseal_attachments(vault_root, rel_path, content, None, keys, Relink::Save)?;
    let content = content.as_str();

    if is_markdown_note(rel_path) {
        // Keep whatever frontmatter is on disk *now*, byte for byte, rather
        // than a copy from when the note was read: another tool may have
        // changed it since, and the editor never shows it. Only the tags are
        // Mantle's to change, and only when they actually differ, so saving
        // an untouched file never reformats its `tags:` lines.
        let existing = fs::read_to_string(&path).unwrap_or_default();
        let (frontmatter, _) = mntl_core::split_markdown_frontmatter(&existing);
        let mut updated = format!("{frontmatter}{content}");
        if mntl_core::markdown_tags(&existing) != tags {
            updated = mntl_core::set_markdown_tags(&updated, &tags);
        }
        // The same goes for each property: only keys that differ are
        // rewritten, and frontmatter that can't be read is left alone.
        let on_disk = mntl_core::markdown_properties(&existing).map(json_properties);
        if let (Some(properties), Some(on_disk)) = (&properties, on_disk) {
            for old in on_disk.iter().filter(|old| !properties.iter().any(|p| p.key == old.key)) {
                updated = mntl_core::set_markdown_property(&updated, &old.key, None);
            }
            for p in properties {
                if !on_disk.iter().any(|old| old.key == p.key && same_json(&old.value, &p.value)) {
                    updated = mntl_core::set_markdown_property(&updated, &p.key, Some(&yaml_value(&p.value)));
                }
            }
        }
        crate::watcher::suppress(&path);
        fs::write(&path, updated).map_err(|e| format!("Failed to write note: {e}"))?;
        crate::history::record_quietly(vault_root, rel_path, content, None);
        return Ok(relinked);
    }

    let properties = match &properties {
        Some(properties) => properties_mapping(properties),
        None => fs::read_to_string(&path)
            .ok()
            .and_then(|raw| mntl_core::extract_unencrypted_header(&raw).ok())
            .map(|header| header.properties)
            .unwrap_or_default(),
    };
    let frontmatter = mntl_core::NoteFrontmatter { tags, properties, ..Default::default() };
    let encoded = mntl_core::encode_note(&frontmatter, content).map_err(|e| e.to_string())?;
    crate::watcher::suppress(&path);
    fs::write(&path, encoded).map_err(|e| format!("Failed to write note: {e}"))?;
    crate::history::record_quietly(vault_root, rel_path, content, None);
    Ok(relinked)
}

/// Serializes read-modify-write cycles on encrypted notes, so a save and a
/// favorite toggle on the same note can't each overwrite the other's change.
// ponytail: one vault-wide lock; per-note locks if saves ever contend.
static RESEAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Decrypt the encrypted note at `path`, let `edit` change its frontmatter
/// and body, and seal the result again under the profile the file already
/// names.
///
/// A write never re-homes a note to a different profile — that is
/// `notes_crypto::move_note_to_profile`'s job, and it has to re-encrypt
/// rather than just relabel, since the header is the AAD.
fn reseal_note(
    vault_root: &str,
    path: &Path,
    keys: &SessionKeys,
    edit: impl FnOnce(&mut mntl_core::NoteFrontmatter, &mut String),
) -> Result<(), String> {
    let _guard = RESEAL_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let blob = fs::read(path).map_err(|e| format!("Failed to read note: {e}"))?;
    let (profile_id, mk) = master_key_for(vault_root, &blob, keys)?;
    let hidden = sealed_hidden(&blob);
    let document = mntl_core::decrypt_note(&mk, &blob).map_err(|e| e.to_string())?;
    let document =
        std::str::from_utf8(&document).map_err(|_| "Decrypted note is not UTF-8".to_string())?;
    let (mut frontmatter, body) = mntl_core::decode_note(document).map_err(|e| e.to_string())?;
    let mut body = zeroize::Zeroizing::new(body);
    edit(&mut frontmatter, &mut body);
    let encoded = zeroize::Zeroizing::new(
        mntl_core::encode_note(&frontmatter, &body).map_err(|e| e.to_string())?,
    );
    // `encrypt_note` generates a fresh content key and nonce on every call,
    // so nothing from the previous version of the file is reused.
    let blob = mntl_core::encrypt_note_as(&mk, &profile_id, hidden, encoded.as_bytes())
        .map_err(|e| e.to_string())?;
    write_atomic(path, &blob)
}

/// Whether the `.mntl.enc` blob's header says the note is hidden, so a
/// rewrite in place can say so again.
pub(crate) fn sealed_hidden(blob: &[u8]) -> bool {
    mntl_core::extract_encrypted_header(blob).is_ok_and(|h| h.hidden)
}

/// Mark an encrypted note as a favorite, or not. The flag is sealed in the
/// note itself, so a locked vault doesn't reveal which notes are favorites.
#[tauri::command]
pub fn set_note_favorite(
    vault_root: String,
    rel_path: String,
    favorite: bool,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    logged("set_note_favorite", || {
        set_note_favorite_inner(&vault_root, &rel_path, favorite, &keys)
    })
}

pub(crate) fn set_note_favorite_inner(
    vault_root: &str,
    rel_path: &str,
    favorite: bool,
    keys: &SessionKeys,
) -> Result<(), String> {
    if !rel_path.ends_with(EXT_ENCRYPTED) {
        return Err("Only an encrypted note keeps its favorite in the note".to_string());
    }
    let path = resolve_note(vault_root, rel_path, keys)?;
    reseal_note(vault_root, &path, keys, |frontmatter, _| frontmatter.favorite = favorite)
}

/// Set (or clear, with `None`) an encrypted note's sealed icon and color.
#[tauri::command]
pub fn set_note_style(
    vault_root: String,
    rel_path: String,
    icon: Option<String>,
    color: Option<String>,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    logged("set_note_style", || set_note_style_inner(&vault_root, &rel_path, icon, color, &keys))
}

fn set_note_style_inner(
    vault_root: &str,
    rel_path: &str,
    icon: Option<String>,
    color: Option<String>,
    keys: &SessionKeys,
) -> Result<(), String> {
    if !rel_path.ends_with(EXT_ENCRYPTED) {
        return Err("Only an encrypted note keeps its style in the note".to_string());
    }
    let path = resolve_note(vault_root, rel_path, keys)?;
    reseal_note(vault_root, &path, keys, |frontmatter, _| {
        frontmatter.icon = icon;
        frontmatter.color = color;
    })
}

/// Tags as the frontend sent them, minus blanks and case-insensitive
/// duplicates. Deliberately not held to [`mntl_core::normalize_tag`]: a tag
/// another tool wrote into a Markdown file has to survive a save unchanged.
pub(crate) fn clean_tags(tags: &[String]) -> Vec<String> {
    mntl_core::dedupe_tags(
        tags.iter()
            .map(|tag| tag.trim())
            .filter(|tag| !tag.is_empty())
            .map(str::to_string),
    )
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
pub fn create_note(
    vault_root: String,
    rel_dir: String,
    name: String,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("create_note", || {
        if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains(':') {
            return Err("Invalid note name".to_string());
        }
        hidden::ensure_rel_dir(&vault_root, &rel_dir, &keys)?;
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
pub fn rename_note(
    vault_root: String,
    rel_path: String,
    new_name: String,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("rename_note", || rename_note_inner(&vault_root, &rel_path, &new_name, &keys))
}

pub(crate) fn rename_note_inner(
    vault_root: &str,
    rel_path: &str,
    new_name: &str,
    keys: &SessionKeys,
) -> Result<CreatedNote, String> {
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') || new_name.contains(':') {
        return Err("Invalid note name".to_string());
    }
    // Preserve the note's own extension: renaming an encrypted note must
    // not silently turn it into a `.mntl`.
    let (dir_rel, _, ext) = split_rel_note_path(rel_path);
    let dest_rel = join_rel_note_path(&dir_rel, new_name, ext);
    let exists = || format!("A note named \"{new_name}\" already exists in this folder");

    // A hidden note's name is sealed inside it, so renaming it reseals it.
    if let Some(note) = keys.hidden_note(vault_root, rel_path)? {
        if dest_rel != rel_path && hidden::taken(vault_root, &dest_rel, keys)? {
            return Err(exists());
        }
        hidden::relocate(vault_root, keys, rel_path, &note, &dest_rel)?;
        crate::history::follow(vault_root, rel_path, &dest_rel, crate::history::Scope::Keep, keys);
        return Ok(CreatedNote { name: new_name.to_string(), rel_path: dest_rel });
    }

    // Otherwise it works for encrypted notes too: a rename is a pure
    // `fs::rename` that never inspects content, so it needs no key.
    let source = resolve_rel_path(vault_root, rel_path)?;
    let dest = resolve_rel_path(vault_root, &dest_rel)?;
    if dest != source && (dest.exists() || keys.hidden_note(vault_root, &dest_rel)?.is_some()) {
        return Err(exists());
    }
    fs::rename(&source, &dest).map_err(|e| format!("Failed to rename note: {e}"))?;
    crate::history::follow(vault_root, rel_path, &dest_rel, crate::history::Scope::Keep, keys);
    Ok(CreatedNote {
        name: new_name.to_string(),
        rel_path: dest_rel,
    })
}

#[tauri::command]
pub fn delete_note(vault_root: String, rel_path: String, keys: State<SessionKeys>) -> Result<(), String> {
    logged("delete_note", || {
        let hidden = keys.hidden_note(&vault_root, &rel_path)?;
        let path = resolve_note(&vault_root, &rel_path, &keys)?;
        // Send to the OS recycle bin/trash rather than unlinking outright, so a
        // deleted note stays recoverable through the normal OS trash UI.
        move_to_trash(&path).map_err(|e| format!("Failed to delete note: {e}"))?;
        if hidden.is_some() {
            keys.trash_hidden(&vault_root, &rel_path)?;
        }
        Ok(())
    })
}

/// Open a file in the vault with the OS's default app for it. Never a sealed
/// `.enc` file: that is ciphertext to any other app, and decrypting it to
/// disk for one would defeat the point.
#[tauri::command]
pub fn open_vault_file(app: tauri::AppHandle, vault_root: String, rel_path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    logged("open_vault_file", || {
        if rel_path.ends_with(".enc") {
            return Err("An encrypted file can only be viewed in Mantle".to_string());
        }
        let path = resolve_rel_path(&vault_root, &rel_path)?;
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| format!("Failed to open file: {e}"))
    })
}

#[tauri::command]
pub fn delete_folder(vault_root: String, rel_path: String, keys: State<SessionKeys>) -> Result<(), String> {
    logged("delete_folder", || delete_folder_inner(&vault_root, &rel_path, &keys))
}

/// Trash a folder, real or virtual, and every unlocked hidden note inside.
pub(crate) fn delete_folder_inner(vault_root: &str, rel_path: &str, keys: &SessionKeys) -> Result<(), String> {
    for (rel, note) in hidden::hidden_inside(vault_root, keys, rel_path)? {
        if note.disk.starts_with(&format!("{rel_path}/")) {
            // Its file is in the real folder, and goes with it.
            keys.put_hidden(vault_root, &rel, None)?;
            continue;
        }
        let path = resolve_rel_path(vault_root, &note.disk)?;
        move_to_trash(&path).map_err(|e| format!("Failed to delete note: {e}"))?;
        keys.trash_hidden(vault_root, &rel)?;
    }
    if resolve_rel_dir(vault_root, "")?.join(rel_path).exists() {
        let path = resolve_rel_path(vault_root, rel_path)?;
        // Same recycle-bin behavior as delete_note; it handles directories recursively.
        move_to_trash(&path).map_err(|e| format!("Failed to delete folder: {e}"))?;
    }
    Ok(())
}

/// Send a file or folder to the OS trash. Android has none, so there it's
/// deleted outright; the frontend confirms first (`canUndoDelete`).
pub(crate) fn move_to_trash(path: &Path) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    let result = trash::delete(path).map_err(|e| e.to_string());
    #[cfg(target_os = "android")]
    let result = if path.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }.map_err(|e| e.to_string());
    result
}

/// Put deleted vault items back from the OS trash, for undoing a delete. Each
/// path gets the item most recently trashed from there. Refuses, rather than
/// overwriting, when something new sits at the path or the item is gone from
/// the trash.
#[tauri::command]
pub fn restore_from_trash(vault_root: String, rel_paths: Vec<String>, keys: State<SessionKeys>) -> Result<(), String> {
    logged("restore_from_trash", || restore_from_trash_inner(&vault_root, &rel_paths, &keys))
}

#[cfg(any(target_os = "windows", all(unix, not(any(target_os = "macos", target_os = "android")))))]
fn restore_from_trash_inner(vault_root: &str, rel_paths: &[String], keys: &SessionKeys) -> Result<(), String> {
    // The trash reports plain paths; ours may carry Windows' `\\?\` prefix.
    fn key(path: &Path) -> String {
        let text = path.to_string_lossy();
        let text = text.strip_prefix(r"\\?\").unwrap_or(&text).replace('\\', "/");
        if cfg!(windows) { text.to_lowercase() } else { text }
    }
    let mut trashed = trash::os_limited::list().map_err(|e| format!("Failed to read the trash: {e}"))?;
    trashed.sort_by_key(|item| std::cmp::Reverse(item.time_deleted));
    // A hidden note, or one inside a deleted folder, is restored by its disk
    // file; the path the frontend knew it by may never have been on disk.
    let mut wanted = Vec::new();
    for rel_path in rel_paths {
        let hidden = keys.take_trashed(vault_root, rel_path)?;
        let required = hidden.is_empty();
        wanted.extend(hidden.into_iter().map(|note| (note.disk, true)));
        wanted.push((rel_path.clone(), required));
    }
    let mut items = Vec::new();
    for (rel_path, required) in wanted {
        let path = match resolve_rel_path(vault_root, &rel_path) {
            Ok(path) => path,
            Err(_) if !required => continue,
            Err(e) => return Err(e),
        };
        if path.exists() {
            if !required {
                continue;
            }
            return Err(format!("\"{rel_path}\" already exists"));
        }
        let wanted = key(&path);
        match trashed.iter().position(|item| key(&item.original_path()) == wanted) {
            Some(index) => items.push(trashed.remove(index)),
            None if required => return Err(format!("\"{rel_path}\" is no longer in the trash")),
            None => {}
        }
    }
    trash::os_limited::restore_all(items).map_err(|e| format!("Failed to restore from the trash: {e}"))
}

#[cfg(not(any(target_os = "windows", all(unix, not(any(target_os = "macos", target_os = "android"))))))]
fn restore_from_trash_inner(_vault_root: &str, _rel_paths: &[String], _keys: &SessionKeys) -> Result<(), String> {
    Err("Restoring from the trash isn't supported on this system".to_string())
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

#[tauri::command]
pub fn duplicate_note(vault_root: String, rel_path: String, keys: State<SessionKeys>) -> Result<CreatedNote, String> {
    logged("duplicate_note", || {
        let (dir_rel, _, _) = split_rel_note_path(&rel_path);
        copy_note_inner(&vault_root, &rel_path, &dir_rel, true, &keys)
    })
}

#[tauri::command]
pub fn copy_note(
    vault_root: String,
    source_rel_path: String,
    dest_rel_dir: String,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("copy_note", || copy_note_inner(&vault_root, &source_rel_path, &dest_rel_dir, false, &keys))
}

/// Copy a note into `dest_rel_dir`, as "name copy" if `force_suffix` or the
/// name is taken.
///
/// Copying an encrypted note copies its bytes verbatim, so the copy
/// temporarily shares the original's content key and nonce. That is not
/// nonce reuse in the dangerous sense — the plaintexts are identical, so
/// the ciphertexts already were — and the first edit to either copy
/// regenerates both. A hidden note is resealed instead, under a new disk
/// name and its new sealed path.
pub(crate) fn copy_note_inner(
    vault_root: &str,
    source_rel_path: &str,
    dest_rel_dir: &str,
    force_suffix: bool,
    keys: &SessionKeys,
) -> Result<CreatedNote, String> {
    let (_, stem, ext) = split_rel_note_path(source_rel_path);
    if let Some(note) = keys.hidden_note(vault_root, source_rel_path)? {
        if !dest_rel_dir.is_empty() {
            hidden::check_components(dest_rel_dir)?;
        }
        let dest_rel = hidden::unique_note_path(vault_root, keys, dest_rel_dir, &stem, ext, force_suffix)?;
        hidden::copy(vault_root, keys, &note, &dest_rel)?;
        return Ok(CreatedNote { name: note_display_name(&dest_rel), rel_path: dest_rel });
    }

    let source = resolve_rel_path(vault_root, source_rel_path)?;
    hidden::ensure_rel_dir(vault_root, dest_rel_dir, keys)?;
    let dest_rel = hidden::unique_note_path(vault_root, keys, dest_rel_dir, &stem, ext, force_suffix)?;
    let dest_abs = resolve_rel_path(vault_root, &dest_rel)?;
    fs::copy(&source, &dest_abs).map_err(|e| format!("Failed to copy note: {e}"))?;
    Ok(CreatedNote {
        // Not `dest_abs.file_stem()`: on "note copy.mntl.enc" that yields
        // "note copy.mntl", since `file_stem` strips one extension only.
        name: note_display_name(&dest_rel),
        rel_path: dest_rel,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFolder {
    pub name: String,
    pub rel_path: String,
}

#[tauri::command]
pub fn create_folder(
    vault_root: String,
    rel_dir: String,
    name: String,
    keys: State<SessionKeys>,
) -> Result<CreatedFolder, String> {
    logged("create_folder", || create_folder_inner(&vault_root, &rel_dir, &name, &keys))
}

pub(crate) fn create_folder_inner(
    vault_root: &str,
    rel_dir: &str,
    name: &str,
    keys: &SessionKeys,
) -> Result<CreatedFolder, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err("Invalid folder name".to_string());
    }
    let dest_dir_abs = hidden::ensure_rel_dir(vault_root, rel_dir, keys)?;
    let rel_path = if rel_dir.is_empty() { name.to_string() } else { format!("{rel_dir}/{name}") };
    let path = dest_dir_abs.join(name);
    if path.exists() || hidden::folder_exists(vault_root, keys, &rel_path)? {
        return Err(format!("A folder named \"{name}\" already exists in this location"));
    }
    fs::create_dir(&path).map_err(|e| format!("Failed to create folder: {e}"))?;
    Ok(CreatedFolder { name: name.to_string(), rel_path })
}

#[tauri::command]
pub fn rename_folder(
    vault_root: String,
    rel_path: String,
    new_name: String,
    keys: State<SessionKeys>,
) -> Result<CreatedFolder, String> {
    logged("rename_folder", || rename_folder_inner(&vault_root, &rel_path, &new_name, &keys))
}

/// Rename a folder, real or virtual, resealing the unlocked hidden notes in it.
pub(crate) fn rename_folder_inner(
    vault_root: &str,
    rel_path: &str,
    new_name: &str,
    keys: &SessionKeys,
) -> Result<CreatedFolder, String> {
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') || new_name.contains(':') {
        return Err("Invalid folder name".to_string());
    }
    hidden::check_components(rel_path)?;
    let dir_rel = rel_path.rsplit_once('/').map(|(dir, _)| dir.to_string()).unwrap_or_default();
    let dest_rel = if dir_rel.is_empty() { new_name.to_string() } else { format!("{dir_rel}/{new_name}") };
    // A case-only rename finds the folder itself on a case-insensitive disk.
    let same = dest_rel.to_lowercase() == rel_path.to_lowercase();
    if !same && hidden::folder_exists(vault_root, keys, &dest_rel)? {
        return Err(format!("A folder named \"{new_name}\" already exists in this location"));
    }
    hidden::move_folder_tree(vault_root, keys, rel_path, &dest_rel)?;
    Ok(CreatedFolder { name: new_name.to_string(), rel_path: dest_rel })
}

#[tauri::command]
pub fn move_note(
    vault_root: String,
    source_rel_path: String,
    dest_rel_dir: String,
    keys: State<SessionKeys>,
) -> Result<CreatedNote, String> {
    logged("move_note", || move_note_inner(&vault_root, &source_rel_path, &dest_rel_dir, &keys))
}

/// Move a note into `dest_rel_dir`. Like `rename_note`, a pure `fs::rename`
/// that needs no key — except for a hidden note, which is resealed.
pub(crate) fn move_note_inner(
    vault_root: &str,
    source_rel_path: &str,
    dest_rel_dir: &str,
    keys: &SessionKeys,
) -> Result<CreatedNote, String> {
    let (_, stem, ext) = split_rel_note_path(source_rel_path);
    if let Some(note) = keys.hidden_note(vault_root, source_rel_path)? {
        if !dest_rel_dir.is_empty() {
            hidden::check_components(dest_rel_dir)?;
        }
        let dest_rel = hidden::unique_note_path(vault_root, keys, dest_rel_dir, &stem, ext, false)?;
        hidden::relocate(vault_root, keys, source_rel_path, &note, &dest_rel)?;
        crate::history::follow(vault_root, source_rel_path, &dest_rel, crate::history::Scope::Keep, keys);
        return Ok(CreatedNote { name: note_display_name(&dest_rel), rel_path: dest_rel });
    }

    let source = resolve_rel_path(vault_root, source_rel_path)?;
    hidden::ensure_rel_dir(vault_root, dest_rel_dir, keys)?;
    let dest_rel = hidden::unique_note_path(vault_root, keys, dest_rel_dir, &stem, ext, false)?;
    let dest_abs = resolve_rel_path(vault_root, &dest_rel)?;
    fs::rename(&source, &dest_abs).map_err(|e| format!("Failed to move note: {e}"))?;
    crate::history::follow(vault_root, source_rel_path, &dest_rel, crate::history::Scope::Keep, keys);
    Ok(CreatedNote {
        name: note_display_name(&dest_rel),
        rel_path: dest_rel,
    })
}

#[tauri::command]
pub fn move_folder(
    vault_root: String,
    source_rel_path: String,
    dest_rel_dir: String,
    keys: State<SessionKeys>,
) -> Result<CreatedFolder, String> {
    logged("move_folder", || move_folder_inner(&vault_root, &source_rel_path, &dest_rel_dir, &keys))
}

/// Move a folder (real or virtual) or a file that isn't a note into
/// `dest_rel_dir`, keeping its name.
pub(crate) fn move_folder_inner(
    vault_root: &str,
    source_rel_path: &str,
    dest_rel_dir: &str,
    keys: &SessionKeys,
) -> Result<CreatedFolder, String> {
    hidden::check_components(source_rel_path)?;
    let name = source_rel_path.rsplit('/').next().unwrap_or(source_rel_path).to_string();
    let dest_rel = if dest_rel_dir.is_empty() { name.clone() } else { format!("{dest_rel_dir}/{name}") };

    if dest_rel == source_rel_path {
        return Ok(CreatedFolder { name, rel_path: dest_rel });
    }
    if dest_rel_dir == source_rel_path || dest_rel_dir.starts_with(&format!("{source_rel_path}/")) {
        return Err("Cannot move a folder into itself or one of its subfolders".to_string());
    }
    if !dest_rel_dir.is_empty() && !hidden::folder_exists(vault_root, keys, dest_rel_dir)? {
        return Err("Destination folder does not exist".to_string());
    }
    if hidden::folder_exists(vault_root, keys, &dest_rel)? {
        return Err(format!("\"{name}\" already exists in the destination folder"));
    }
    hidden::move_folder_tree(vault_root, keys, source_rel_path, &dest_rel)?;
    Ok(CreatedFolder { name, rel_path: dest_rel })
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
        assert!(matches!(scan_vault_inner(&path, &SessionKeys::default()).unwrap(), VaultNode::Folder { children, .. } if children.is_empty()));
    }

    #[test]
    fn list_folders_lists_visible_subfolders_and_flags_vaults() {
        let parent = temp_dir("list-folders");
        fs::create_dir_all(parent.join("notes").join(".mantle")).unwrap();
        fs::create_dir(parent.join("Archive")).unwrap();
        fs::create_dir(parent.join(".hidden")).unwrap();
        fs::write(parent.join("file.md"), "").unwrap();
        let folders = list_folders(parent.to_string_lossy().into_owned()).unwrap();
        let listed: Vec<_> = folders.iter().map(|f| (f.name.as_str(), f.vault)).collect();
        assert_eq!(listed, [("Archive", false), ("notes", true)]);
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
    fn move_vault_renames_the_folder_and_rejects_collisions() {
        let parent = temp_dir("move-vault");
        let from = parent.join("A").to_string_lossy().into_owned();
        let to = parent.join("B").to_string_lossy().into_owned();
        create_vault(from.clone()).unwrap();
        fs::create_dir(parent.join("taken")).unwrap();
        assert!(move_vault(from.clone(), parent.join("taken").to_string_lossy().into_owned()).is_err());
        assert_eq!(move_vault(from.clone(), to.clone()).unwrap(), to);
        assert!(!Path::new(&from).exists());
        assert!(parent.join("B").join(".mantle").join("state.json").is_file());
        assert!(move_vault(from, parent.join("C").to_string_lossy().into_owned()).is_err());
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

        let created = create_folder_inner(&root_str.clone(), &String::new(), &"Archive".to_string(), &SessionKeys::default()).unwrap();
        assert_eq!(created.rel_path, "Archive");
        assert!(root.join("Archive").is_dir());

        let nested = create_folder_inner(&root_str, &"Work".to_string(), &"Drafts".to_string(), &SessionKeys::default()).unwrap();
        assert_eq!(nested.rel_path, "Work/Drafts");
        assert!(root.join("Work").join("Drafts").is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_folder_rejects_collisions_and_invalid_names() {
        let root = temp_dir("create-folder-invalid");
        fs::create_dir_all(root.join("Archive")).unwrap();
        let root_str = root.to_string_lossy().into_owned();

        assert!(create_folder_inner(&root_str.clone(), &String::new(), &"Archive".to_string(), &SessionKeys::default()).is_err());
        assert!(create_folder_inner(&root_str.clone(), &String::new(), &"a/b".to_string(), &SessionKeys::default()).is_err());
        assert!(create_folder_inner(&root_str, &String::new(), &String::new(), &SessionKeys::default()).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_note_renames_in_place_and_rejects_collisions() {
        let root = temp_dir("rename-note");
        fs::create_dir_all(root.join("Work")).unwrap();
        fs::write(root.join("Work").join("todo.mntl"), "---\nv: 2\n---\n").unwrap();
        fs::write(root.join("Work").join("taken.mntl"), "---\nv: 2\n---\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let renamed = rename_note_inner(&root_str.clone(), &"Work/todo.mntl".to_string(), &"done".to_string(), &SessionKeys::default()).unwrap();
        assert_eq!(renamed.rel_path, "Work/done.mntl");
        assert!(root.join("Work").join("done.mntl").is_file());
        assert!(!root.join("Work").join("todo.mntl").exists());

        assert!(rename_note_inner(&root_str.clone(), &"Work/done.mntl".to_string(), &"taken".to_string(), &SessionKeys::default()).is_err());
        assert!(rename_note_inner(&root_str, &"Work/done.mntl".to_string(), &"a/b".to_string(), &SessionKeys::default()).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_folder_renames_in_place_and_rejects_collisions() {
        let root = temp_dir("rename-folder");
        fs::create_dir_all(root.join("Work")).unwrap();
        fs::create_dir_all(root.join("Archive")).unwrap();
        fs::write(root.join("Work").join("todo.mntl"), "---\nv: 2\n---\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let renamed = rename_folder_inner(&root_str.clone(), &"Work".to_string(), &"Projects".to_string(), &SessionKeys::default()).unwrap();
        assert_eq!(renamed.rel_path, "Projects");
        assert!(root.join("Projects").join("todo.mntl").is_file());
        assert!(!root.join("Work").exists());

        assert!(rename_folder_inner(&root_str.clone(), &"Projects".to_string(), &"Archive".to_string(), &SessionKeys::default()).is_err());
        assert!(rename_folder_inner(&root_str, &"Projects".to_string(), &"a/b".to_string(), &SessionKeys::default()).is_err());

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
        assert!(move_folder_inner(&root_str.clone(), &"Work".to_string(), &"Work".to_string(), &SessionKeys::default()).is_err());
        assert!(move_folder_inner(&root_str.clone(), &"Work".to_string(), &"Work/Nested".to_string(), &SessionKeys::default()).is_err());

        // colliding with an existing folder at the destination is rejected
        assert!(move_folder_inner(&root_str.clone(), &"Work".to_string(), &"Archive".to_string(), &SessionKeys::default()).is_err());

        let moved = move_folder_inner(&root_str.clone(), &"Work".to_string(), &"".to_string(), &SessionKeys::default()).unwrap();
        assert_eq!(moved.rel_path, "Work");

        let moved = move_folder_inner(&root_str.clone(), &"Work".to_string(), &"Nonexistent".to_string(), &SessionKeys::default());
        assert!(moved.is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_folder_removes_the_directory_and_its_contents() {
        let root = temp_dir("delete-folder");
        fs::create_dir_all(root.join("Work").join("Nested")).unwrap();
        fs::write(root.join("Work").join("todo.mntl"), "---\nv: 2\n---\n").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        delete_folder_inner(&root_str, &"Work".to_string(), &SessionKeys::default()).unwrap();
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

        assert_eq!(
            read_note_inner(&root_str, "readme.md", &keys).unwrap(),
            NoteDocument { content: "# Old\n".into(), tags: vec!["x".into()], properties: Some(vec![]) }
        );

        // Unchanged tags leave the frontmatter byte for byte.
        write_note_inner(&root_str, "readme.md", "# New\n", &["x".into()], None, &keys).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("readme.md")).unwrap(),
            "---\ntags: [x]\n---\n# New\n"
        );

        // Changed tags rewrite only the `tags:` key, in its own style.
        write_note_inner(&root_str, "readme.md", "# New\n", &["x".into(), "y".into()], None, &keys).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("readme.md")).unwrap(),
            "---\ntags: [x, y]\n---\n# New\n"
        );
    }

    #[test]
    fn mntl_notes_keep_their_tags_in_the_frontmatter() {
        let root = temp_dir("mntl-tags");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        fs::write(root.join("plan.mntl"), "---\nv: 2\n---\nBody").unwrap();

        write_note_inner(&root_str, "plan.mntl", "Body", &["Idea".into(), "idea".into(), " ".into()], None, &keys)
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("plan.mntl")).unwrap(),
            "---\nv: 2\ntags:\n- Idea\n---\nBody"
        );
        assert_eq!(read_note_inner(&root_str, "plan.mntl", &keys).unwrap().tags, vec!["Idea"]);

        let _ = fs::remove_dir_all(&root);
    }

    fn prop(key: &str, value: serde_json::Value) -> NoteProperty {
        NoteProperty { key: key.into(), value }
    }

    #[test]
    fn mntl_notes_keep_their_properties_nested_and_in_order() {
        let root = temp_dir("mntl-props");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        fs::write(root.join("plan.mntl"), "---\nv: 2\n---\nBody").unwrap();

        let props = vec![
            prop("zeta", serde_json::json!(1.5)),
            prop("tags", serde_json::json!(["dropped"])),
            prop("done", serde_json::json!(true)),
            prop("list", serde_json::json!(["a", "b"])),
        ];
        write_note_inner(&root_str, "plan.mntl", "Body", &[], Some(&props), &keys).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("plan.mntl")).unwrap(),
            "---\nv: 2\nproperties:\n  zeta: 1.5\n  done: true\n  list:\n  - a\n  - b\n---\nBody"
        );
        let read = read_note_inner(&root_str, "plan.mntl", &keys).unwrap().properties.unwrap();
        assert_eq!(read, vec![props[0].clone(), props[2].clone(), props[3].clone()]);

        // A save that doesn't carry properties leaves them be.
        write_note_inner(&root_str, "plan.mntl", "Edited", &[], None, &keys).unwrap();
        assert_eq!(read_note_inner(&root_str, "plan.mntl", &keys).unwrap().properties.unwrap(), read);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn markdown_property_edits_rewrite_only_the_changed_keys() {
        let root = temp_dir("md-props");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        let file = "---\ntitle:   Plan  # mine\ncount: 1.0\nnested:\n  a: 1\ngone: x\n---\nBody";
        fs::write(root.join("plan.md"), file).unwrap();

        let read = read_note_inner(&root_str, "plan.md", &keys).unwrap().properties.unwrap();
        let keys_of = |props: &[NoteProperty]| props.iter().map(|p| p.key.clone()).collect::<Vec<_>>();
        assert_eq!(keys_of(&read), vec!["title", "count", "nested", "gone"]);

        // Sent back unchanged (`1.0` comes back from JavaScript as `1`), nothing moves.
        let mut sent = read.clone();
        sent[1].value = serde_json::json!(1);
        write_note_inner(&root_str, "plan.md", "Body", &[], Some(&sent), &keys).unwrap();
        assert_eq!(fs::read_to_string(root.join("plan.md")).unwrap(), file);

        // Changing one, dropping one and adding one touch only those lines.
        sent[1].value = serde_json::json!(2);
        sent.remove(3);
        sent.push(prop("due", serde_json::json!("2026-10-17")));
        write_note_inner(&root_str, "plan.md", "Body", &[], Some(&sent), &keys).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("plan.md")).unwrap(),
            "---\ntitle:   Plan  # mine\ncount: 2\nnested:\n  a: 1\ndue: 2026-10-17\n---\nBody"
        );

        // Frontmatter that can't be read is reported as such, and left alone.
        fs::write(root.join("broken.md"), "---\n: [oops\n---\nBody").unwrap();
        assert_eq!(read_note_inner(&root_str, "broken.md", &keys).unwrap().properties, None);
        write_note_inner(&root_str, "broken.md", "Body", &[], Some(&sent), &keys).unwrap();
        assert_eq!(fs::read_to_string(root.join("broken.md")).unwrap(), "---\n: [oops\n---\nBody");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_vault_reports_tags_and_hides_those_of_locked_notes() {
        let root = temp_dir("scan-tags");
        let root_str = root.to_string_lossy().into_owned();
        fs::write(root.join("plan.mntl"), "---\nv: 2\ntags:\n- work\n---\nBody").unwrap();
        fs::write(root.join("readme.md"), "---\ntags: [docs]\n---\nBody").unwrap();
        fs::write(root.join("bare.md"), "Body").unwrap();
        let frontmatter = mntl_core::NoteFrontmatter { tags: vec!["private".into()], ..Default::default() };
        let document = mntl_core::encode_note(&frontmatter, "Body").unwrap();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let blob = mntl_core::encrypt_note(&mk, "diary", document.as_bytes()).unwrap();
        fs::write(root.join("secret.mntl.enc"), blob).unwrap();

        let tags_of = |keys: &SessionKeys, name: &str| {
            let VaultNode::Folder { children, .. } = scan_vault_inner(&root_str, keys).unwrap() else {
                panic!("root should be a folder");
            };
            match find_note(&children, name) {
                VaultNode::Note { tags, .. } => tags.clone(),
                other => panic!("expected a note, got {other:?}"),
            }
        };

        let keys = SessionKeys::default();
        assert_eq!(tags_of(&keys, "plan"), Some(vec!["work".into()]));
        assert_eq!(tags_of(&keys, "readme"), Some(vec!["docs".into()]));
        assert_eq!(tags_of(&keys, "bare"), Some(vec![]));
        assert_eq!(tags_of(&keys, "secret"), None);

        keys.unlock_for_test(&root_str, "diary", mk).unwrap();
        assert_eq!(tags_of(&keys, "secret"), Some(vec!["private".into()]));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_encrypted_favorite_is_sealed_kept_across_saves_and_hidden_while_locked() {
        let root = temp_dir("sealed-favorite");
        let root_str = root.to_string_lossy().into_owned();
        let document = mntl_core::encode_unencrypted_note("Body").unwrap();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let blob = mntl_core::encrypt_note(&mk, "diary", document.as_bytes()).unwrap();
        fs::write(root.join("secret.mntl.enc"), blob).unwrap();

        let favorite_in = |keys: &SessionKeys| {
            let VaultNode::Folder { children, .. } = scan_vault_inner(&root_str, keys).unwrap() else {
                panic!("root should be a folder");
            };
            match find_note(&children, "secret") {
                VaultNode::Note { favorite, .. } => *favorite,
                other => panic!("expected a note, got {other:?}"),
            }
        };

        let unlocked = SessionKeys::default();
        unlocked.unlock_for_test(&root_str, "diary", mk).unwrap();
        assert!(!favorite_in(&unlocked));
        set_note_favorite_inner(&root_str, "secret.mntl.enc", true, &unlocked).unwrap();
        assert!(favorite_in(&unlocked));

        write_note_inner(&root_str, "secret.mntl.enc", "Edited", &["t".into()], None, &unlocked).unwrap();
        assert!(favorite_in(&unlocked), "a save must not drop the favorite");
        let saved = read_note_inner(&root_str, "secret.mntl.enc", &unlocked).unwrap();
        assert_eq!(saved, NoteDocument { content: "Edited".into(), tags: vec!["t".into()], properties: Some(vec![]) });

        // Properties are sealed in the note too, and a save without them keeps them.
        let props = vec![prop("due", serde_json::json!("2026-10-17"))];
        write_note_inner(&root_str, "secret.mntl.enc", "Edited", &[], Some(&props), &unlocked).unwrap();
        write_note_inner(&root_str, "secret.mntl.enc", "Again", &[], None, &unlocked).unwrap();
        assert_eq!(read_note_inner(&root_str, "secret.mntl.enc", &unlocked).unwrap().properties, Some(props));
        assert!(favorite_in(&unlocked));

        assert!(!favorite_in(&SessionKeys::default()), "a locked note reveals nothing");
        assert!(set_note_favorite_inner(&root_str, "secret.mntl.enc", false, &SessionKeys::default()).is_err());
        assert!(set_note_favorite_inner(&root_str, "plain.mntl", true, &unlocked).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_encrypted_notes_style_is_sealed_and_survives_saves() {
        let root = temp_dir("sealed-style");
        let root_str = root.to_string_lossy().into_owned();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let document = mntl_core::encode_unencrypted_note("Body").unwrap();
        fs::write(root.join("secret.mntl.enc"), mntl_core::encrypt_note(&mk, "diary", document.as_bytes()).unwrap()).unwrap();
        let keys = SessionKeys::default();
        keys.unlock_for_test(&root_str, "diary", mk).unwrap();
        let style_in = |keys: &SessionKeys| {
            let VaultNode::Folder { children, .. } = scan_vault_inner(&root_str, keys).unwrap() else { panic!() };
            match find_note(&children, "secret") {
                VaultNode::Note { icon, color, .. } => (icon.clone(), color.clone()),
                other => panic!("expected a note, got {other:?}"),
            }
        };
        set_note_style_inner(&root_str, "secret.mntl.enc", Some("star".into()), Some("primary".into()), &keys).unwrap();
        assert_eq!(style_in(&keys), (Some("star".into()), Some("primary".into())));
        write_note_inner(&root_str, "secret.mntl.enc", "Edited", &[], None, &keys).unwrap();
        assert_eq!(style_in(&keys), (Some("star".into()), Some("primary".into())));
        assert_eq!(style_in(&SessionKeys::default()), (None, None), "a locked note reveals nothing");
        assert!(set_note_style_inner(&root_str, "plain.mntl", None, None, &keys).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn markdown_notes_without_frontmatter_stay_plain_markdown() {
        let root = temp_dir("markdown-plain");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        fs::write(root.join("todo.markdown"), "- [ ] one
").unwrap();

        assert_eq!(read_note_inner(&root_str, "todo.markdown", &keys).unwrap().content, "- [ ] one\n");
        write_note_inner(&root_str, "todo.markdown", "- [x] one\n", &[], None, &keys).unwrap();
        assert_eq!(fs::read_to_string(root.join("todo.markdown")).unwrap(), "- [x] one
");
    }

    #[test]
    fn renaming_a_markdown_note_keeps_its_extension() {
        let root = temp_dir("markdown-rename");
        let root_str = root.to_string_lossy().into_owned();
        fs::write(root.join("readme.md"), "hi").unwrap();

        let renamed = rename_note_inner(&root_str, &"readme.md".to_string(), &"intro".to_string(), &SessionKeys::default()).unwrap();
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
    fn unique_note_path_preserves_enc_extension() {
        let root = temp_dir("unique-sibling-enc");
        fs::write(root.join("secret.mntl.enc"), b"MENC").unwrap();
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();

        let rel = hidden::unique_note_path(&root_str, &keys, "", "secret", ".mntl.enc", true).unwrap();
        assert_eq!(rel, "secret copy.mntl.enc");

        // And a non-colliding plaintext name is returned untouched.
        let plain = hidden::unique_note_path(&root_str, &keys, "Work", "todo", ".mntl", false).unwrap();
        assert_eq!(plain, "Work/todo.mntl");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_note_keeps_the_enc_extension() {
        let root = temp_dir("rename-enc");
        fs::write(root.join("secret.mntl.enc"), b"MENC placeholder").unwrap();
        let root_str = root.to_string_lossy().into_owned();

        let renamed = rename_note_inner(&root_str, &"secret.mntl.enc".to_string(), &"diary".to_string(), &SessionKeys::default())
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

        let copy = copy_note_inner(&root_str, "secret.mntl.enc", "", true, &SessionKeys::default()).unwrap();

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

        let moved = move_note_inner(&root_str, &"secret.mntl.enc".to_string(), &"Work".to_string(), &SessionKeys::default())
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
        let mk = mntl_core::MasterKey::generate().unwrap();
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

        let tree = scan_vault_inner(&root.to_string_lossy(), &SessionKeys::default()).unwrap();
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
    fn scan_vault_lists_each_notes_wikilinks() {
        let root = temp_dir("scan-links");
        fs::write(root.join("a.mntl"), mntl_core::encode_unencrypted_note("[[B]] [[C#x|y]] [[B]] `[[code]]`").unwrap()).unwrap();
        fs::write(root.join("b.md"), "---\ntags: [t]\n---\n[[A]]").unwrap();
        let tree = scan_vault_inner(&root.to_string_lossy(), &SessionKeys::default()).unwrap();
        let VaultNode::Folder { children, .. } = &tree else { panic!() };
        let links = |name| match find_note(children, name) {
            VaultNode::Note { links, .. } => links.clone(),
            _ => panic!(),
        };
        assert_eq!(links("a"), Some(vec!["B".to_string(), "C".to_string()]));
        assert_eq!(links("b"), Some(vec!["A".to_string()]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_vault_lists_other_files_but_hides_the_attachment_store() {
        let root = temp_dir("scan-files");
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::create_dir_all(root.join("Trip/attachments")).unwrap();
        fs::write(root.join("attachments/abc.png"), "x").unwrap();
        fs::write(root.join("Trip/attachments/photo.png"), "x").unwrap();
        fs::write(root.join("Trip/plan.pdf"), "x").unwrap();
        fs::write(root.join("Trip/notes.mntl"), "---\nv: 2\n---\n").unwrap();

        let tree = scan_vault_inner(&root.to_string_lossy(), &SessionKeys::default()).unwrap();
        let json = serde_json::to_value(&tree).unwrap();
        let names = |node: &serde_json::Value| -> Vec<String> {
            node["children"].as_array().unwrap().iter().map(|c| format!("{}:{}", c["type"].as_str().unwrap(), c["relPath"].as_str().unwrap())).collect()
        };
        assert_eq!(names(&json), ["folder:Trip"]);
        assert_eq!(
            names(&json["children"][0]),
            ["folder:Trip/attachments", "note:Trip/notes.mntl", "file:Trip/plan.pdf"],
        );
        assert_eq!(
            note_paths(&root.to_string_lossy(), &SessionKeys::default()).unwrap(),
            [("Trip/notes.mntl".to_string(), "Trip/notes.mntl".to_string())]
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_vault_tolerates_a_corrupt_encrypted_header() {
        // One unreadable file must not make the whole vault fail to open.
        let root = temp_dir("scan-corrupt");
        fs::write(root.join("broken.mntl.enc"), b"MENC\xff\xff\xff\xffgarbage").unwrap();
        fs::write(root.join("truncated.mntl.enc"), b"MEN").unwrap();
        fs::write(root.join("todo.mntl"), "---\nv: 2\n---\n# Public").unwrap();

        let tree = scan_vault_inner(&root.to_string_lossy(), &SessionKeys::default()).unwrap();
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
