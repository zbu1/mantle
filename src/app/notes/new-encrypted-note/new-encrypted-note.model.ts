import { VaultFolderNode } from '../vault-tree.model';

/** Extension of an encrypted note on disk. Mirrors `EXT_ENCRYPTED` in `src-tauri/src/vault.rs`. */
export const ENCRYPTED_NOTE_EXTENSION = '.mntl.enc';

/** Name suggested for a new note before the user types anything. */
export const DEFAULT_NOTE_TITLE = 'Untitled';

/**
 * Characters that can't appear in a note's filename. The backend only rejects
 * `/ \ :`, but the rest are illegal in Windows filenames, and a note created
 * here has to be openable on every platform the vault syncs to.
 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;

/** Names of the encrypted notes directly inside `folder` — the ones a new `<name>.mntl.enc` would collide with. */
export function encryptedNoteNamesIn(folder: VaultFolderNode | null): ReadonlySet<string> {
  const names = new Set<string>();
  for (const child of folder?.children ?? []) {
    if (child.type === 'note' && child.encrypted) names.add(child.name);
  }
  return names;
}

/** `Untitled`, or the first `Untitled N` (from 2) that isn't already taken. */
export function nextUntitledName(taken: ReadonlySet<string>): string {
  if (!taken.has(DEFAULT_NOTE_TITLE)) return DEFAULT_NOTE_TITLE;
  for (let n = 2; ; n++) {
    const candidate = `${DEFAULT_NOTE_TITLE} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Why `title` can't become a note's name, or null if it can.
 *
 * The title is the filename for now (see `onDiskFileName`), so its rules are
 * the filesystem's. This is a courtesy check that reports problems as the user
 * types; the backend remains the authority and re-checks on creation.
 */
export function validateNoteTitle(title: string, taken: ReadonlySet<string>): string | null {
  const name = title.trim();
  if (!name) return 'Give the note a title.';
  const illegal = name.match(ILLEGAL_NAME_CHARS);
  if (illegal) return `A title can't contain "${illegal[0]}".`;
  if (name.endsWith('.')) return "A title can't end with a period.";
  if (taken.has(name)) return `An encrypted note named "${name}" already exists in this folder.`;
  return null;
}

/**
 * The filename a note with this title gets on disk.
 *
 * Isolated here because it's the seam encrypted filenames will replace: today
 * it mirrors the title, but once filenames are encrypted the title moves into
 * the sealed frontmatter and this becomes an opaque generated name.
 */
export function onDiskFileName(title: string): string {
  return `${title.trim()}${ENCRYPTED_NOTE_EXTENSION}`;
}

/** Vault-relative path of a note with this title inside `relDir` (empty string is the vault root). */
export function onDiskRelPath(relDir: string, title: string): string {
  const fileName = onDiskFileName(title);
  return relDir ? `${relDir}/${fileName}` : fileName;
}
