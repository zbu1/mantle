//! Turning Mantle notes back into plain Markdown: converting them in place
//! ([`convert_to_markdown`]) or writing a Markdown copy of the whole vault
//! somewhere else ([`export_vault`]).
//!
//! Either way a note's tags and properties become its YAML frontmatter, an
//! encrypted note of an unlocked profile is written as plaintext at its real
//! location and name (see [`crate::hidden`]), and every file in
//! `attachments/` it uses is written out, decrypted, where a [`Placement`]
//! says, with its link re-pointed. Notes of locked profiles are never
//! included; they're listed in the report instead.
//!
//! As in [`crate::notes_crypto`], errors reach the on-disk log, so never put
//! note content into one.

use crate::session::{ask_path, ActiveVault, Ask};

use crate::attachments::{
    is_managed, link_sources, load, resolve_attachment, unreferenced, ATTACHMENTS_DIR, EXT_SEALED,
};
use crate::credentials::SessionKeys;
use crate::hidden;
use crate::logging::logged;
use crate::notes_crypto::{discard, Conversion, ConvertFailure};
use crate::vault::{
    is_markdown_note, join_rel_note_path, master_key_for, note_paths, resolve_rel_dir, resolve_rel_path,
    split_rel_note_path, write_atomic, EXT_ENCRYPTED, LOCKED_ERR_PREFIX,
};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use zeroize::Zeroizing;

const EXT_MARKDOWN: &str = ".md";

/// What a Markdown link destination can't hold bare.
const LINK_UNSAFE: &AsciiSet = &CONTROLS.add(b' ').add(b'%').add(b'(').add(b')').add(b'<').add(b'>');

/// Where a note's attachments are written, relative to it.
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Placement {
    /// In the note's own folder.
    NextToNote,
    /// In a folder of this name beside the note.
    Subfolder { name: String },
    /// In the vault root.
    VaultRoot,
    /// In one vault-relative folder.
    Folder { path: String },
}

impl Placement {
    /// The vault-relative folder the attachments of a note in `note_dir` go to.
    fn dir(&self, note_dir: &str) -> Result<String, String> {
        let dir = match self {
            Self::NextToNote => note_dir.to_string(),
            Self::VaultRoot => String::new(),
            Self::Subfolder { name } => {
                if name.is_empty() || name.contains(['/', '\\', ':']) {
                    return Err("Invalid attachment folder name".to_string());
                }
                join(note_dir, name)
            }
            Self::Folder { path } => path.trim_matches('/').to_string(),
        };
        if !dir.is_empty() {
            hidden::check_components(&dir)?;
            if dir.split('/').any(|part| part.starts_with('.')) {
                return Err("The attachment folder can't be a hidden (dot) folder".to_string());
            }
        }
        if dir == ATTACHMENTS_DIR || dir.starts_with(&format!("{ATTACHMENTS_DIR}/")) {
            return Err(format!(
                "\"{ATTACHMENTS_DIR}\" in the vault root is Mantle's own attachment folder; pick another name"
            ));
        }
        Ok(dir)
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

/// `to` (a root-relative file) as a path relative to the folder `from_dir`.
fn relative(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|p| !p.is_empty()).collect();
    let to: Vec<&str> = to.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

/// `name` with ` (n)` before its extension.
fn numbered(name: &str, n: u32) -> String {
    match name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()) {
        Some((stem, ext)) => format!("{stem} ({n}).{ext}"),
        None => format!("{name} ({n})"),
    }
}

/// Where converted notes and their attachments are written: the vault itself,
/// or an export's destination.
struct Output {
    root: PathBuf,
    /// Each attachment already written, by its vault path and the folder it went to.
    placed: HashMap<(String, String), String>,
    /// The attachment copies written, root-relative.
    created: Vec<String>,
}

impl Output {
    fn new(root: PathBuf) -> Self {
        Self { root, placed: HashMap::new(), created: Vec::new() }
    }

    /// Write the attachment `source` (its bytes from `read`) as `name` in the
    /// root-relative `dir`, unless it already went there, and return where it
    /// is. Someone else's file at that path is never overwritten: the copy
    /// becomes `name (2)`, and the same bytes already there are reused.
    fn place(
        &mut self,
        source: &str,
        dir: &str,
        name: &str,
        read: impl FnOnce() -> Result<Zeroizing<Vec<u8>>, String>,
    ) -> Result<String, String> {
        let key = (source.to_string(), dir.to_string());
        if let Some(rel) = self.placed.get(&key) {
            return Ok(rel.clone());
        }
        let bytes = read()?;
        fs::create_dir_all(self.root.join(dir)).map_err(|e| format!("Failed to create \"{dir}\": {e}"))?;
        for n in 1.. {
            let rel = join(dir, &if n == 1 { name.to_string() } else { numbered(name, n) });
            let path = self.root.join(&rel);
            if path.exists() {
                if fs::read(&path).is_ok_and(|existing| existing == *bytes) {
                    self.placed.insert(key, rel.clone());
                    return Ok(rel);
                }
                continue;
            }
            write_atomic(&path, &bytes)?;
            self.created.push(rel.clone());
            self.placed.insert(key, rel.clone());
            return Ok(rel);
        }
        unreachable!()
    }
}

/// A note read to be written out as Markdown.
struct NoteText {
    /// The folder and name it's written to: a hidden note's real ones.
    dir: String,
    stem: String,
    /// `.md`, or a Markdown file's own extension.
    ext: &'static str,
    head: Head,
    body: Zeroizing<String>,
}

enum Head {
    /// A Mantle note's frontmatter, written as Markdown frontmatter.
    Note(mntl_core::NoteFrontmatter),
    /// A Markdown file's own frontmatter, kept verbatim.
    Markdown(String),
}

impl NoteText {
    fn render(&self, body: &str) -> Result<Zeroizing<String>, String> {
        match &self.head {
            Head::Note(frontmatter) => {
                mntl_core::encode_markdown_note(frontmatter, body).map(Zeroizing::new).map_err(|e| e.to_string())
            }
            Head::Markdown(prefix) => Ok(Zeroizing::new(format!("{prefix}{body}"))),
        }
    }
}

/// Read the note the frontend knows as `rel_path`. One of a locked profile
/// fails with the `mantle:locked:<id>` sentinel.
fn read_note_text(vault_root: &str, rel_path: &str, keys: &SessionKeys) -> Result<NoteText, String> {
    let (mut dir, mut stem, ext) = split_rel_note_path(rel_path);
    let path = hidden::resolve_note(vault_root, rel_path, keys)?;

    if is_markdown_note(rel_path) {
        let raw = Zeroizing::new(fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {e}"))?);
        let (prefix, body) = mntl_core::split_markdown_frontmatter(&raw);
        let head = Head::Markdown(prefix.to_string());
        return Ok(NoteText { dir, stem, ext, head, body: Zeroizing::new(body.to_string()) });
    }

    let document = if rel_path.ends_with(EXT_ENCRYPTED) {
        let blob = fs::read(&path).map_err(|e| format!("Failed to read note: {e}"))?;
        let (_, mk) = master_key_for(vault_root, &blob, keys)?;
        let document = mntl_core::decrypt_note(&mk, &blob).map_err(|e| e.to_string())?;
        Zeroizing::new(String::from_utf8(document.to_vec()).map_err(|_| "Decrypted note is not UTF-8".to_string())?)
    } else {
        Zeroizing::new(fs::read_to_string(&path).map_err(|e| format!("Failed to read note: {e}"))?)
    };
    let (frontmatter, body) = mntl_core::decode_note(&document).map_err(|e| format!("Not a valid note: {e}"))?;
    // A hidden note goes to where it really is, not where the tree lists it.
    if let (Some(location), Some(name)) = (&frontmatter.location, &frontmatter.name) {
        let location_ok = location.is_empty() || hidden::check_components(location).is_ok();
        if location_ok && !name.is_empty() && !name.contains(['/', '\\', ':']) {
            (dir, stem) = (location.clone(), name.clone());
        }
    }
    Ok(NoteText { dir, stem, ext: EXT_MARKDOWN, head: Head::Note(frontmatter), body: Zeroizing::new(body) })
}

/// Write every attachment `note.body` uses to where `placement` says, under
/// `out`, re-pointing its links from the note's new home in `note.dir`.
/// Returns the new body and the attachments it came from.
fn relink(
    vault_root: &str,
    rel_path: &str,
    note: &NoteText,
    placement: &Placement,
    out: &mut Output,
    keys: &SessionKeys,
) -> Result<(Zeroizing<String>, BTreeSet<String>), String> {
    let body = note.body.as_str();
    let mut text = Zeroizing::new(String::with_capacity(body.len()));
    let mut used = BTreeSet::new();
    let mut last = 0;
    for source in link_sources(body) {
        let range = source.range;
        let Some(rel) = resolve_attachment(vault_root, rel_path, &body[range.clone()]) else { continue };
        // The user's own files keep their paths, in place and in an export.
        if !is_managed(&rel) {
            continue;
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel);
        // A sealed copy's name loses its `.enc`, as it's written decrypted.
        let name = name.strip_suffix(EXT_SEALED).filter(|plain| plain.contains('.')).unwrap_or(name);
        let dest = out.place(&rel, &placement.dir(&note.dir)?, name, || {
            load(vault_root, &rel, keys).map_err(|e| match e.strip_prefix(LOCKED_ERR_PREFIX) {
                Some(profile) => format!("Unlock \"{profile}\" first: this note uses a file encrypted under it"),
                None => e,
            })
        })?;
        // A wikilink names a file by its vault path; a Markdown link by a relative URL.
        let wikilink = range.start >= 2 && &body[range.start - 2..range.start] == "[[";
        let link = if wikilink {
            dest
        } else {
            utf8_percent_encode(&relative(&note.dir, &dest), LINK_UNSAFE).to_string()
        };
        text.push_str(&body[last..range.start]);
        text.push_str(&link);
        last = range.end;
        used.insert(rel);
    }
    text.push_str(&body[last..]);
    Ok((text, used))
}

/// A note to convert to Markdown in place, and the name (file stem) it gets
/// if not its own.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToMarkdownRequest {
    pub rel_path: String,
    pub name: Option<String>,
}

/// What [`convert_to_markdown`] did.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToMarkdownReport {
    pub converted: Vec<Conversion>,
    pub failed: Vec<ConvertFailure>,
    /// Notes left alone because their profile is locked.
    pub locked: Vec<String>,
    /// The attachment copies written.
    pub created: Vec<String>,
    /// The `attachments/` files no note uses any more, moved to the OS trash.
    pub removed: Vec<String>,
}

/// Convert Mantle notes into Markdown files beside them, each written and
/// read back before its original goes to the OS trash. Their attachments are
/// copied out of `attachments/`, which is never edited here; with
/// `remove_unused`, the ones no note uses any more then go to the trash too.
/// A note that fails is reported and the rest carry on.
#[tauri::command(async)]
pub fn convert_to_markdown(
    active_vault: State<'_, ActiveVault>,
    notes: Vec<ToMarkdownRequest>,
    placement: Placement,
    remove_unused: bool,
    keys: State<SessionKeys>,
) -> Result<ToMarkdownReport, String> {
    let vault_root = active_vault.root()?;
    logged("convert_to_markdown", || {
        convert_to_markdown_inner(&vault_root, &notes, &placement, remove_unused, &keys)
    })
}

fn convert_to_markdown_inner(
    vault_root: &str,
    notes: &[ToMarkdownRequest],
    placement: &Placement,
    remove_unused: bool,
    keys: &SessionKeys,
) -> Result<ToMarkdownReport, String> {
    let mut report = ToMarkdownReport::default();
    let mut out = Output::new(resolve_rel_dir(vault_root, "")?);
    let mut used = BTreeSet::new();
    for note in notes {
        match convert_one(vault_root, &note.rel_path, note.name.as_deref(), placement, &mut out, keys) {
            Ok((conversion, sources)) => {
                used.extend(sources);
                report.converted.push(conversion);
            }
            Err(e) if e.starts_with(LOCKED_ERR_PREFIX) => report.locked.push(note.rel_path.clone()),
            Err(error) => report.failed.push(ConvertFailure { rel_path: note.rel_path.clone(), error }),
        }
    }
    report.created = std::mem::take(&mut out.created);
    if remove_unused && !used.is_empty() {
        for rel in unreferenced(vault_root, used, &[], keys)? {
            if discard(&resolve_rel_path(vault_root, &rel)?).is_ok() {
                report.removed.push(rel);
            }
        }
    }
    Ok(report)
}

fn convert_one(
    vault_root: &str,
    rel_path: &str,
    name: Option<&str>,
    placement: &Placement,
    out: &mut Output,
    keys: &SessionKeys,
) -> Result<(Conversion, BTreeSet<String>), String> {
    if is_markdown_note(rel_path) {
        return Err("This is already a Markdown file".to_string());
    }
    if name.is_some_and(|n| n.is_empty() || n.contains(['/', '\\', ':'])) {
        return Err("Invalid note name".to_string());
    }
    let note = read_note_text(vault_root, rel_path, keys)?;
    let stem = name.map_or_else(|| note.stem.clone(), str::to_string);
    let dest_rel = join_rel_note_path(&note.dir, &stem, EXT_MARKDOWN);
    if hidden::taken(vault_root, &dest_rel, keys)? {
        return Err(format!("\"{stem}{EXT_MARKDOWN}\" already exists in this folder"));
    }
    // A hidden note's folder may only be virtual.
    hidden::ensure_rel_dir(vault_root, &note.dir, keys)?;

    let (body, used) = relink(vault_root, rel_path, &note, placement, out, keys)?;
    let markdown = note.render(&body)?;
    let dest = resolve_rel_path(vault_root, &dest_rel)?;
    write_atomic(&dest, markdown.as_bytes())?;
    let verified = fs::read(&dest).is_ok_and(|written| written == markdown.as_bytes());
    if !verified {
        let _ = fs::remove_file(&dest);
        return Err("The Markdown file failed verification; the note is untouched".to_string());
    }

    let is_hidden = keys.hidden_note(vault_root, rel_path)?.is_some();
    discard(&hidden::resolve_note(vault_root, rel_path, keys)?)?;
    if is_hidden {
        keys.trash_hidden(vault_root, rel_path)?;
    }
    Ok((Conversion { from: rel_path.to_string(), name: stem, rel_path: dest_rel }, used))
}

/// A note an export left out, because its profile is locked.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LockedNote {
    /// Its path, or for a hidden note, its file's.
    pub rel_path: String,
    pub profile: String,
}

/// A note exported under another name, as something else had its path.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    pub from: String,
    pub to: String,
}

/// What [`export_vault`] did.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub notes: usize,
    pub files: usize,
    pub locked: Vec<LockedNote>,
    pub renamed: Vec<Renamed>,
    pub failed: Vec<ConvertFailure>,
}

/// Write a plain Markdown copy of the vault to `dest`, a new or empty folder.
/// Notes become `.md` files, every other file is copied as it is, and
/// `.mantle/` (like every dot entry the tree doesn't show) is left out. The
/// vault itself isn't changed. The folder is picked in the OS dialog; `None`
/// if the user cancelled.
#[tauri::command(async)]
pub fn export_vault(
    placement: Placement,
    app: AppHandle,
    active_vault: State<'_, ActiveVault>,
    keys: State<SessionKeys>,
) -> Result<Option<ExportReport>, String> {
    let vault_root = active_vault.root()?;
    logged("export_vault", || {
        let Some(dest) = ask_path(&app, &active_vault, Ask::ExportTo, "Export to a new or empty folder", None)? else {
            return Ok(None);
        };
        export_vault_inner(&vault_root, &dest, &placement, &keys).map(Some)
    })
}

fn export_vault_inner(
    vault_root: &str,
    dest: &Path,
    placement: &Placement,
    keys: &SessionKeys,
) -> Result<ExportReport, String> {
    let root = resolve_rel_dir(vault_root, "")?;
    // Checked once up front, so a bad folder fails before anything is written.
    placement.dir("")?;
    let dest = empty_destination(dest, &root)?;

    let mut report = ExportReport::default();
    // Files first, so they keep their paths and a note that wants one moves aside.
    copy_files(&root, &dest, "", &mut report.files)?;

    let mut out = Output::new(dest.clone());
    let mut notes = note_paths(vault_root, keys)?;
    // Hidden notes last: they're the ones whose real paths can clash.
    notes.sort_by(|(a, a_disk), (b, b_disk)| (a != a_disk, a).cmp(&(b != b_disk, b)));
    for (rel_path, disk) in notes {
        match export_one(vault_root, &rel_path, placement, &mut out, keys) {
            Ok(Some(renamed)) => {
                report.notes += 1;
                report.renamed.push(renamed);
            }
            Ok(None) => report.notes += 1,
            Err(e) => match e.strip_prefix(LOCKED_ERR_PREFIX) {
                Some(profile) => report.locked.push(LockedNote { rel_path: disk, profile: profile.to_string() }),
                None => report.failed.push(ConvertFailure { rel_path, error: e }),
            },
        }
    }
    Ok(report)
}

/// Make sure `dest` is a new or empty folder outside `source` (a vault being
/// copied into it), creating it if need be, and return its canonical path.
pub(crate) fn empty_destination(dest: &Path, source: &Path) -> Result<PathBuf, String> {
    let exists = dest.exists();
    let canonical = match (exists, dest.parent(), dest.file_name()) {
        (true, _, _) => dest.canonicalize(),
        (false, Some(parent), Some(name)) => parent.canonicalize().map(|parent| parent.join(name)),
        _ => return Err("Invalid destination folder".to_string()),
    }
    .map_err(|e| format!("Invalid destination folder: {e}"))?;
    if canonical.starts_with(source) {
        return Err("The destination folder can't be inside the vault".to_string());
    }
    if exists {
        let empty = fs::read_dir(dest).map_err(|e| format!("Can't open the destination folder: {e}"))?.next().is_none();
        if !empty {
            return Err("The destination folder must be new or empty".to_string());
        }
    } else {
        fs::create_dir(dest).map_err(|e| format!("Failed to create the destination folder: {e}"))?;
    }
    Ok(canonical)
}

/// Copy every file under the vault folder `rel_dir` that isn't a note, except
/// dot entries and Mantle's `attachments/`, counting them in `count`.
fn copy_files(root: &Path, dest: &Path, rel_dir: &str, count: &mut usize) -> Result<(), String> {
    let entries = fs::read_dir(root.join(rel_dir)).map_err(|e| format!("Failed to read \"{rel_dir}\": {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || (rel_dir.is_empty() && name == ATTACHMENTS_DIR) {
            continue;
        }
        let rel = join(rel_dir, &name);
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                fs::create_dir_all(dest.join(&rel)).map_err(|e| format!("Failed to create \"{rel}\": {e}"))?;
                copy_files(root, dest, &rel, count)?;
            }
            Ok(t) if t.is_file() && !crate::vault::is_note_file(&name) => {
                fs::copy(entry.path(), dest.join(&rel)).map_err(|e| format!("Failed to copy \"{rel}\": {e}"))?;
                *count += 1;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Export the note the frontend knows as `rel_path` into `out`, returning how
/// it was renamed if its path was taken.
fn export_one(
    vault_root: &str,
    rel_path: &str,
    placement: &Placement,
    out: &mut Output,
    keys: &SessionKeys,
) -> Result<Option<Renamed>, String> {
    let note = read_note_text(vault_root, rel_path, keys)?;
    let wanted = join_rel_note_path(&note.dir, &note.stem, note.ext);
    let mut target = wanted.clone();
    let mut n = 1;
    while out.root.join(&target).exists() {
        n += 1;
        target = join_rel_note_path(&note.dir, &format!("{} ({n})", note.stem), note.ext);
    }
    let (body, _) = relink(vault_root, rel_path, &note, placement, out, keys)?;
    let markdown = note.render(&body)?;
    fs::create_dir_all(out.root.join(&note.dir)).map_err(|e| format!("Failed to create \"{}\": {e}", note.dir))?;
    fs::write(out.root.join(&target), markdown.as_bytes()).map_err(|e| format!("Failed to write \"{target}\": {e}"))?;
    Ok((target != wanted).then(|| Renamed { from: wanted, to: target }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::scan_vault_inner;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-export-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sub(name: &str) -> Placement {
        Placement::Subfolder { name: name.into() }
    }

    fn plain(root: &Path, rel: &str, tags: &[&str], body: &str) {
        let frontmatter = mntl_core::NoteFrontmatter {
            tags: tags.iter().map(|t| t.to_string()).collect(),
            ..Default::default()
        };
        fs::write(root.join(rel), mntl_core::encode_note(&frontmatter, body).unwrap()).unwrap();
    }

    /// A hidden note of `profile` in the root under `disk`, really at `location/name`.
    fn hidden_note(root: &Path, disk: &str, location: &str, name: &str, profile: &str, mk: &mntl_core::MasterKey, body: &str) {
        let frontmatter = mntl_core::NoteFrontmatter {
            location: Some(location.into()),
            name: Some(name.into()),
            ..Default::default()
        };
        let document = mntl_core::encode_note(&frontmatter, body).unwrap();
        fs::write(root.join(disk), mntl_core::encrypt_note_as(mk, profile, true, document.as_bytes()).unwrap()).unwrap();
    }

    #[test]
    fn placement_refuses_mantles_own_folder() {
        assert_eq!(sub("attachments").dir("Work").unwrap(), "Work/attachments");
        assert!(sub("attachments").dir("").is_err());
        assert!(sub("a/b").dir("").is_err());
        assert!(Placement::Folder { path: "attachments/x".into() }.dir("Work").is_err());
        assert!(Placement::Folder { path: "../out".into() }.dir("").is_err());
        assert!(Placement::Folder { path: ".mantle".into() }.dir("").is_err());
        assert_eq!(Placement::NextToNote.dir("Work").unwrap(), "Work");
        assert_eq!(Placement::VaultRoot.dir("Work").unwrap(), "");
        assert_eq!(relative("Work/Deep", "Work/files/a.png"), "../files/a.png");
        assert_eq!(relative("", "files/a.png"), "files/a.png");
    }

    #[test]
    fn converting_in_place_writes_markdown_and_copies_attachments_out() {
        let root = temp_dir("in-place");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        let mk = mntl_core::MasterKey::generate().unwrap();
        keys.unlock_for_test(&root_str, "diary", mk.clone()).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::create_dir_all(root.join("Work")).unwrap();
        fs::write(root.join("attachments/abc.png"), b"plain").unwrap();
        fs::write(root.join("attachments/sealed.png.enc"), mntl_core::encrypt_note(&mk, "diary", b"secret").unwrap()).unwrap();
        plain(&root, "Work/a.mntl", &["idea"], "![x](attachments/abc.png) ![[abc.png|200]] `![c](attachments/abc.png)`");
        hidden_note(&root, "zzz.mntl.enc", "Work", "Diary", "diary", &mk, "![s](attachments/sealed.png.enc)");
        scan_vault_inner(&root_str, &keys).unwrap();

        let notes = vec![
            ToMarkdownRequest { rel_path: "Work/a.mntl".into(), name: None },
            ToMarkdownRequest { rel_path: "Work/Diary.mntl.enc".into(), name: None },
        ];
        let report = convert_to_markdown_inner(&root_str, &notes, &sub("my files"), true, &keys).unwrap();
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(report.converted[1].rel_path, "Work/Diary.md", "a hidden note goes to its real path");
        assert_eq!(report.created, ["Work/my files/abc.png", "Work/my files/sealed.png"]);
        assert_eq!(report.removed, ["attachments/abc.png", "attachments/sealed.png.enc"]);
        assert!(!root.join("Work/a.mntl").exists() && !root.join("zzz.mntl.enc").exists());
        assert_eq!(fs::read(root.join("Work/my files/sealed.png")).unwrap(), b"secret");

        assert_eq!(
            fs::read_to_string(root.join("Work/a.md")).unwrap(),
            "---\ntags:\n- idea\n---\n![x](my%20files/abc.png) ![[Work/my files/abc.png|200]] `![c](attachments/abc.png)`"
        );
        assert_eq!(fs::read_to_string(root.join("Work/Diary.md")).unwrap(), "![s](my%20files/sealed.png)");

        // A taken name is refused, leaving the note as it was.
        plain(&root, "Work/b.mntl", &[], "B");
        fs::write(root.join("Work/b.md"), "other").unwrap();
        let notes = vec![ToMarkdownRequest { rel_path: "Work/b.mntl".into(), name: None }];
        let report = convert_to_markdown_inner(&root_str, &notes, &Placement::NextToNote, false, &keys).unwrap();
        assert_eq!(report.failed.len(), 1);
        assert!(root.join("Work/b.mntl").exists());
    }

    #[test]
    fn converting_in_place_skips_locked_notes() {
        let root = temp_dir("in-place-locked");
        let root_str = root.to_string_lossy().into_owned();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let document = mntl_core::encode_unencrypted_note("x").unwrap();
        fs::write(root.join("s.mntl.enc"), mntl_core::encrypt_note(&mk, "diary", document.as_bytes()).unwrap()).unwrap();
        let notes = vec![ToMarkdownRequest { rel_path: "s.mntl.enc".into(), name: None }];
        let report =
            convert_to_markdown_inner(&root_str, &notes, &Placement::NextToNote, false, &SessionKeys::default()).unwrap();
        assert_eq!(report.locked, ["s.mntl.enc"]);
        assert!(root.join("s.mntl.enc").exists());
    }

    #[test]
    fn exporting_writes_a_markdown_copy_and_leaves_the_vault_alone() {
        let root = temp_dir("export");
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let locked = mntl_core::MasterKey::generate().unwrap();
        keys.unlock_for_test(&root_str, "diary", mk.clone()).unwrap();
        for dir in [".mantle", "attachments", "Work", "Empty"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join(".mantle/state.json"), "{}").unwrap();
        fs::write(root.join("attachments/abc.png"), b"plain").unwrap();
        fs::write(root.join("attachments/unused.png"), b"unused").unwrap();
        fs::write(root.join("Work/spec.pdf"), b"pdf").unwrap();
        fs::write(root.join("Work/readme.md"), "---\nkeep: me\n---\n![](../attachments/abc.png)").unwrap();
        plain(&root, "Work/Ideas.mntl", &[], "[spec](spec.pdf) ![](attachments/abc.png)");
        plain(&root, "Work/Diary.mntl", &[], "a regular note at the hidden one's path");
        hidden_note(&root, "zzz.mntl.enc", "Work", "Diary", "diary", &mk, "hidden");
        let document = mntl_core::encode_unencrypted_note("x").unwrap();
        fs::write(root.join("Locked.mntl.enc"), mntl_core::encrypt_note(&locked, "work", document.as_bytes()).unwrap()).unwrap();
        scan_vault_inner(&root_str, &keys).unwrap();

        let out = temp_dir("export-out");
        fs::write(out.join("x"), "").unwrap();
        assert!(export_vault_inner(&root_str, &out, &Placement::VaultRoot, &keys).unwrap_err().contains("empty"));
        fs::remove_file(out.join("x")).unwrap();
        assert!(export_vault_inner(&root_str, &root.join("Work/out"), &Placement::VaultRoot, &keys).is_err());

        let report = export_vault_inner(&root_str, &out, &Placement::VaultRoot, &keys).unwrap();
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!((report.notes, report.files), (4, 1));
        assert_eq!(report.locked.len(), 1);
        assert_eq!((report.locked[0].rel_path.as_str(), report.locked[0].profile.as_str()), ("Locked.mntl.enc", "work"));
        assert_eq!(report.renamed.len(), 1);
        assert_eq!(report.renamed[0].to, "Work/Diary (2).md");

        let mut listing = Vec::new();
        fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let rel = join(rel, &entry.file_name().to_string_lossy());
                if entry.file_type().unwrap().is_dir() {
                    out.push(format!("{rel}/"));
                    walk(&entry.path(), &rel, out);
                } else {
                    out.push(rel);
                }
            }
        }
        walk(&out, "", &mut listing);
        listing.sort();
        assert_eq!(
            listing,
            ["Empty/", "Work/", "Work/Diary (2).md", "Work/Diary.md", "Work/Ideas.md", "Work/readme.md", "Work/spec.pdf", "abc.png"]
        );
        assert_eq!(fs::read_to_string(out.join("Work/Ideas.md")).unwrap(), "[spec](spec.pdf) ![](../abc.png)");
        assert_eq!(fs::read_to_string(out.join("Work/readme.md")).unwrap(), "---\nkeep: me\n---\n![](../abc.png)");
        assert_eq!(fs::read_to_string(out.join("Work/Diary (2).md")).unwrap(), "hidden");
        assert!(root.join("Work/Ideas.mntl").exists() && root.join("zzz.mntl.enc").exists());
    }
}
