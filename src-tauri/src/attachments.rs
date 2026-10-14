//! Images embedded in notes.
//!
//! Every image Mantle stores lives in the vault-level `attachments/` folder:
//!
//! - a plaintext note's images as `attachments/<hash>.<ext>`, named by
//!   content so pasting the same image twice stores it once;
//! - an encrypted note's images as `attachments/<random>.<ext>.enc`, sealed in
//!   the same envelope as a `.mntl.enc` note (with the image bytes as its
//!   payload) under the note's profile. Random rather than hashed: a hash of
//!   the plaintext in the filename would let anyone check whether a vault
//!   holds a known image.
//!
//! Notes reference images with ordinary Markdown (`![alt](attachments/…)`),
//! and Obsidian's `![[photo.png|300]]` embeds are read too. The webview loads
//! them through the `mantle://` protocol ([`serve`]), which decrypts sealed
//! images in memory, so a decrypted image never touches the disk.
//!
//! Attachments are never modified once written — a duplicated note shares its
//! images with the original — so converting a note between plaintext and a
//! profile ([`reseal_images`]) writes new copies and leaves the old ones
//! behind. They are only deleted when the user asks, and only once nothing
//! else uses them ([`unused_attachments`]).

use crate::credentials::SessionKeys;
use crate::logging::logged;
use crate::vault::{
    master_key_for, note_paths, read_header_prefix, read_note_inner, resolve_rel_dir, resolve_rel_path,
    write_atomic, EXT_ENCRYPTED, LOCKED_ERR_PREFIX,
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
const EXT_SEALED: &str = ".enc";

/// The image types an attachment may have, and the media type each is served as.
const IMAGE_TYPES: [(&str, &str); 8] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
];

fn media_type(ext: &str) -> Option<&'static str> {
    IMAGE_TYPES
        .iter()
        .find(|(known, _)| known.eq_ignore_ascii_case(ext))
        .map(|(_, media)| *media)
}

/// The image extension of `path` (lowercase, without any `.enc`) and whether
/// it is sealed, or `None` if it isn't an image — which is also what stops
/// [`serve`] from handing out a note.
fn image_ext(path: &str) -> Option<(String, bool)> {
    let plain = path.strip_suffix(EXT_SEALED);
    let (_, ext) = plain.unwrap_or(path).rsplit_once('.')?;
    media_type(ext)?;
    Some((ext.to_ascii_lowercase(), plain.is_some()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Write an image into `attachments/`, sealed under `seal` if given, and
/// return its vault-relative path.
fn store(
    vault_root: &str,
    bytes: &[u8],
    ext: &str,
    seal: Option<(&str, &mntl_core::MasterKey)>,
) -> Result<String, String> {
    let ext = ext.to_ascii_lowercase();
    if media_type(&ext).is_none() {
        return Err(format!("Unsupported image type: .{ext}"));
    }
    let root = resolve_rel_dir(vault_root, "")?;
    fs::create_dir_all(root.join(ATTACHMENTS_DIR))
        .map_err(|e| format!("Failed to create the attachments folder: {e}"))?;
    let dir = resolve_rel_dir(vault_root, ATTACHMENTS_DIR)?;

    let name = match seal {
        Some((profile_id, mk)) => {
            let mut id = [0u8; 16];
            OsRng.fill_bytes(&mut id);
            let name = format!("{}.{ext}{EXT_SEALED}", hex(&id));
            let blob = mntl_core::encrypt_note(mk, profile_id, bytes).map_err(|e| e.to_string())?;
            write_atomic(&dir.join(&name), &blob)?;
            name
        }
        None => {
            let name = format!("{}.{ext}", hex(&Sha256::digest(bytes)[..16]));
            let path = dir.join(&name);
            if !path.exists() {
                write_atomic(&path, bytes)?;
            }
            name
        }
    };
    Ok(format!("{ATTACHMENTS_DIR}/{name}"))
}

/// The image at vault-relative `rel_path`, decrypted if it is sealed, with its
/// media type. A sealed image of a locked profile is the
/// `mantle:locked:<id>` sentinel, as for a note.
fn load(
    vault_root: &str,
    rel_path: &str,
    keys: &SessionKeys,
) -> Result<(Zeroizing<Vec<u8>>, &'static str), String> {
    let (ext, sealed) = image_ext(rel_path).ok_or("Not an image")?;
    let media = media_type(&ext).ok_or("Not an image")?;
    let bytes = fs::read(resolve_rel_path(vault_root, rel_path)?)
        .map_err(|e| format!("Failed to read image: {e}"))?;
    if !sealed {
        return Ok((Zeroizing::new(bytes), media));
    }
    let (_, mk) = master_key_for(vault_root, &bytes, keys)?;
    let plain = mntl_core::decrypt_note(&mk, &bytes).map_err(|e| e.to_string())?;
    Ok((plain, media))
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

/// The vault-relative path an image reference `src` in the note at `note_rel`
/// points to, or `None` for a remote URL or a missing file.
///
/// Tried in the order Obsidian resolves them: relative to the note, then to
/// the vault root (which is how Mantle writes them), then — for a bare file
/// name, as `![[photo.png]]` usually is — anywhere in the vault.
pub(crate) fn resolve_image(vault_root: &str, note_rel: &str, src: &str) -> Option<String> {
    // `http:`, `data:`, `C:\`: not a vault file.
    if src.contains(':') {
        return None;
    }
    // markdown-it percent-encodes the destinations it parses (a space as %20).
    let src = percent_decode_str(src).decode_utf8_lossy();
    let note_dir = note_rel.rsplit_once('/').map_or("", |(dir, _)| dir);
    let is_image = |rel: &String| {
        image_ext(rel).is_some() && resolve_rel_path(vault_root, rel).is_ok_and(|p| p.is_file())
    };
    [join_normalized(note_dir, &src), join_normalized("", &src)]
        .into_iter()
        .flatten()
        .find(is_image)
        .or_else(|| {
            if src.contains(['/', '\\']) {
                return None;
            }
            let root = resolve_rel_dir(vault_root, "").ok()?;
            find_by_name(&root, "", &src).filter(is_image)
        })
}

/// The byte ranges of every image source in `markdown`: the destination of
/// `![alt](src "title")` (inside its `<>`, if any) and the target of
/// Obsidian's `![[src|size]]`.
// ponytail: plain text scan, so an image written inside a code block counts
// too; walk markdown-it's tokens instead if that ever rewrites someone's code.
pub(crate) fn image_sources(markdown: &str) -> Vec<Range<usize>> {
    let mut sources = Vec::new();
    let mut from = 0;
    while let Some(at) = markdown[from..].find("![").map(|i| from + i) {
        from = at + 2;
        let line_end = markdown[from..].find('\n').map_or(markdown.len(), |i| from + i);
        let line = &markdown[from..line_end];

        if let Some(inner) = line.strip_prefix('[') {
            let Some(close) = inner.find("]]") else { continue };
            let target = &inner[..close];
            let len = target.find('|').unwrap_or(target.len());
            sources.push(from + 1..from + 1 + len);
            from += 1 + close + 2;
            continue;
        }

        let Some(open) = line.find("](") else { continue };
        let start = from + open + 2;
        let rest = &markdown[start..line_end];
        let range = if let Some(bracketed) = rest.strip_prefix('<') {
            let Some(end) = bracketed.find('>') else { continue };
            start + 1..start + 1 + end
        } else {
            let end = rest.find(|c: char| c.is_whitespace() || c == ')').unwrap_or(rest.len());
            start..start + end
        };
        from = range.end;
        sources.push(range);
    }
    sources
}

/// Re-point every local image in `document`, the text of the note at
/// `note_rel`, at a copy sealed under `target` — or a plaintext copy when
/// `target` is `None` — so the note never depends on an image less protected
/// than itself, or on a profile it no longer belongs to. Images already in
/// the right form, remote images and missing files are left alone.
///
/// This is what makes an attachment belong to a profile: a sealed one is only
/// ever referenced by notes of its own profile, and a plaintext one only by
/// plaintext notes — which is what lets [`unused_attachments`] judge one
/// without unlocking every profile.
///
/// Returns the new document and each source it re-pointed (as written in the
/// note) with the copy it now points at. `lenient` leaves an image it can't
/// copy — one sealed under a locked profile — as it is, for a save, which
/// must never fail over a link.
pub(crate) fn reseal_images(
    vault_root: &str,
    note_rel: &str,
    document: &str,
    target: Option<(&str, &mntl_core::MasterKey)>,
    keys: &SessionKeys,
    lenient: bool,
) -> Result<(Zeroizing<String>, HashMap<String, String>), String> {
    let mut out = Zeroizing::new(String::with_capacity(document.len()));
    let mut copies: HashMap<String, String> = HashMap::new();
    let mut relinked = HashMap::new();
    let mut last = 0;

    for range in image_sources(document) {
        let src = &document[range.clone()];
        let Some(rel) = resolve_image(vault_root, note_rel, src) else {
            continue;
        };
        let (ext, sealed) = image_ext(&rel).ok_or("Not an image")?;
        let in_place = match target {
            None => !sealed,
            Some((profile_id, _)) => {
                sealed
                    && resolve_rel_path(vault_root, &rel)
                        .and_then(|path| read_header_prefix(&path))
                        .and_then(|h| mntl_core::extract_encrypted_header(&h).map_err(|e| e.to_string()))
                        .is_ok_and(|h| h.credential_profile == profile_id)
            }
        };
        if in_place {
            continue;
        }

        let copy = match copies.get(&rel) {
            Some(copy) => copy.clone(),
            None => {
                let copied = load(vault_root, &rel, keys)
                    .map_err(|e| match e.strip_prefix(LOCKED_ERR_PREFIX) {
                        Some(profile) => format!("Unlock \"{profile}\" first: this note shows an image encrypted under it"),
                        None => e,
                    })
                    .and_then(|(bytes, _)| store(vault_root, &bytes, &ext, target));
                let copy = match copied {
                    Ok(copy) => copy,
                    Err(_) if lenient => continue,
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
    Ok((out, relinked))
}

/// Whether `rel` is a file directly in the vault-root `attachments/` folder —
/// one Mantle stored and manages — rather than one of the user's own files.
fn is_managed(rel: &str) -> bool {
    rel.strip_prefix(ATTACHMENTS_DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|name| !name.is_empty() && !name.contains('/'))
}

/// The credential profile the sealed attachment at `rel` is encrypted under,
/// read from its header; `None` for a plaintext one.
fn sealed_profile(vault_root: &str, rel: &str) -> Option<String> {
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
    let rel_path = resolve_image(&vault_root, &note_rel_path, &src)?;
    Some(AttachmentInfo {
        managed: is_managed(&rel_path),
        profile: sealed_profile(&vault_root, &rel_path),
        rel_path,
    })
}

/// The managed attachments that `content`, the text of the note at
/// `note_rel`, references. With `only`, sources whose file name none of those
/// paths has are skipped unresolved, which spares a vault-wide walk for every
/// bare `![[name.png]]` in every note.
fn referenced(vault_root: &str, note_rel: &str, content: &str, only: Option<&BTreeSet<String>>) -> HashSet<String> {
    image_sources(content)
        .into_iter()
        .map(|range| &content[range])
        .filter(|src| {
            only.is_none_or(|only| {
                let src = percent_decode_str(src).decode_utf8_lossy();
                let name = src.rsplit(['/', '\\']).next().unwrap_or_default();
                only.iter().any(|rel| rel.rsplit('/').next() == Some(name))
            })
        })
        .filter_map(|src| resolve_image(vault_root, note_rel, src))
        .filter(|rel| is_managed(rel))
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
/// Every readable note is checked. A locked note can't be, so it keeps every
/// attachment sealed under its own profile; it can't be holding any other, as
/// [`reseal_images`] keeps a note's attachments under the note's own profile.
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
            Ok(doc) => found.extend(referenced(vault_root, note, &doc.content, None)),
            Err(_) => unchecked.push(note.clone()),
        }
    }
    found.retain(|rel| resolve_rel_path(vault_root, rel).is_ok_and(|path| path.is_file()));
    let profiles: HashMap<String, Option<String>> =
        found.iter().map(|rel| (rel.clone(), sealed_profile(vault_root, rel))).collect();

    for note in note_paths(vault_root)? {
        if found.is_empty() {
            break;
        }
        if deleting.contains(&note) {
            continue;
        }
        match read_note_inner(vault_root, &note, keys) {
            Ok(doc) => {
                let used = referenced(vault_root, &note, &doc.content, Some(&found));
                found.retain(|rel| !used.contains(rel));
            }
            Err(e) => {
                if let Some(profile) = e.strip_prefix(LOCKED_ERR_PREFIX) {
                    found.retain(|rel| profiles[rel].as_deref() != Some(profile));
                }
            }
        }
    }
    Ok(UnusedAttachments { paths: found.into_iter().collect(), unchecked })
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
        let result = trash::delete(&path).map_err(|e| e.to_string());
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
    let header = read_header_prefix(&resolve_rel_path(vault_root, note_rel)?)?;
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
        let (ext, _) = image_ext(&source_path).ok_or("Not a supported image file")?;
        let bytes = Zeroizing::new(fs::read(&source_path).map_err(|e| format!("Failed to read image: {e}"))?);
        save_for_note(&vault_root, &note_rel_path, &bytes, &ext, &keys)
    })
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode_str(v).decode_utf8_lossy().into_owned())
    })
}

/// Answer a `mantle://localhost/?vault=…&note=…&src=…` request with the image
/// `src` refers to from that note, decrypting it if it is sealed.
///
/// Responses are `no-store`, so a decrypted image is never written to the
/// webview's disk cache — and so locking a profile takes effect on the next
/// render rather than whenever a cache entry expires.
fn serve(keys: &SessionKeys, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let respond = |status: StatusCode, media: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, media)
            .header(header::CACHE_CONTROL, "no-store")
            .body(body)
            .unwrap_or_default()
    };
    let query = request.uri().query().unwrap_or("");
    let (Some(vault), Some(note), Some(src)) =
        (query_param(query, "vault"), query_param(query, "note"), query_param(query, "src"))
    else {
        return respond(StatusCode::BAD_REQUEST, "text/plain", Vec::new());
    };
    let Some(rel) = resolve_image(&vault, &note, &src) else {
        return respond(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    match load(&vault, &rel, keys) {
        Ok((bytes, media)) => respond(StatusCode::OK, media, bytes.to_vec()),
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

    #[test]
    fn image_sources_finds_markdown_and_obsidian_images() {
        let md = "a ![x](one.png) b ![](<two words.png> \"t\") ![[three.png|300]] ![[four.jpg]] [link](no.png) ![bad\n](x)";
        let found: Vec<&str> = image_sources(md).into_iter().map(|r| &md[r]).collect();
        assert_eq!(found, ["one.png", "two words.png", "three.png", "four.jpg"]);
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
        let (bytes, media) = load(&root_str, &b, &keys).unwrap();
        assert_eq!((bytes.as_slice(), media), (PNG, "image/png"));

        assert!(store(&root_str, PNG, "exe", None).is_err());
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

        let resolve = |src| resolve_image(&root_str, "Work/note.mntl", src);
        assert_eq!(resolve("img/a.png").as_deref(), Some("Work/img/a.png"));
        assert_eq!(resolve("./img/../img/a.png").as_deref(), Some("Work/img/a.png"));
        assert_eq!(resolve("attachments/b%20c.png").as_deref(), Some("attachments/b c.png"));
        assert_eq!(resolve("a.png").as_deref(), Some("Work/img/a.png"));
        assert_eq!(resolve("../../a.png"), None);
        assert_eq!(resolve("https://example.com/a.png"), None);
        assert_eq!(resolve("note.mntl"), None, "notes are not images");
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
        let relinked = crate::vault::write_note_inner(&root_str, "s.mntl.enc", &body, &[], &keys).unwrap();
        let copy = &relinked[&plain];
        assert!(copy.ends_with(".png.enc"));
        let saved = read_note_inner(&root_str, "s.mntl.enc", &keys).unwrap().content;
        assert_eq!(saved, format!("![]({copy}) ![]({copy})"));
        assert!(crate::vault::write_note_inner(&root_str, "s.mntl.enc", &saved, &[], &keys).unwrap().is_empty());

        // A plaintext note can't copy an image of a locked profile; it still saves.
        write_plain(&root, "p.mntl", "");
        let locked = SessionKeys::default();
        let sealed_body = format!("![]({copy})");
        assert!(crate::vault::write_note_inner(&root_str, "p.mntl", &sealed_body, &[], &locked).unwrap().is_empty());
        assert_eq!(read_note_inner(&root_str, "p.mntl", &locked).unwrap().content, sealed_body);
    }
}
