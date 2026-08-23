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
  locked: boolean;
}

export type VaultNode = VaultFolderNode | VaultNoteNode;

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
