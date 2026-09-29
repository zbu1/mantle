import { flattenAllNotes, isNoteLocked, VaultFolderNode, VaultNoteNode } from './vault-tree.model';

/**
 * Note tags. Tags are flat and match case-insensitively, keeping the spelling
 * they were first written with. The rules mirror `mntl_core::tags` in
 * `crates/mntl-core/src/tags.rs`.
 */

/** The identity of a tag: `Idea` and `idea` are the same tag. */
export function tagKey(tag: string): string {
  return tag.toLowerCase();
}

export function sameTag(a: string, b: string): boolean {
  return tagKey(a) === tagKey(b);
}

/** Why `normalizeTag` rejects a tag, for showing under the input. */
export const TAG_RULES = 'Letters, numbers, - and _ only, with at least one letter';

/**
 * Clean up a tag the user typed, or null if it isn't a valid tag: a leading
 * `#` and surrounding whitespace are dropped, and what remains must be
 * letters, digits, `-` and `_`, and not only digits. Mirrors
 * `mntl_core::normalize_tag`.
 */
export function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim();
  const tag = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^[\p{L}\p{N}_-]+$/u.test(tag) || /^\d+$/.test(tag)) return null;
  return tag;
}

/** Whether `ch` can appear in a tag — used to drop other keystrokes as they're typed. */
export function isTagChar(ch: string): boolean {
  return /^[\p{L}\p{N}_-]$/u.test(ch);
}

export interface TagGroup {
  /** The tag as first spelled in the vault. */
  name: string;
  key: string;
  notes: VaultNoteNode[];
}

/**
 * The vault's tags, each with the notes that have it, sorted by name.
 *
 * Notes whose profile is locked are left out even if the last scan read their
 * tags: once a profile locks, its notes' tags must stop showing immediately,
 * not after the rescan that follows.
 */
export function buildTagGroups(root: VaultFolderNode, unlockedProfiles: ReadonlySet<string>): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  for (const note of flattenAllNotes(root)) {
    if (!note.tags || isNoteLocked(note, unlockedProfiles)) continue;
    for (const tag of note.tags) {
      const key = tagKey(tag);
      const group = groups.get(key);
      if (!group) groups.set(key, { name: tag, key, notes: [note] });
      else if (!group.notes.includes(note)) group.notes.push(note);
    }
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const sorted = [...groups.values()].sort((a, b) => byName(a.name, b.name));
  for (const group of sorted) group.notes.sort((a, b) => byName(a.name, b.name));
  return sorted;
}
