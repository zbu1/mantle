//! Files attached to notes: the images they show, and any other file a
//! converted Markdown note linked to.
//!
//! Every attachment Mantle stores lives in the vault-level `attachments/` folder:
//!
//! - a plaintext note's as `attachments/<hash>.<ext>`, named by content so
//!   pasting the same image twice stores it once;
//! - an encrypted note's as `attachments/<random>.<ext>.enc`, sealed in the
//!   same envelope as a `.mntl.enc` note (with the file's bytes as its
//!   payload) under the note's profile. Random rather than hashed: a hash of
//!   the plaintext in the filename would let anyone check whether a vault
//!   holds a known file.
//!
//! Notes reference attachments with ordinary Markdown (`![alt](attachments/…)`,
//! `[spec](attachments/…)`), and wiki-style `![[photo.png|300]]` / `[[doc.pdf]]`
//! are read too. The webview loads images through the `mantle://` protocol
//! ([`serve`]), which decrypts sealed ones in memory, so a decrypted image
//! never touches the disk.
//!
//! Attachments are never modified once written — a duplicated note shares its
//! attachments with the original — so converting a note between plaintext and
//! a profile ([`reseal_attachments`]) writes new copies and leaves the old ones
//! behind. They are only deleted when the user asks, and only once nothing
//! else uses them ([`unused_attachments`]).

use crate::credentials::SessionKeys;
use crate::logging::logged;
use crate::vault::{
    is_markdown_note, master_key_for, note_paths, read_header_prefix, read_note_inner, resolve_rel_dir,
    resolve_rel_path, write_atomic, EXT_ENCRYPTED, EXT_PLAIN, LOCKED_ERR_PREFIX,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use percent_encoding::percent_decode_str;
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::ops::Range;
use std::path::Path;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, State, UriSchemeContext};
use zeroize::Zeroizing;

pub(crate) const ATTACHMENTS_DIR: &str = "attachments";

/// Suffix of an attachment sealed under a credential profile.
pub(crate) const EXT_SEALED: &str = ".enc";

/// The media an attachment may be that the editor shows (images, videos,
/// PDFs), and the media type each is served as.
const MEDIA_TYPES: [(&str, &str); 14] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("pdf", "application/pdf"),
    ("mp4", "video/mp4"),
    ("m4v", "video/mp4"),
    ("webm", "video/webm"),
    ("mov", "video/quicktime"),
    ("ogv", "video/ogg"),
];

fn media_type(ext: &str) -> Option<&'static str> {
    MEDIA_TYPES
        .iter()
        .find(|(known, _)| known.eq_ignore_ascii_case(ext))
        .map(|(_, media)| *media)
}

/// Whether a sealed copy of a file of this type goes in the chunked envelope
/// ([`mntl_core::encrypt_stream`]): the large media that's read a range at a time.
fn streamed(ext: &str) -> bool {
    media_type(ext).is_some_and(|media| media.starts_with("video/") || media == "application/pdf")
}

/// The media extension of `path` (lowercase, without any `.enc`) and whether
/// it is sealed, or `None` if it isn't media the editor shows — which is also
/// what stops [`serve`] from handing out anything else.
fn image_ext(path: &str) -> Option<(String, bool)> {
    let plain = path.strip_suffix(EXT_SEALED);
    let (_, ext) = plain.unwrap_or(path).rsplit_once('.')?;
    media_type(ext)?;
    Some((ext.to_ascii_lowercase(), plain.is_some()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `rel` is a note, rather than a file a note can attach.
fn is_note(rel: &str) -> bool {
    rel.ends_with(EXT_PLAIN) || rel.ends_with(EXT_ENCRYPTED) || is_markdown_note(rel)
}

/// The extension a copy of the attachment at `rel` is stored with: its own,
/// lowercase, under a sealed one's `.enc`. Empty if it has none Mantle can
/// keep.
fn stored_ext(rel: &str, sealed: bool) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let name = if sealed { name.strip_suffix(EXT_SEALED).unwrap_or(name) } else { name };
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_default()
}

/// Write a file into `attachments/`, sealed under `seal` if given, and return
/// its vault-relative path. `ext` may be empty, for a file without one.
fn store(
    vault_root: &str,
    bytes: &[u8],
    ext: &str,
    seal: Option<(&str, &mntl_core::MasterKey)>,
) -> Result<String, String> {
    let ext = ext.to_ascii_lowercase();
    // Any type but a note's, which would turn the copy into a note.
    if !ext.chars().all(|c| c.is_ascii_alphanumeric()) || (!ext.is_empty() && is_note(&format!(".{ext}"))) {
        return Err(format!("Unsupported attachment type: .{ext}"));
    }
    let dot_ext = if ext.is_empty() { String::new() } else { format!(".{ext}") };
    let root = resolve_rel_dir(vault_root, "")?;
    fs::create_dir_all(root.join(ATTACHMENTS_DIR))
        .map_err(|e| format!("Failed to create the attachments folder: {e}"))?;
    let dir = resolve_rel_dir(vault_root, ATTACHMENTS_DIR)?;

    let name = match seal {
        Some((profile_id, mk)) => {
            let mut id = [0u8; 16];
            OsRng.fill_bytes(&mut id);
            let name = format!("{}{dot_ext}{EXT_SEALED}", hex(&id));
            let blob = if streamed(&ext) {
                mntl_core::encrypt_stream(mk, profile_id, bytes, mntl_core::STREAM_CHUNK)
            } else {
                mntl_core::encrypt_note(mk, profile_id, bytes)
            }
            .map_err(|e| e.to_string())?;
            write_atomic(&dir.join(&name), &blob)?;
            name
        }
        None => {
            let name = format!("{}{dot_ext}", hex(&Sha256::digest(bytes)[..16]));
            let path = dir.join(&name);
            if !path.exists() {
                write_atomic(&path, bytes)?;
            }
            name
        }
    };
    Ok(format!("{ATTACHMENTS_DIR}/{name}"))
}

/// The attachment at vault-relative `rel_path`, decrypted if it is sealed. One
/// sealed under a locked profile is the `mantle:locked:<id>` sentinel, as for
/// a note.
pub(crate) fn load(vault_root: &str, rel_path: &str, keys: &SessionKeys) -> Result<Zeroizing<Vec<u8>>, String> {
    if is_note(rel_path) {
        return Err("Not an attachment".to_string());
    }
    let bytes = fs::read(resolve_rel_path(vault_root, rel_path)?)
        .map_err(|e| format!("Failed to read attachment: {e}"))?;
    if !(rel_path.ends_with(EXT_SEALED) && bytes.starts_with(mntl_core::MAGIC_MENC)) {
        return Ok(Zeroizing::new(bytes));
    }
    let (_, mk) = master_key_for(vault_root, &bytes, keys)?;
    mntl_core::decrypt_note(&mk, &bytes).map_err(|e| e.to_string())
}

/// Join `src` onto the vault-relative `dir`, resolving `.` and `..`. `None`
/// if it climbs out of the vault or names nothing.
fn join_normalized(dir: &str, src: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for part in src.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The vault-relative path of the first file named `name`, skipping hidden
/// folders as a scan does.
// ponytail: walks the whole vault per lookup; build a name index if large vaults get slow.
fn find_by_name(dir: &Path, rel_dir: &str, name: &str) -> Option<String> {
    let mut subdirs = Vec::new();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name.starts_with('.') {
            continue;
        }
        let rel = if rel_dir.is_empty() { entry_name.clone() } else { format!("{rel_dir}/{entry_name}") };
        match entry.file_type() {
            Ok(t) if t.is_file() && entry_name == name => return Some(rel),
            Ok(t) if t.is_dir() => subdirs.push((entry.path(), rel)),
            _ => {}
        }
    }
    subdirs.into_iter().find_map(|(path, rel)| find_by_name(&path, &rel, name))
}

/// The vault-relative path of the file a link or embed `src` in the note at
/// `note_rel` points to, or `None` for a remote URL, a missing file or a note.
///
/// Tried in the order wiki-style embeds are usually resolved: relative to the note, then to
/// the vault root (which is how Mantle writes them), then — for a bare file
/// name, as `![[photo.png]]` usually is — anywhere in the vault.
pub(crate) fn resolve_attachment(vault_root: &str, note_rel: &str, src: &str) -> Option<String> {
    // `http:`, `data:`, `C:\`: not a vault file.
    if src.contains(':') {
        return None;
    }
    // markdown-it percent-encodes the destinations it parses (a space as %20).
    let src = percent_decode_str(src).decode_utf8_lossy();
    let note_dir = note_rel.rsplit_once('/').map_or("", |(dir, _)| dir);
    let is_attachment =
        |rel: &String| !is_note(rel) && resolve_rel_path(vault_root, rel).is_ok_and(|p| p.is_file());
    [join_normalized(note_dir, &src), join_normalized("", &src)]
        .into_iter()
        .flatten()
        .find(is_attachment)
        .or_else(|| {
            // Without an extension it names a note (`[[Plans]]`), so spare the walk.
            if src.contains(['/', '\\']) || !src.contains('.') {
                return None;
            }
            let root = resolve_rel_dir(vault_root, "").ok()?;
            find_by_name(&root, "", &src).filter(is_attachment)
        })
}

/// The byte ranges of `markdown` that are code — fenced blocks and inline
/// spans — where a link is only text.
// ponytail: no indented code blocks, which a line scan can't tell from a list
// item's continuation; walk markdown-it's tokens if one ever matters.
fn code_ranges(markdown: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    // The open fence's marker, its length, and where it started.
    let mut fence: Option<(u8, usize, usize)> = None;
    let mut start = 0;
    for line in markdown.split_inclusive('\n') {
        let end = start + line.len();
        let trimmed = line.trim_start_matches(' ');
        let marker = trimmed.bytes().next().filter(|b| matches!(b, b'`' | b'~'));
        let run = marker.map_or(0, |m| trimmed.bytes().take_while(|&b| b == m).count());
        let fence_line = line.len() - trimmed.len() < 4 && run >= 3;
        match fence {
            Some((m, len, from)) => {
                if fence_line && marker == Some(m) && run >= len && trimmed[run..].trim().is_empty() {
                    ranges.push(from..end);
                    fence = None;
                }
            }
            // A backtick fence's info string can't hold a backtick.
            None if fence_line && !(marker == Some(b'`') && trimmed[run..].contains('`')) => {
                fence = marker.map(|m| (m, run, start));
            }
            None => inline_code(line, start, &mut ranges),
        }
        start = end;
    }
    if let Some((_, _, from)) = fence {
        ranges.push(from..markdown.len());
    }
    ranges
}

/// Push the inline code spans of `line`, which starts at byte `offset`: a run
/// of backticks up to the next run of the same length.
fn inline_code(line: &str, offset: usize, ranges: &mut Vec<Range<usize>>) {
    let bytes = line.as_bytes();
    let run_at = |i: usize| bytes[i..].iter().take_while(|&&b| b == b'`').count();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let run = run_at(i);
        let mut j = i + run;
        let mut close = None;
        while j < bytes.len() {
            if bytes[j] != b'`' {
                j += 1;
                continue;
            }
            let len = run_at(j);
            if len == run {
                close = Some(j + len);
                break;
            }
            j += len;
        }
        match close {
            Some(end) => {
                ranges.push(offset + i..offset + end);
                i = end;
            }
            None => i += run,
        }
    }
}

/// A link or embed in a note's Markdown.
pub(crate) struct Source {
    /// The byte range of its target.
    pub range: Range<usize>,
    /// Whether it embeds (`![…]`) rather than links.
    pub embed: bool,
    /// Whether it's a `[[wikilink]]`, rather than a Markdown link.
    pub wiki: bool,
}

/// Every link and embed in `markdown` outside code, in document order: the
/// destination of `[text](src "title")` / `![alt](src)` (inside its `<>`, if
/// any) and the target of wiki-style `[[src|alias]]` / `![[src|size]]`, each
/// without a `#fragment`.
// ponytail: no reference-style links (`[text][ref]`); add them if converted
// vaults turn out to use them.
pub(crate) fn link_sources(markdown: &str) -> Vec<Source> {
    let code = code_ranges(markdown);
    let bytes = markdown.as_bytes();
    let mut sources = Vec::new();
    let mut from = 0;
    while let Some(at) = markdown[from..].find('[').map(|i| from + i) {
        from = at + 1;
        if (at > 0 && bytes[at - 1] == b'\\') || code.iter().any(|r| r.contains(&at)) {
            continue;
        }
        let embed = at > 0 && bytes[at - 1] == b'!';
        let line_end = markdown[at..].find('\n').map_or(markdown.len(), |i| at + i);

        if let Some(inner) = markdown[from..line_end].strip_prefix('[') {
            let Some(close) = inner.find("]]") else { continue };
            let mut len = inner[..close].find(['|', '#']).unwrap_or(close);
            // In a table the `|` is escaped: `[[note\|alias]]`.
            if inner[..len].ends_with('\\') && inner[len..].starts_with('|') {
                len -= 1;
            }
            sources.push(Source { range: at + 2..at + 2 + len, embed, wiki: true });
            from = at + 2 + close + 2;
            continue;
        }

        // The `]` closing this `[`, past any nested in its text.
        let mut depth = 0;
        let close = markdown[at..line_end].char_indices().find_map(|(i, c)| {
            match c {
                '[' => depth += 1,
                ']' => depth -= 1,
                _ => return None,
            }
            (depth == 0).then_some(at + i)
        });
        let Some(rest) = close.and_then(|close| markdown[close + 1..line_end].strip_prefix('(')) else {
            continue;
        };
        let start = line_end - rest.len();
        let range = if let Some(bracketed) = rest.strip_prefix('<') {
            let Some(end) = bracketed.find('>') else { continue };
            start + 1..start + 1 + end
        } else {
            let end = rest.find(|c: char| c.is_whitespace() || c == ')').unwrap_or(rest.len());
            start..start + end
        };
        let end = markdown[range.clone()].find('#').map_or(range.end, |i| range.start + i);
        // Scanning goes on inside the text: `[![img](a.png)](b.pdf)` has two.
        sources.push(Source { range: range.start..end, embed, wiki: false });
    }
    sources.retain(|source| !source.range.is_empty());
    sources.sort_by_key(|source| source.range.start);
    sources
}

/// How much of a note's attachments [`reseal_attachments`] carries along.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Relink {
    /// A save, which must never fail over a link: an attachment it can't copy
    /// (one sealed under a locked profile) is left as it is.
    Save,
    /// A conversion between plaintext and a profile.
    Convert,
    /// A Markdown file becoming a note: every local file it links or embeds,
    /// wherever it is, is copied into `attachments/` too.
    Import,
}

/// Re-point every attachment in `document`, the body of the note at
/// `note_rel`, at a copy sealed under `target` — or a plaintext copy when
/// `target` is `None` — so the note never depends on one less protected than
/// itself, or on a profile it no longer belongs to.
///
/// An attachment is an image the note shows or any file in `attachments/`; a
/// link to one of the user's other files stays a link to it, except under
/// [`Relink::Import`]. Ones already in the right form, remote URLs and missing
/// files are left alone.
///
/// This is what makes an attachment belong to a profile: a sealed one is only
/// ever referenced by notes of its own profile, and a plaintext one only by
/// plaintext notes — which is what lets [`unused_attachments`] judge one
/// without unlocking every profile.
///
/// Returns the new document, each source it re-pointed (as written in the
/// note) with the copy it now points at, and the files it copied from.
pub(crate) fn reseal_attachments(
    vault_root: &str,
    note_rel: &str,
    document: &str,
    target: Option<(&str, &mntl_core::MasterKey)>,
    keys: &SessionKeys,
    mode: Relink,
) -> Result<(Zeroizing<String>, HashMap<String, String>, BTreeSet<String>), String> {
    let mut out = Zeroizing::new(String::with_capacity(document.len()));
    let mut copies: HashMap<String, String> = HashMap::new();
    let mut relinked = HashMap::new();
    let mut last = 0;

    for Source { range, embed, .. } in link_sources(document) {
        let src = &document[range.clone()];
        let Some(rel) = resolve_attachment(vault_root, note_rel, src) else {
            continue;
        };
        let managed = is_managed(&rel);
        if mode != Relink::Import && !managed && !(embed && image_ext(&rel).is_some()) {
            continue;
        }
        let profile = sealed_profile(vault_root, &rel);
        let right_form = match target {
            None => profile.is_none(),
            Some((profile_id, _)) => profile.as_deref() == Some(profile_id),
        };
        if right_form && (managed || mode != Relink::Import) {
            continue;
        }

        let copy = match copies.get(&rel) {
            Some(copy) => copy.clone(),
            None => {
                let copied = load(vault_root, &rel, keys)
                    .map_err(|e| match e.strip_prefix(LOCKED_ERR_PREFIX) {
                        Some(profile) => format!("Unlock \"{profile}\" first: this note uses a file encrypted under it"),
                        None => e,
                    })
                    .and_then(|bytes| store(vault_root, &bytes, &stored_ext(&rel, profile.is_some()), target));
                let copy = match copied {
                    Ok(copy) => copy,
                    Err(_) if mode == Relink::Save => continue,
                    Err(e) => return Err(e),
                };
                copies.insert(rel, copy.clone());
                copy
            }
        };
        relinked.insert(src.to_string(), copy.clone());
        out.push_str(&document[last..range.start]);
        out.push_str(&copy);
        last = range.end;
    }

    out.push_str(&document[last..]);
    Ok((out, relinked, copies.into_keys().collect()))
}

/// Whether `rel` is a file directly in the vault-root `attachments/` folder —
/// one Mantle stored and manages — rather than one of the user's own files.
pub(crate) fn is_managed(rel: &str) -> bool {
    rel.strip_prefix(ATTACHMENTS_DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|name| !name.is_empty() && !name.contains('/'))
}

/// The credential profile the sealed attachment at `rel` is encrypted under,
/// read from its header; `None` for a plaintext one.
fn sealed_profile(vault_root: &str, rel: &str) -> Option<String> {
    if !rel.ends_with(EXT_SEALED) || is_note(rel) {
        return None;
    }
    let header = read_header_prefix(&resolve_rel_path(vault_root, rel).ok()?).ok()?;
    mntl_core::extract_encrypted_header(&header).ok().map(|h| h.credential_profile)
}

/// Where an attachment reference in a note leads, for the editor to show.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    /// The vault-relative path the reference resolved to.
    pub rel_path: String,
    /// Whether it is in Mantle's `attachments/` folder, rather than one of the
    /// user's own files elsewhere in the vault.
    pub managed: bool,
    /// The credential profile it is sealed under, or `None` if plaintext.
    pub profile: Option<String>,
}

/// What the attachment `src` in the note at `note_rel_path` resolves to, or
/// `None` for a remote URL or a missing file.
#[tauri::command]
pub fn attachment_info(vault_root: String, note_rel_path: String, src: String) -> Option<AttachmentInfo> {
    let rel_path = resolve_attachment(&vault_root, &note_rel_path, &src)?;
    Some(AttachmentInfo {
        managed: is_managed(&rel_path),
        profile: sealed_profile(&vault_root, &rel_path),
        rel_path,
    })
}

/// The files that `content`, the text of the note at `note_rel`, references.
/// With `only`, sources whose file name none of those paths has are skipped
/// unresolved, which spares a vault-wide walk for every bare `![[name.png]]`
/// in every note.
fn referenced(vault_root: &str, note_rel: &str, content: &str, only: Option<&BTreeSet<String>>) -> HashSet<String> {
    link_sources(content)
        .into_iter()
        .map(|source| &content[source.range])
        .filter(|src| {
            only.is_none_or(|only| {
                let src = percent_decode_str(src).decode_utf8_lossy();
                let name = src.rsplit(['/', '\\']).next().unwrap_or_default();
                only.iter().any(|rel| rel.rsplit('/').next() == Some(name))
            })
        })
        .filter_map(|src| resolve_attachment(vault_root, note_rel, src))
        .collect()
}

/// Which managed attachments could go along with some notes.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnusedAttachments {
    /// Attachments no note outside the ones being deleted references.
    pub paths: Vec<String>,
    /// Notes being deleted that couldn't be read — locked — so their
    /// attachments are unknown and not in `paths`.
    pub unchecked: Vec<String>,
}

/// The managed attachments among `candidates` and those the notes in
/// `deleting` reference, that no other note uses.
///
/// Every readable note is checked; see [`unreferenced`] for a locked one.
#[tauri::command]
pub fn unused_attachments(
    vault_root: String,
    deleting: Vec<String>,
    candidates: Vec<String>,
    keys: State<SessionKeys>,
) -> Result<UnusedAttachments, String> {
    logged("unused_attachments", || unused_attachments_inner(&vault_root, &deleting, &candidates, &keys))
}

// ponytail: reads every note in the vault per call; keep a reference index if
// big vaults make deleting slow.
fn unused_attachments_inner(
    vault_root: &str,
    deleting: &[String],
    candidates: &[String],
    keys: &SessionKeys,
) -> Result<UnusedAttachments, String> {
    let mut unchecked = Vec::new();
    let mut found: BTreeSet<String> = candidates.iter().filter(|rel| is_managed(rel)).cloned().collect();
    for note in deleting {
        match read_note_inner(vault_root, note, keys) {
            Ok(doc) => found.extend(
                referenced(vault_root, note, &doc.content, None).into_iter().filter(|rel| is_managed(rel)),
            ),
            Err(_) => unchecked.push(note.clone()),
        }
    }
    let paths = unreferenced(vault_root, found, deleting, keys)?;
    Ok(UnusedAttachments { paths: paths.into_iter().collect(), unchecked })
}

/// The files among `found` that no note but those in `skip` references.
///
/// A locked note can't be read, so it keeps what it might be using: every
/// attachment sealed under its own profile — it can't hold any other, as
/// [`reseal_attachments`] keeps a note's attachments under its own profile —
/// and every file outside `attachments/`, which a save leaves linked as it is.
pub(crate) fn unreferenced(
    vault_root: &str,
    mut found: BTreeSet<String>,
    skip: &[String],
    keys: &SessionKeys,
) -> Result<BTreeSet<String>, String> {
    found.retain(|rel| resolve_rel_path(vault_root, rel).is_ok_and(|path| path.is_file()));
    let profiles: HashMap<String, Option<String>> =
        found.iter().map(|rel| (rel.clone(), sealed_profile(vault_root, rel))).collect();

    for (note, _) in note_paths(vault_root, keys)? {
        if found.is_empty() {
            break;
        }
        if skip.contains(&note) {
            continue;
        }
        match read_note_inner(vault_root, &note, keys) {
            Ok(doc) => {
                let used = referenced(vault_root, &note, &doc.content, Some(&found));
                found.retain(|rel| !used.contains(rel));
            }
            Err(e) => {
                if let Some(profile) = e.strip_prefix(LOCKED_ERR_PREFIX) {
                    found.retain(|rel| is_managed(rel) && profiles[rel].as_deref() != Some(profile));
                }
            }
        }
    }
    Ok(found)
}

/// Every attachment sealed under `profile_id`.
#[tauri::command]
pub fn profile_attachments(vault_root: String, profile_id: String) -> Result<Vec<String>, String> {
    logged("profile_attachments", || {
        let Ok(entries) = fs::read_dir(resolve_rel_dir(&vault_root, "")?.join(ATTACHMENTS_DIR)) else {
            return Ok(Vec::new());
        };
        Ok(entries
            .flatten()
            .map(|entry| format!("{ATTACHMENTS_DIR}/{}", entry.file_name().to_string_lossy()))
            .filter(|rel| rel.ends_with(EXT_SEALED))
            .filter(|rel| sealed_profile(&vault_root, rel).as_deref() == Some(profile_id.as_str()))
            .collect())
    })
}

/// Move managed attachments to the OS trash. Only ever files directly in
/// `attachments/`: a user's own files are theirs to delete.
#[tauri::command]
pub fn delete_attachments(vault_root: String, paths: Vec<String>) -> Result<(), String> {
    logged("delete_attachments", || delete_attachments_inner(&vault_root, &paths))
}

fn delete_attachments_inner(vault_root: &str, paths: &[String]) -> Result<(), String> {
    for rel in paths {
        if !is_managed(rel) {
            return Err(format!("Not a Mantle attachment: {rel}"));
        }
        let path = resolve_rel_path(vault_root, rel)?;
        // Tests unlink rather than fill the developer's recycle bin.
        #[cfg(not(test))]
        let result = crate::vault::move_to_trash(&path).map_err(|e| e.to_string());
        #[cfg(test)]
        let result = fs::remove_file(&path).map_err(|e| e.to_string());
        result.map_err(|e| format!("Failed to delete attachment: {e}"))?;
    }
    Ok(())
}

/// Store an image for the note at `note_rel`: sealed under the note's profile
/// if the note is encrypted, so its images are never less protected than it.
fn save_for_note(
    vault_root: &str,
    note_rel: &str,
    bytes: &[u8],
    ext: &str,
    keys: &SessionKeys,
) -> Result<String, String> {
    if !note_rel.ends_with(EXT_ENCRYPTED) {
        return store(vault_root, bytes, ext, None);
    }
    let header = read_header_prefix(&crate::hidden::resolve_note(vault_root, note_rel, keys)?)?;
    let (profile_id, mk) = master_key_for(vault_root, &header, keys)?;
    store(vault_root, bytes, ext, Some((&profile_id, &mk)))
}

/// Save a pasted or dropped image (base64 `data`) for the note at
/// `note_rel_path`, returning the vault-relative path to reference it by.
#[tauri::command]
pub fn save_attachment(
    vault_root: String,
    note_rel_path: String,
    data: String,
    ext: String,
    keys: State<SessionKeys>,
) -> Result<String, String> {
    logged("save_attachment", || {
        let bytes = Zeroizing::new(BASE64.decode(data).map_err(|_| "Invalid image data".to_string())?);
        save_for_note(&vault_root, &note_rel_path, &bytes, &ext, &keys)
    })
}

/// Copy the image file at `source_path` (picked from the OS file dialog) in
/// for the note at `note_rel_path`, as [`save_attachment`] does.
#[tauri::command]
pub fn import_attachment(
    vault_root: String,
    note_rel_path: String,
    source_path: String,
    keys: State<SessionKeys>,
) -> Result<String, String> {
    logged("import_attachment", || {
        let (ext, _) = image_ext(&source_path).ok_or("Not a supported image, video or PDF file")?;
        let bytes = Zeroizing::new(fs::read(&source_path).map_err(|e| format!("Failed to read image: {e}"))?);
        save_for_note(&vault_root, &note_rel_path, &bytes, &ext, &keys)
    })
}

/// Write the attachment at `rel_path`, decrypted if it is sealed, to
/// `dest_path` (picked from the OS save dialog). The one way a sealed
/// attachment leaves Mantle as plaintext, and only on the user's say.
#[tauri::command]
pub fn save_attachment_copy(
    vault_root: String,
    rel_path: String,
    dest_path: String,
    keys: State<SessionKeys>,
) -> Result<(), String> {
    logged("save_attachment_copy", || {
        let bytes = load(&vault_root, &rel_path, &keys)?;
        fs::write(&dest_path, bytes.as_slice()).map_err(|e| format!("Failed to save the copy: {e}"))
    })
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode_str(v).decode_utf8_lossy().into_owned())
    })
}

/// Most a request for an open-ended range (`bytes=N-`, which is how a video
/// asks for the rest of itself) gets at once, so a long video is decrypted
/// as it plays rather than all up front.
const MAX_OPEN_RANGE: u64 = 4 * 1024 * 1024;

/// The bytes `start..end` an HTTP `Range` header asks for, of `len`, or
/// `None` if it asks for none of them. Only a single range is honored.
fn parse_range(range: &str, len: u64) -> Option<(u64, u64)> {
    let spec = range.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => (len.saturating_sub(suffix.parse().ok()?), len),
        (start, "") => {
            let start: u64 = start.parse().ok()?;
            (start, len.min(start.saturating_add(MAX_OPEN_RANGE)))
        }
        (start, end) => (start.parse().ok()?, len.min(end.parse::<u64>().ok()?.saturating_add(1))),
    };
    (start < end).then_some((start, end))
}

/// The attachment at `rel_path`, or the bytes `range` of it, with its whole
/// length. Only what's asked for is read and decrypted, from a plaintext file
/// or a chunked envelope; an envelope sealed whole is decrypted whole.
fn load_range(
    vault_root: &str,
    rel_path: &str,
    range: Option<&str>,
    keys: &SessionKeys,
) -> Result<(Zeroizing<Vec<u8>>, Option<(u64, u64)>, u64), String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = resolve_rel_path(vault_root, rel_path)?;
    let file_len = fs::metadata(&path).map_err(|e| format!("Failed to read attachment: {e}"))?.len();
    let read_at = |offset: u64, len: u64| -> Result<Zeroizing<Vec<u8>>, String> {
        let mut file = fs::File::open(&path).map_err(|e| format!("Failed to read attachment: {e}"))?;
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = Zeroizing::new(vec![0u8; len as usize]);
        file.read_exact(&mut buf).map_err(|e| format!("Failed to read attachment: {e}"))?;
        Ok(buf)
    };

    let head = rel_path.ends_with(EXT_SEALED).then(|| read_header_prefix(&path).ok()).flatten();
    let chunked = head
        .as_deref()
        .and_then(|head| mntl_core::extract_encrypted_header(head).ok())
        .is_some_and(|header| header.v == mntl_core::STREAM_VERSION);
    if chunked {
        let head = head.unwrap_or_default();
        let (_, mk) = master_key_for(vault_root, &head, keys)?;
        let stream = mntl_core::SealedStream::open(&mk, &head, file_len).map_err(|e| e.to_string())?;
        let total = stream.len();
        let Some((start, end)) = range.map_or(Some((0, total)), |range| parse_range(range, total)) else {
            return Ok((Zeroizing::new(Vec::new()), None, total));
        };
        let span = stream.chunks_for(start, end);
        let plain = stream
            .decrypt_chunks(span.first, &read_at(span.file_offset, span.file_len)?)
            .map_err(|e| e.to_string())?;
        let from = (start - span.plaintext_offset) as usize;
        let bytes = Zeroizing::new(plain[from..from + (end - start) as usize].to_vec());
        return Ok((bytes, range.map(|_| (start, end)), total));
    }
    if head.is_none() {
        let Some((start, end)) = range.map_or(Some((0, file_len)), |range| parse_range(range, file_len)) else {
            return Ok((Zeroizing::new(Vec::new()), None, file_len));
        };
        return Ok((read_at(start, end - start)?, range.map(|_| (start, end)), file_len));
    }
    let whole = load(vault_root, rel_path, keys)?;
    let total = whole.len() as u64;
    let Some((start, end)) = range.map_or(Some((0, total)), |range| parse_range(range, total)) else {
        return Ok((Zeroizing::new(Vec::new()), None, total));
    };
    Ok((Zeroizing::new(whole[start as usize..end as usize].to_vec()), range.map(|_| (start, end)), total))
}

/// Answer a `mantle://localhost/?vault=…&note=…&src=…` request with the
/// image, video or PDF `src` refers to from that note, decrypting it if it is
/// sealed. A `Range` request gets just those bytes, which is how a video
/// streams.
///
/// Responses are `no-store`, so decrypted media is never written to the
/// webview's disk cache — and so locking a profile takes effect on the next
/// render rather than whenever a cache entry expires.
fn serve(keys: &SessionKeys, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let respond = |status: StatusCode, media: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, media)
            .header(header::CACHE_CONTROL, "no-store")
            // pdf.js fetches from the app's own origin, which isn't this scheme's.
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCEPT_RANGES, "bytes")
            .body(body)
            .unwrap_or_default()
    };
    let query = request.uri().query().unwrap_or("");
    let (Some(vault), Some(note), Some(src)) =
        (query_param(query, "vault"), query_param(query, "note"), query_param(query, "src"))
    else {
        return respond(StatusCode::BAD_REQUEST, "text/plain", Vec::new());
    };
    let Some((rel, media)) = resolve_attachment(&vault, &note, &src)
        .and_then(|rel| Some((rel.clone(), media_type(&image_ext(&rel)?.0)?)))
    else {
        return respond(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    let range = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
    match load_range(&vault, &rel, range, keys) {
        Ok((bytes, Some((start, end)), total)) => {
            let mut response = respond(StatusCode::PARTIAL_CONTENT, media, bytes.to_vec());
            if let Ok(value) = format!("bytes {start}-{}/{total}", end - 1).parse() {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            response
        }
        Ok((_, None, total)) if range.is_some() => {
            let mut response = respond(StatusCode::RANGE_NOT_SATISFIABLE, media, Vec::new());
            if let Ok(value) = format!("bytes */{total}").parse() {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            response
        }
        Ok((bytes, None, _)) => respond(StatusCode::OK, media, bytes.to_vec()),
        Err(e) if e.starts_with(LOCKED_ERR_PREFIX) => respond(StatusCode::FORBIDDEN, "text/plain", Vec::new()),
        Err(_) => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

/// The `mantle://` protocol handler, served off the main thread since
/// decrypting a large image takes a moment.
pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(serve(&app.state::<SessionKeys>(), &request));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mntl-attachments-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really a png";

    fn sources(md: &str) -> Vec<(&str, bool)> {
        link_sources(md).into_iter().map(|s| (&md[s.range], s.embed)).collect()
    }

    #[test]
    fn link_sources_finds_markdown_and_wiki_links_and_embeds() {
        let md = "a ![x](one.png) b ![](<two words.png> \"t\") ![[three.png|300]] [[four.pdf#page=2]] \
                  [link](five.zip) [![img](six.png)](seven.pdf) [[Note|alias]] [x](#top) \\[no](esc.png) ![bad\n](x) \
                  | [[In table\\|alias]] | ![[eight.png\\|300]] |";
        assert_eq!(
            sources(md),
            [
                ("one.png", true),
                ("two words.png", true),
                ("three.png", true),
                ("four.pdf", false),
                ("five.zip", false),
                ("six.png", true),
                ("seven.pdf", false),
                ("Note", false),
                ("In table", false),
                ("eight.png", true),
            ]
        );
    }

    #[test]
    fn link_sources_skips_code() {
        let md = "`[a](in.png)` [b](out.png)\n```md\n![c](fenced.png)\n```\n~~~~\n[d](x.pdf)\n~~~\n[e](still.pdf)\n~~~~\n``[f](two.png)`` ![g](after.png)\n```\n[h](unclosed.png)";
        assert_eq!(sources(md), [("out.png", false), ("after.png", true)]);
    }

    #[test]
    fn plaintext_images_are_deduplicated_and_sealed_ones_are_not() {
        let root = temp_dir("store");
        let root_str = root.to_string_lossy().into_owned();
        let a = store(&root_str, PNG, "PNG", None).unwrap();
        assert_eq!(a, store(&root_str, PNG, "png", None).unwrap());
        assert!(a.starts_with("attachments/") && a.ends_with(".png"));
        assert_eq!(fs::read(root.join(&a)).unwrap(), PNG);

        let mk = mntl_core::MasterKey::generate().unwrap();
        let b = store(&root_str, PNG, "png", Some(("diary", &mk))).unwrap();
        let c = store(&root_str, PNG, "png", Some(("diary", &mk))).unwrap();
        assert_ne!(b, c);
        assert!(b.ends_with(".png.enc"));
        let blob = fs::read(root.join(&b)).unwrap();
        assert!(!blob.windows(PNG.len()).any(|w| w == PNG));

        let keys = SessionKeys::default();
        assert_eq!(load(&root_str, &b, &keys).unwrap_err(), format!("{LOCKED_ERR_PREFIX}diary"));
        keys.unlock_for_test(&root_str, "diary", mk).unwrap();
        assert_eq!(load(&root_str, &b, &keys).unwrap().as_slice(), PNG);

        assert!(store(&root_str, PNG, "zip", None).unwrap().ends_with(".zip"));
        assert!(!store(&root_str, PNG, "", None).unwrap().contains('.'));
        assert!(store(&root_str, PNG, "md", None).is_err(), "a copy must never become a note");
        assert!(store(&root_str, PNG, "a/b", None).is_err());
    }

    #[test]
    fn ranges_are_read_from_plaintext_and_chunked_files_alike() {
        assert_eq!(parse_range("bytes=2-5", 10), Some((2, 6)));
        assert_eq!(parse_range("bytes=7-", 10), Some((7, 10)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 10)));
        assert_eq!(parse_range("bytes=4-100", 10), Some((4, 10)));
        assert_eq!(parse_range("bytes=10-", 10), None);
        assert_eq!(parse_range("bytes=0-", 10 * MAX_OPEN_RANGE), Some((0, MAX_OPEN_RANGE)));

        let root = temp_dir("ranges");
        let root_str = root.to_string_lossy().into_owned();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let keys = SessionKeys::default();
        keys.unlock_for_test(&root_str, "diary", mk.clone()).unwrap();
        let video: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();

        let sealed = store(&root_str, &video, "mp4", Some(("diary", &mk))).unwrap();
        let header = mntl_core::extract_encrypted_header(&fs::read(root.join(&sealed)).unwrap()).unwrap();
        assert_eq!(header.v, mntl_core::STREAM_VERSION, "videos are sealed in chunks");
        let plain = store(&root_str, &video, "mp4", None).unwrap();
        for rel in [&sealed, &plain] {
            let (bytes, range, total) = load_range(&root_str, rel, Some("bytes=65530-140000"), &keys).unwrap();
            assert_eq!((range, total), (Some((65530, 140001)), video.len() as u64));
            assert_eq!(&bytes[..], &video[65530..140001]);
            assert_eq!(&load_range(&root_str, rel, None, &keys).unwrap().0[..], &video[..]);
        }
        assert!(load_range(&root_str, &sealed, Some("bytes=0-1"), &SessionKeys::default()).unwrap_err().starts_with(LOCKED_ERR_PREFIX));
        let image = store(&root_str, PNG, "png", Some(("diary", &mk))).unwrap();
        assert_eq!(mntl_core::extract_encrypted_header(&fs::read(root.join(&image)).unwrap()).unwrap().v, mntl_core::ENVELOPE_VERSION);
    }

    #[test]
    fn resolve_image_tries_the_note_folder_then_the_root_then_by_name() {
        let root = temp_dir("resolve");
        let root_str = root.to_string_lossy().into_owned();
        fs::create_dir_all(root.join("Work/img")).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("Work/img/a.png"), PNG).unwrap();
        fs::write(root.join("attachments/b c.png"), PNG).unwrap();
        fs::write(root.join("Work/note.mntl"), "x").unwrap();

        let resolve = |src| resolve_attachment(&root_str, "Work/note.mntl", src);
        assert_eq!(resolve("img/a.png").as_deref(), Some("Work/img/a.png"));
        assert_eq!(resolve("./img/../img/a.png").as_deref(), Some("Work/img/a.png"));
        assert_eq!(resolve("attachments/b%20c.png").as_deref(), Some("attachments/b c.png"));
        assert_eq!(resolve("a.png").as_deref(), Some("Work/img/a.png"));
        assert_eq!(resolve("../../a.png"), None);
        assert_eq!(resolve("https://example.com/a.png"), None);
        assert_eq!(resolve("note.mntl"), None, "notes are not attachments");
        fs::write(root.join("Work/spec.zip"), b"zip").unwrap();
        assert_eq!(resolve("spec.zip").as_deref(), Some("Work/spec.zip"));
    }

    fn write_plain(root: &Path, rel: &str, body: &str) {
        fs::write(root.join(rel), mntl_core::encode_unencrypted_note(body).unwrap()).unwrap();
    }

    fn write_sealed(root: &Path, rel: &str, body: &str, mk: &mntl_core::MasterKey) {
        let document = mntl_core::encode_unencrypted_note(body).unwrap();
        fs::write(root.join(rel), mntl_core::encrypt_note(mk, "diary", document.as_bytes()).unwrap()).unwrap();
    }

    #[test]
    fn unused_attachments_keeps_what_other_notes_use_or_locked_notes_may() {
        let root = temp_dir("unused");
        let root_str = root.to_string_lossy().into_owned();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let keys = SessionKeys::default();
        keys.unlock_for_test(&root_str, "diary", mk.clone()).unwrap();

        let shared = store(&root_str, PNG, "png", None).unwrap();
        let sealed = store(&root_str, PNG, "png", Some(("diary", &mk))).unwrap();
        write_plain(&root, "a.mntl", &format!("![]({shared})"));
        write_plain(&root, "b.mntl", &format!("![[{}]]", shared.rsplit('/').next().unwrap()));
        write_sealed(&root, "s.mntl.enc", &format!("![]({sealed})"), &mk);
        write_sealed(&root, "t.mntl.enc", "nothing here", &mk);

        let unused = |deleting: &[&str], candidates: &[&str], keys: &SessionKeys| {
            let deleting: Vec<String> = deleting.iter().map(|s| s.to_string()).collect();
            let candidates: Vec<String> = candidates.iter().map(|s| s.to_string()).collect();
            unused_attachments_inner(&root_str, &deleting, &candidates, keys).unwrap()
        };

        assert!(unused(&["a.mntl"], &[], &keys).paths.is_empty(), "b.mntl still embeds it by name");
        assert_eq!(unused(&["a.mntl", "b.mntl"], &[], &keys).paths, [shared.clone()]);
        assert_eq!(unused(&["s.mntl.enc"], &[], &keys).paths, [sealed.clone()]);
        assert_eq!(unused(&[], &[&sealed, "Work/mine.png"], &keys).paths, Vec::<String>::new(), "s.mntl.enc uses it");

        let locked = SessionKeys::default();
        let report = unused(&["s.mntl.enc"], &[], &locked);
        assert_eq!((report.paths, report.unchecked), (vec![], vec!["s.mntl.enc".to_string()]));
        assert!(unused(&[], &[&sealed], &locked).paths.is_empty(), "t.mntl.enc is locked, so might use it");
        assert_eq!(unused(&["a.mntl", "b.mntl"], &[], &locked).paths, [shared.clone()], "a locked note keeps only its own profile's");

        assert_eq!(profile_attachments(root_str.clone(), "diary".into()).unwrap(), [sealed.clone()]);
        assert!(delete_attachments_inner(&root_str, &["a.mntl".into()]).is_err());
        delete_attachments_inner(&root_str, &[shared.clone()]).unwrap();
        assert!(!root.join(&shared).exists());
    }

    #[test]
    fn saving_a_note_makes_its_attachments_its_own() {
        let root = temp_dir("relink");
        let root_str = root.to_string_lossy().into_owned();
        let mk = mntl_core::MasterKey::generate().unwrap();
        let keys = SessionKeys::default();
        keys.unlock_for_test(&root_str, "diary", mk.clone()).unwrap();

        let plain = store(&root_str, PNG, "png", None).unwrap();
        write_sealed(&root, "s.mntl.enc", "", &mk);
        let body = format!("![]({plain}) ![]({plain})");
        let relinked = crate::vault::write_note_inner(&root_str, "s.mntl.enc", &body, &[], None, &keys).unwrap();
        let copy = &relinked[&plain];
        assert!(copy.ends_with(".png.enc"));
        let saved = read_note_inner(&root_str, "s.mntl.enc", &keys).unwrap().content;
        assert_eq!(saved, format!("![]({copy}) ![]({copy})"));
        assert!(crate::vault::write_note_inner(&root_str, "s.mntl.enc", &saved, &[], None, &keys).unwrap().is_empty());

        // A plaintext note can't copy an image of a locked profile; it still saves.
        write_plain(&root, "p.mntl", "");
        let locked = SessionKeys::default();
        let sealed_body = format!("![]({copy})");
        assert!(crate::vault::write_note_inner(&root_str, "p.mntl", &sealed_body, &[], None, &locked).unwrap().is_empty());
        assert_eq!(read_note_inner(&root_str, "p.mntl", &locked).unwrap().content, sealed_body);
    }
}
