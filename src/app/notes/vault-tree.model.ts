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
