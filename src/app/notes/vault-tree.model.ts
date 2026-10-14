/** dataTransfer MIME type used to drag one or more note relPaths onto a folder/the vault root. */
export const VAULT_NOTE_DRAG_MIME = 'application/x-mantle-note-paths';

/** dataTransfer MIME type used to drag a single folder relPath onto another folder/the vault root. */
export const VAULT_FOLDER_DRAG_MIME = 'application/x-mantle-folder-path';

/**
 * dataTransfer MIME type for dragging a *reference* to a single note relPath —
 * a Favorites or Recent Files row. Dropping one on Favorites favorites it;
 * the vault tree ignores it, so dragging a reference never moves the file.
 */
export const NOTE_REFERENCE_DRAG_MIME = 'application/x-mantle-note-ref';

/** True if `event` drags notes or a folder out of the vault tree, i.e. something a folder drop can move. */
export function isVaultTreeDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? [];
  return types.includes(VAULT_NOTE_DRAG_MIME) || types.includes(VAULT_FOLDER_DRAG_MIME);
}

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
  /**
   * The note's tags, or null when they can't be read: an encrypted note whose
   * profile was locked at scan time, or an unparseable file.
   */
  tags: string[] | null;
  /**
   * Whether this encrypted note is a favorite — sealed inside the note, so
   * only known while its profile is unlocked. Plaintext notes' favorites live
   * in `VaultMetaState` instead; use `FavoritesState` to ask either way.
   */
  favorite?: boolean;
}

/** Any other file the user keeps in the vault — an image, a PDF. Opens in a read-only preview tab. */
export interface VaultFileNode {
  type: 'file';
  /** The full filename, extension included. */
  name: string;
  relPath: string;
}

export type VaultNode = VaultFolderNode | VaultNoteNode | VaultFileNode;

/**
 * Extensions of plain Markdown files, which open as notes but stay Markdown on
 * disk. Mirrors `EXT_MARKDOWN` in `src-tauri/src/vault.rs`.
 */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const;

/** The Markdown extension `relPath` ends with (e.g. `.md`), or null for a `.mntl` / `.mntl.enc` note. */
export function markdownExtensionOf(relPath: string): string | null {
  return MARKDOWN_EXTENSIONS.find((ext) => relPath.endsWith(ext)) ?? null;
}

/** Whether `relPath` is a note (`.mntl`, `.mntl.enc` or Markdown) rather than some other file. */
export function isNotePath(relPath: string): boolean {
  return relPath.endsWith('.mntl') || relPath.endsWith('.mntl.enc') || markdownExtensionOf(relPath) !== null;
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
    if (node.type === 'file') return node;
    if (node.type === 'note') {
      return node.relPath === relPath ? { ...node, relPath: newRelPath, name: newName } : node;
    }
    const children = node.children.map(rename);
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
  };
  return rename(root) as VaultFolderNode;
}

/** Returns a copy of `root` with `fields` set on the note at `relPath`. No-op (same reference) if not found. */
export function withNoteFields(
  root: VaultFolderNode,
  relPath: string,
  fields: Partial<Pick<VaultNoteNode, 'tags' | 'favorite'>>,
): VaultFolderNode {
  const retag = (node: VaultNode): VaultNode => {
    if (node.type === 'file') return node;
    if (node.type === 'note') return node.relPath === relPath ? { ...node, ...fields } : node;
    const children = node.children.map(retag);
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
  };
  return retag(root) as VaultFolderNode;
}

/**
 * `root` pruned to the notes whose name contains `query` (ignoring case), plus
 * the folders on the way to them. Folders are kept only as ancestors; a
 * folder whose own name matches isn't a hit. A blank query returns `root`.
 */
export function filterVaultTree(root: VaultFolderNode, query: string): VaultFolderNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return root;
  const prune = (folder: VaultFolderNode): VaultFolderNode => ({
    ...folder,
    children: folder.children.flatMap((child): VaultNode[] => {
      if (child.type !== 'folder') return child.name.toLowerCase().includes(needle) ? [child] : [];
      const pruned = prune(child);
      return pruned.children.length > 0 ? [pruned] : [];
    }),
  });
  return prune(root);
}

/** Flattens a vault tree into a map of note relPath -> display name. */
export function flattenVaultNotes(root: VaultFolderNode): Map<string, string> {
  const notes = new Map<string, string>();
  const visit = (node: VaultNode): void => {
    if (node.type === 'file') return;
    if (node.type === 'note') {
      notes.set(node.relPath, node.name);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return notes;
}

/** Every node under `root` (notes, folders and files, not `root` itself) by relPath. */
export function flattenTreeNodes(root: VaultFolderNode): Map<string, VaultNode> {
  const nodes = new Map<string, VaultNode>();
  const visit = (folder: VaultFolderNode): void => {
    for (const child of folder.children) {
      nodes.set(child.relPath, child);
      if (child.type === 'folder') visit(child);
    }
  };
  visit(root);
  return nodes;
}

/** `relPaths` minus any path inside another of them — a folder carries its contents along. */
export function topmostPaths(relPaths: readonly string[]): string[] {
  return relPaths.filter((path) => !relPaths.some((other) => path.startsWith(`${other}/`)));
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
    if (node.type === 'file') return;
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
    if (node.type === 'file') return;
    if (node.type === 'note') {
      notes.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return notes;
}

/** The folder part of a vault-relative path; empty string for the vault root. */
export function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}

/** The filename part of a vault-relative path. */
export function fileNameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}
