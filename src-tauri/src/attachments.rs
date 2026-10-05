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
//! Attachments are never modified or deleted once written — a duplicated
//! note shares its images with the original — so converting a note between
//! plaintext and a profile ([`reseal_images`]) writes new copies and leaves
//! the old ones behind.

use crate::credentials::SessionKeys;
use crate::logging::logged;
use crate::vault::{
    master_key_for, read_header_prefix, resolve_rel_dir, resolve_rel_path, write_atomic,
    EXT_ENCRYPTED, LOCKED_ERR_PREFIX,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use percent_encoding::percent_decode_str;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
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
pub(crate) fn reseal_images(
    vault_root: &str,
    note_rel: &str,
    document: &str,
    target: Option<(&str, &mntl_core::MasterKey)>,
    keys: &SessionKeys,
) -> Result<Zeroizing<String>, String> {
    let mut out = Zeroizing::new(String::with_capacity(document.len()));
    let mut copies: HashMap<String, String> = HashMap::new();
    let mut last = 0;

    for range in image_sources(document) {
        let Some(rel) = resolve_image(vault_root, note_rel, &document[range.clone()]) else {
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
                let (bytes, _) = load(vault_root, &rel, keys).map_err(|e| match e.strip_prefix(LOCKED_ERR_PREFIX) {
                    Some(profile) => format!("Unlock \"{profile}\" first: this note shows an image encrypted under it"),
                    None => e,
                })?;
                let copy = store(vault_root, &bytes, &ext, target)?;
                copies.insert(rel, copy.clone());
                copy
            }
        };
        out.push_str(&document[last..range.start]);
        out.push_str(&copy);
        last = range.end;
    }

    out.push_str(&document[last..]);
    Ok(out)
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
}
