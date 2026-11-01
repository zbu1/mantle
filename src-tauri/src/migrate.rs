//! Bringing another app's vault into a new Mantle vault, leaving the source
//! untouched. Only Obsidian so far ([`import_obsidian_vault`]): its folder is
//! copied, its embeds resolved the way Obsidian resolves them, and every
//! Markdown file converted into a Mantle note, the files it uses pulled into
//! `attachments/`.

use crate::attachments::link_sources;
use crate::credentials::{load_registry, SessionKeys};
use crate::export::empty_destination;
use crate::logging::logged;
use crate::notes_crypto::{convert_markdown_batch, ConvertFailure, ConvertRequest};
use crate::vault::{is_markdown_note, is_note_file, split_rel_note_path};
use crate::vault_meta::{write_vault_meta, VaultMeta};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::State;

/// Obsidian's own settings folder, which stays behind.
const OBSIDIAN_DIR: &str = ".obsidian";

/// What [`import_obsidian_vault`] did.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Markdown files that became Mantle notes.
    pub notes: usize,
    /// Every file copied, notes included.
    pub files: usize,
    pub failed: Vec<ConvertFailure>,
}

/// Copy the Obsidian vault `source` into `dest`, a new or empty folder, as a
/// new Mantle vault for the frontend to open.
#[tauri::command(async)]
pub fn import_obsidian_vault(source: String, dest: String, keys: State<SessionKeys>) -> Result<ImportReport, String> {
    logged("import_obsidian_vault", || import_obsidian_inner(Path::new(&source), Path::new(&dest), &keys))
}

fn import_obsidian_inner(source: &Path, dest: &Path, keys: &SessionKeys) -> Result<ImportReport, String> {
    let source = source.canonicalize().map_err(|e| format!("Can't open the Obsidian vault: {e}"))?;
    if !source.is_dir() {
        return Err("The Obsidian vault must be a folder".to_string());
    }
    let dest = empty_destination(dest, &source)?;
    let mut report = ImportReport::default();
    copy_tree(&source, &dest, "", &mut report.files)?;
    let vault_root = dest.to_string_lossy().into_owned();
    write_vault_meta(&vault_root, &VaultMeta::default())?;
    // A fresh vault has no profiles, so no hidden note can hold an imported
    // note's path; make sure, rather than assume.
    if !load_registry(&vault_root)?.profiles.is_empty() {
        return Err("The destination already has encrypted notes".to_string());
    }

    let (notes, files) = list_files(&dest);
    let attachment_setting = attachment_folder_setting(&source);
    let by_name = index_by_name(&files);
    for note in notes.iter().filter(|rel| is_markdown_note(rel)) {
        resolve_embeds_in(&dest.join(note), note, &attachment_setting, &by_name)?;
    }

    let requests: Vec<ConvertRequest> = notes
        .iter()
        .filter(|rel| is_markdown_note(rel))
        .map(|rel| ConvertRequest { rel_path: rel.clone(), name: split_rel_note_path(rel).1 })
        .collect();
    let converted = convert_markdown_batch(&vault_root, &requests, true, remove, keys)?;
    report.notes = converted.converted.len();
    report.failed = converted.failed;
    Ok(report)
}

/// The import's copies are its own: take them away for good, not to the trash.
fn remove(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| format!("Failed to remove the copied original: {e}"))
}

/// Copy everything under `source`/`rel_dir` into `dest`, except Obsidian's and
/// Mantle's own settings at the root, counting files in `count`.
fn copy_tree(source: &Path, dest: &Path, rel_dir: &str, count: &mut usize) -> Result<(), String> {
    let entries = fs::read_dir(source.join(rel_dir)).map_err(|e| format!("Failed to read \"{rel_dir}\": {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if rel_dir.is_empty() && (name == OBSIDIAN_DIR || name == crate::vault_meta::STATE_DIR) {
            continue;
        }
        let rel = if rel_dir.is_empty() { name } else { format!("{rel_dir}/{name}") };
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                fs::create_dir_all(dest.join(&rel)).map_err(|e| format!("Failed to create \"{rel}\": {e}"))?;
                copy_tree(source, dest, &rel, count)?;
            }
            Ok(t) if t.is_file() => {
                fs::copy(entry.path(), dest.join(&rel)).map_err(|e| format!("Failed to copy \"{rel}\": {e}"))?;
                *count += 1;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Every note and every other file under `root`, vault-relative, skipping
/// dot entries as a scan does.
fn list_files(root: &Path) -> (Vec<String>, Vec<String>) {
    fn walk(dir: &Path, rel_dir: &str, notes: &mut Vec<String>, files: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
            match entry.file_type() {
                Ok(t) if t.is_dir() => walk(&entry.path(), &rel, notes, files),
                Ok(t) if t.is_file() && is_note_file(&name) => notes.push(rel),
                Ok(t) if t.is_file() => files.push(rel),
                _ => {}
            }
        }
    }
    let (mut notes, mut files) = (Vec::new(), Vec::new());
    walk(root, "", &mut notes, &mut files);
    notes.sort();
    (notes, files)
}

/// Obsidian's "Default location for new attachments" (`attachmentFolderPath`
/// in `.obsidian/app.json`): `/` for the vault root, `./` or `./sub` beside
/// each note, or a vault folder. Empty if unset.
fn attachment_folder_setting(source: &Path) -> String {
    fs::read_to_string(source.join(OBSIDIAN_DIR).join("app.json"))
        .ok()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|app| app.get("attachmentFolderPath")?.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The vault folder `setting` puts the attachments of a note in `note_dir` in.
fn attachment_dir(setting: &str, note_dir: &str) -> String {
    let setting = setting.trim();
    match setting.strip_prefix("./") {
        Some(sub) => [note_dir, sub.trim_matches('/')].iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join("/"),
        None if setting == "." => note_dir.to_string(),
        None => setting.trim_matches('/').to_string(),
    }
}

fn dir_of(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// Files by lowercase name.
fn index_by_name(files: &[String]) -> HashMap<String, Vec<String>> {
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    for rel in files {
        by_name.entry(rel.rsplit('/').next().unwrap_or(rel).to_lowercase()).or_default().push(rel.clone());
    }
    by_name
}

/// The file an Obsidian `[[target]]` / `![[target]]` names, the way Obsidian
/// finds it: an exact vault path, else any file whose path ends with it,
/// preferring the note's attachment folder, then the note's own folder, then
/// the shortest path.
fn resolve_file(target: &str, note_rel: &str, setting: &str, by_name: &HashMap<String, Vec<String>>) -> Option<String> {
    let wanted = target.trim().trim_start_matches('/').to_lowercase();
    let name = wanted.rsplit('/').next()?;
    let candidates: Vec<&String> = by_name
        .get(name)?
        .iter()
        .filter(|rel| {
            let rel = rel.to_lowercase();
            rel == wanted || rel.ends_with(&format!("/{wanted}"))
        })
        .collect();
    let note_dir = dir_of(note_rel);
    let attachments = attachment_dir(setting, note_dir);
    candidates
        .iter()
        .find(|rel| rel.to_lowercase() == wanted)
        .or_else(|| candidates.iter().find(|rel| dir_of(rel) == attachments))
        .or_else(|| candidates.iter().find(|rel| dir_of(rel) == note_dir))
        .or_else(|| candidates.iter().min_by_key(|rel| (rel.len(), rel.as_str())))
        .map(|rel| rel.to_string())
}

/// Point every `[[file.ext]]` / `![[file.ext]]` in the Markdown file at `path`
/// (the note `note_rel`) at the file's full vault path, so converting it finds
/// the same file Obsidian would. Links to notes are left as they are.
fn resolve_embeds_in(path: &Path, note_rel: &str, setting: &str, by_name: &HashMap<String, Vec<String>>) -> Result<(), String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("Failed to read \"{note_rel}\": {e}"))?;
    let (frontmatter, body) = mntl_core::split_markdown_frontmatter(&raw);
    let mut out = String::with_capacity(raw.len());
    out.push_str(frontmatter);
    let mut last = 0;
    for source in link_sources(body).into_iter().filter(|s| s.wiki) {
        let target = &body[source.range.clone()];
        let is_file = target.rsplit('/').next().is_some_and(|name| name.contains('.') && !is_note_file(name));
        let Some(resolved) = is_file.then(|| resolve_file(target, note_rel, setting, by_name)).flatten() else { continue };
        out.push_str(&body[last..source.range.start]);
        out.push_str(&resolved);
        last = source.range.end;
    }
    if last == 0 {
        return Ok(());
    }
    out.push_str(&body[last..]);
    fs::write(path, out).map_err(|e| format!("Failed to update \"{note_rel}\": {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::read_note_inner;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-migrate-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn attachment_dir_follows_obsidians_setting() {
        assert_eq!(attachment_dir("", "Notes"), "");
        assert_eq!(attachment_dir("/", "Notes"), "");
        assert_eq!(attachment_dir("./", "Notes"), "Notes");
        assert_eq!(attachment_dir("./assets", "Notes"), "Notes/assets");
        assert_eq!(attachment_dir("./assets", ""), "assets");
        assert_eq!(attachment_dir("Files/Img", "Notes"), "Files/Img");
    }

    #[test]
    fn importing_copies_converts_and_pulls_embeds_in_without_touching_the_source() {
        let source = temp_dir("source");
        for dir in [".obsidian", "Notes", "Files", "Other"] {
            fs::create_dir_all(source.join(dir)).unwrap();
        }
        fs::write(source.join(".obsidian/app.json"), r#"{"attachmentFolderPath":"Files"}"#).unwrap();
        fs::write(source.join("Files/cat.png"), b"files cat").unwrap();
        fs::write(source.join("Other/cat.png"), b"other cat").unwrap();
        fs::write(source.join("Other/spec.pdf"), b"pdf").unwrap();
        fs::write(source.join("Notes/Pets.md"), "---\ntags: [pets]\n---\n![[cat.png|200]] [[spec.pdf]] [[Ideas]] ![[Ideas]]").unwrap();
        fs::write(source.join("Ideas.md"), "Thoughts").unwrap();
        let before = fs::read_to_string(source.join("Notes/Pets.md")).unwrap();

        let dest = temp_dir("dest").join("Vault");
        let keys = SessionKeys::default();
        let report = import_obsidian_inner(&source, &dest, &keys).unwrap();
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!((report.notes, report.files), (2, 5));
        assert_eq!(fs::read_to_string(source.join("Notes/Pets.md")).unwrap(), before, "the source is untouched");
        assert!(!dest.join(".obsidian").exists() && dest.join(".mantle/state.json").exists());
        assert!(!dest.join("Notes/Pets.md").exists() && dest.join("Ideas.mntl").exists());

        let root = dest.to_string_lossy().into_owned();
        let pets = read_note_inner(&root, "Notes/Pets.mntl", &keys).unwrap();
        assert_eq!(pets.tags, ["pets"]);
        let targets: Vec<&str> = link_sources(&pets.content).into_iter().map(|s| &pets.content[s.range]).collect();
        assert!(targets[0].starts_with("attachments/") && targets[1].starts_with("attachments/"), "{}", pets.content);
        assert_eq!(&targets[2..], ["Ideas", "Ideas"], "note links stay");
        assert_eq!(fs::read(dest.join(targets[0])).unwrap(), b"files cat", "the attachment folder wins");
        assert!(!dest.join("Files/cat.png").exists(), "pulled in, as no other note uses it");
        assert!(dest.join("Other/cat.png").exists());
    }
}
