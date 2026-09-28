/** dataTransfer MIME type used to drag one or more note relPaths onto a folder/the vault root. */
export const VAULT_NOTE_DRAG_MIME = 'application/x-mantle-note-paths';

/** dataTransfer MIME type used to drag a single folder relPath onto another folder/the vault root. */
export const VAULT_FOLDER_DRAG_MIME = 'application/x-mantle-folder-path';

export interface VaultFolderNode {
  type: 'folder';
  name: string;
  relPath: string;
  children: VaultNode[];
}

export interface VaultNoteNode {
  type: 'note';
  name: string;
  relPath: string;
  /**
   * Whether this is a `.mntl.enc` file — NOT whether it is currently readable.
   * A note is locked only if it's encrypted *and* its profile isn't unlocked;
   * use `isNoteLocked` rather than reading this flag directly.
   */
  encrypted: boolean;
  /** Credential profile this note is encrypted under, or null for plaintext notes and unreadable headers. */
  profile: string | null;
}

export type VaultNode = VaultFolderNode | VaultNoteNode;

/**
 * Extensions of plain Markdown files, which open as notes but stay Markdown on
 * disk. Mirrors `EXT_MARKDOWN` in `src-tauri/src/vault.rs`.
 */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const;

/** The Markdown extension `relPath` ends with (e.g. `.md`), or null for a `.mntl` / `.mntl.enc` note. */
export function markdownExtensionOf(relPath: string): string | null {
  return MARKDOWN_EXTENSIONS.find((ext) => relPath.endsWith(ext)) ?? null;
}

/** True when the note at `relPath` is a plain Markdown file rather than a Mantle note. */
export function isMarkdownNote(relPath: string): boolean {
  return markdownExtensionOf(relPath) !== null;
}

/** True when `note` is encrypted and its credential profile is not currently unlocked. */
export function isNoteLocked(note: VaultNoteNode, unlockedProfiles: ReadonlySet<string>): boolean {
  if (!note.encrypted) return false;
  return note.profile === null || !unlockedProfiles.has(note.profile);
}

/** The folder at `relPath` (empty string is the vault root), or null if the tree has no such folder. */
export function findFolder(root: VaultFolderNode, relPath: string): VaultFolderNode | null {
  if (relPath === '') return root;
  const visit = (folder: VaultFolderNode): VaultFolderNode | null => {
    for (const child of folder.children) {
      if (child.type !== 'folder') continue;
      if (child.relPath === relPath) return child;
      if (relPath.startsWith(`${child.relPath}/`)) return visit(child);
    }
    return null;
  };
  return visit(root);
}

/** Returns a copy of `root` with the note at `relPath` renamed in place (name + relPath updated). No-op (same reference) if not found. */
export function withRenamedNote(root: VaultFolderNode, relPath: string, newRelPath: string, newName: string): VaultFolderNode {
  const rename = (node: VaultNode): VaultNode => {
    if (node.type === 'note') {
      return node.relPath === relPath ? { ...node, relPath: newRelPath, name: newName } : node;
    }
    const children = node.children.map(rename);
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
  };
  return rename(root) as VaultFolderNode;
}

/** Flattens a vault tree into a map of note relPath -> display name. */
export function flattenVaultNotes(root: VaultFolderNode): Map<string, string> {
  const notes = new Map<string, string>();
  const visit = (node: VaultNode): void => {
    if (node.type === 'note') {
      notes.set(node.relPath, node.name);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return notes;
}

/**
 * Every `.mntl.enc` note in the tree, in traversal order.
 *
 * Profile membership is derived from the vault scan rather than fetched
 * separately, so the sidebar's profile list and the note tree can never
 * disagree about which notes belong where.
 */
export function flattenEncryptedNotes(root: VaultFolderNode): VaultNoteNode[] {
  const notes: VaultNoteNode[] = [];
  const visit = (node: VaultNode): void => {
    if (node.type === 'note') {
      if (node.encrypted) notes.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return notes;
}

/** Every note in the tree (plaintext and encrypted alike), in traversal order — used by the quick switcher. */
export function flattenAllNotes(root: VaultFolderNode): VaultNoteNode[] {
  const notes: VaultNoteNode[] = [];
  const visit = (node: VaultNode): void => {
    if (node.type === 'note') {
      notes.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return notes;
}
