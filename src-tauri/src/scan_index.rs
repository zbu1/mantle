//! The persistent index behind a vault scan: what a scan reads of each note
//! (tags, wikilink targets, sealed favorite/icon/color/location/name), kept
//! until the note's file changes, so a scan reads only the notes that did.
//!
//! It is derived data and never the source of truth: an entry is used only
//! while its note's size and modified time are what they were, and a missing,
//! unreadable or outdated index just means a note is read again.
//!
//! Plaintext notes are indexed in `.mantle/index.json`. An encrypted note's
//! entry reveals its tags and links, so each profile's are sealed under its
//! master key in `.mantle/index-<profile>.enc`: with the profile locked, the
//! index says nothing, and a rotated key simply makes the old one unreadable.

use crate::vault::write_atomic;
use mntl_core::MasterKey;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// What a scan reads of a note. The sealed-only fields stay empty for a plaintext one.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub(crate) struct Indexed {
    pub tags: Vec<String>,
    pub links: Vec<String>,
    /// Link sources in the text and strings in the properties, as written, for
    /// finding which attachments a note uses without reading it.
    pub refs: Vec<String>,
    pub prop_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Entry<V> {
    len: u64,
    modified: u64,
    info: V,
}

/// One file's worth of entries: the ones a pass found current (`new`), against
/// those it started from (`old`), so files that were deleted drop out.
struct Section<V> {
    old: HashMap<String, Entry<V>>,
    new: HashMap<String, Entry<V>>,
    dirty: bool,
}

impl<V: Serialize + DeserializeOwned + Clone> Section<V> {
    fn with_old(old: HashMap<String, Entry<V>>) -> Self {
        Self { old, new: HashMap::new(), dirty: false }
    }

    fn get_or(&mut self, rel: &str, (len, modified): (u64, u64), compute: impl FnOnce() -> Option<V>) -> Option<V> {
        // Without a modified time there's nothing to tell a changed file by.
        if modified == 0 {
            return compute();
        }
        if let Some(entry) = self.old.get(rel).filter(|e| e.len == len && e.modified == modified) {
            self.new.insert(rel.to_string(), entry.clone());
            return Some(entry.info.clone());
        }
        let info = compute()?;
        self.new.insert(rel.to_string(), Entry { len, modified, info: info.clone() });
        self.dirty = true;
        Some(info)
    }

    fn changed(&self) -> bool {
        self.dirty || self.new.len() != self.old.len()
    }
}

fn parse<V: DeserializeOwned>(bytes: &[u8]) -> HashMap<String, Entry<V>> {
    serde_json::from_slice(bytes).unwrap_or_default()
}

/// Indexes of one kind of file, in one folder: a plaintext file and one sealed per profile.
pub(crate) struct Store<V> {
    dir: PathBuf,
    plain_file: &'static str,
    sealed_prefix: &'static str,
    plain: Section<V>,
    sealed: HashMap<String, (MasterKey, Section<V>)>,
}

/// The index of a vault's notes.
pub(crate) type ScanIndex = Store<Indexed>;

impl Store<Indexed> {
    pub fn load(vault_root: &str) -> Self {
        Self::open(PathBuf::from(vault_root).join(".mantle"), "index.json", "index-")
    }
}

impl<V: Serialize + DeserializeOwned + Clone> Store<V> {
    /// Open the index whose plaintext part is `dir/plain_file` and whose sealed parts are `dir/<sealed_prefix><profile>.enc`.
    pub fn open(dir: PathBuf, plain_file: &'static str, sealed_prefix: &'static str) -> Self {
        let old = fs::read(dir.join(plain_file)).map(|b| parse(&b)).unwrap_or_default();
        Self { dir, plain_file, sealed_prefix, plain: Section::with_old(old), sealed: HashMap::new() }
    }

    /// The entry for the plaintext file at `rel`, read by `compute` if the index lacks a current one.
    pub fn plain(&mut self, rel: &str, stamp: (u64, u64), compute: impl FnOnce() -> Option<V>) -> Option<V> {
        self.plain.get_or(rel, stamp, compute)
    }

    /// As [`Self::plain`] for a file sealed under `profile`, whose index is read with `mk`.
    pub fn sealed(
        &mut self,
        profile: &str,
        mk: &MasterKey,
        rel: &str,
        stamp: (u64, u64),
        compute: impl FnOnce() -> Option<V>,
    ) -> Option<V> {
        let (dir, prefix) = (&self.dir, self.sealed_prefix);
        let (_, section) = self.sealed.entry(profile.to_string()).or_insert_with(|| {
            let old = fs::read(sealed_path(dir, prefix, profile))
                .ok()
                .and_then(|blob| mntl_core::decrypt_note(mk, &blob).ok())
                .map(|json| parse(&json))
                .unwrap_or_default();
            (mk.clone(), Section::with_old(old))
        });
        section.get_or(rel, stamp, compute)
    }

    /// Write whatever sections changed. Failing to is no loss: the next pass reads those files again.
    pub fn save(self) {
        if self.plain.changed() {
            write_section(&self.dir.join(self.plain_file), &self.plain.new, None);
        }
        for (profile, (mk, section)) in self.sealed {
            if section.changed() {
                write_section(&sealed_path(&self.dir, self.sealed_prefix, &profile), &section.new, Some((&profile, &mk)));
            }
        }
    }
}

/// An id that isn't a plain name could climb out of the folder; it just gets no index.
fn sealed_path(dir: &std::path::Path, prefix: &str, profile: &str) -> PathBuf {
    let safe = profile.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    dir.join(format!("{prefix}{}.enc", if safe { profile } else { "invalid" }))
}

fn write_section<V: Serialize>(path: &std::path::Path, entries: &HashMap<String, Entry<V>>, seal: Option<(&str, &MasterKey)>) {
    let Ok(json) = serde_json::to_vec(entries) else { return };
    let bytes = match seal {
        Some((profile, mk)) => match mntl_core::encrypt_note(mk, profile, &json) {
            Ok(blob) => blob,
            Err(_) => return,
        },
        None => json,
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = write_atomic(path, &bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(tag: &str) -> Indexed {
        Indexed { tags: vec![tag.into()], ..Indexed::default() }
    }

    #[test]
    fn entries_are_reused_until_the_file_changes_and_sealed_ones_need_the_key() {
        let root = std::env::temp_dir().join(format!("mntl-scan-index-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_str = root.to_string_lossy().into_owned();
        let mk = MasterKey::generate().unwrap();

        let mut index = ScanIndex::load(&root_str);
        assert_eq!(index.plain("a.mntl", (10, 5), || Some(info("one"))), Some(info("one")));
        assert!(index.sealed("p", &mk, "b.mntl.enc", (20, 6), || Some(info("secret"))).is_some());
        index.save();
        let on_disk = fs::read(root.join(".mantle/index-p.enc")).unwrap();
        assert!(!String::from_utf8_lossy(&on_disk).contains("secret"));

        let mut index = ScanIndex::load(&root_str);
        // Unchanged: served from the index, not read again.
        assert_eq!(index.plain("a.mntl", (10, 5), || panic!("read again")), Some(info("one")));
        assert!(index.sealed("p", &mk, "b.mntl.enc", (20, 6), || panic!("read again")).is_some());
        // A changed file is read again.
        assert_eq!(index.plain("a.mntl", (11, 5), || Some(info("two"))), Some(info("two")));
        // Another key can't read the sealed index.
        let other = MasterKey::generate().unwrap();
        let mut index = ScanIndex::load(&root_str);
        assert_eq!(index.sealed("p", &other, "b.mntl.enc", (20, 6), || Some(info("fresh"))), Some(info("fresh")));
        let _ = fs::remove_dir_all(&root);
    }
}
