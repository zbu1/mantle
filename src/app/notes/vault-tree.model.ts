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
