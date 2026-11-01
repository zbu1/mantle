//! Vault-wide `[[wikilink]]` rewrites, for when a note is renamed or moved:
//! every link that led to it gets a target that leads to it again.
//!
//! The frontend works out which links need what, as it holds the link index
//! (derived from the scan, like tags); this applies them, the way
//! [`crate::tags`] applies a tag rename. Notes of locked profiles are skipped
//! and reported.

use crate::session::ActiveVault;

use crate::attachments::link_sources;
use crate::credentials::SessionKeys;
use crate::hidden;
use crate::logging::logged;
use crate::tags::{edit_note, NoteEditError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use tauri::State;
use zeroize::Zeroizing;

/// In the note `note`, every wikilink to `from` (matched case-insensitively)
/// becomes one to `to`, keeping its `#heading` and `|alias`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinkRewrite {
    pub note: String,
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkRewriteReport {
    /// Notes that were rewritten.
    pub updated: Vec<String>,
    /// Notes left as they were because their profile is locked.
    pub locked: Vec<String>,
}

#[tauri::command]
pub fn rewrite_links(
    active_vault: State<'_, ActiveVault>,
    rewrites: Vec<LinkRewrite>,
    keys: State<SessionKeys>,
) -> Result<LinkRewriteReport, String> {
    let vault_root = active_vault.root()?;
    logged("rewrite_links", || rewrite_links_inner(&vault_root, &rewrites, &keys))
}

fn rewrite_links_inner(vault_root: &str, rewrites: &[LinkRewrite], keys: &SessionKeys) -> Result<LinkRewriteReport, String> {
    let mut by_note: BTreeMap<&str, HashMap<String, &str>> = BTreeMap::new();
    for rewrite in rewrites {
        by_note.entry(&rewrite.note).or_default().insert(rewrite.from.trim().to_lowercase(), &rewrite.to);
    }
    let mut report = LinkRewriteReport::default();
    for (note, targets) in by_note {
        let path = hidden::resolve_note(vault_root, note, keys)?;
        let edited = edit_note(vault_root, &path, note, keys, |_, body| match rewrite_wikilinks(body, &targets) {
            Some(rewritten) => {
                let rewritten = Zeroizing::new(rewritten);
                body.clear();
                body.push_str(&rewritten);
                true
            }
            None => false,
        });
        match edited {
            Ok(true) => report.updated.push(note.to_string()),
            Ok(false) => {}
            Err(NoteEditError::Locked) => report.locked.push(note.to_string()),
            Err(NoteEditError::Failed(e)) => return Err(format!("Failed to update \"{note}\": {e}")),
        }
    }
    Ok(report)
}

/// `body` with each wikilink whose target (lowercased) is a key of `targets`
/// pointed at its value instead, or `None` if none is. Code is left alone.
fn rewrite_wikilinks(body: &str, targets: &HashMap<String, &str>) -> Option<String> {
    let mut out = String::with_capacity(body.len());
    let mut last = 0;
    for source in link_sources(body).into_iter().filter(|s| s.wiki) {
        let Some(to) = targets.get(&body[source.range.clone()].trim().to_lowercase()) else { continue };
        out.push_str(&body[last..source.range.start]);
        out.push_str(to);
        last = source.range.end;
    }
    (last > 0).then(|| {
        out.push_str(&body[last..]);
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::read_note_inner;
    use std::fs;

    #[test]
    fn rewrites_link_targets_keeping_headings_aliases_and_code() {
        let targets = HashMap::from([("old".to_string(), "Folder/New")]);
        let body = "[[Old]] [[old#Plans|see]] ![[Old]] [[Older]] `[[Old]]` [Old](Old.mntl)";
        assert_eq!(
            rewrite_wikilinks(body, &targets).unwrap(),
            "[[Folder/New]] [[Folder/New#Plans|see]] ![[Folder/New]] [[Older]] `[[Old]]` [Old](Old.mntl)"
        );
        assert_eq!(rewrite_wikilinks("[[Other]]", &targets), None);
    }

    #[test]
    fn rewrites_every_kind_of_note_and_skips_locked_ones() {
        let root = std::env::temp_dir().join(format!("mntl-links-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root_str = root.to_string_lossy().into_owned();
        let keys = SessionKeys::default();
        let mk = mntl_core::MasterKey::generate().unwrap();
        keys.unlock_for_test(&root_str, "diary", mk.clone()).unwrap();
        let locked = mntl_core::MasterKey::generate().unwrap();
        let sealed = |mk: &mntl_core::MasterKey, profile: &str| {
            mntl_core::encrypt_note(mk, profile, mntl_core::encode_unencrypted_note("[[Old]]").unwrap().as_bytes()).unwrap()
        };
        fs::write(root.join("a.mntl"), mntl_core::encode_unencrypted_note("[[Old]]").unwrap()).unwrap();
        fs::write(root.join("b.md"), "---\nkeep: me\n---\n[[Old|x]]").unwrap();
        fs::write(root.join("c.mntl.enc"), sealed(&mk, "diary")).unwrap();
        fs::write(root.join("d.mntl.enc"), sealed(&locked, "work")).unwrap();

        let rewrites: Vec<LinkRewrite> = ["a.mntl", "b.md", "c.mntl.enc", "d.mntl.enc"]
            .iter()
            .map(|note| LinkRewrite { note: note.to_string(), from: "Old".into(), to: "New".into() })
            .collect();
        let report = rewrite_links_inner(&root_str, &rewrites, &keys).unwrap();
        assert_eq!(report.updated, ["a.mntl", "b.md", "c.mntl.enc"]);
        assert_eq!(report.locked, ["d.mntl.enc"]);
        assert_eq!(read_note_inner(&root_str, "a.mntl", &keys).unwrap().content, "[[New]]");
        assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "---\nkeep: me\n---\n[[New|x]]");
        assert_eq!(read_note_inner(&root_str, "c.mntl.enc", &keys).unwrap().content, "[[New]]");
    }
}
