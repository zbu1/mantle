import { VaultFolderNode, findFolder, markdownExtensionOf } from './vault-tree.model';
import { relPathAfter } from './note-encryption-modal/note-encryption-modal.model';

const tree: VaultFolderNode = {
  type: 'folder',
  name: 'vault',
  relPath: '',
  children: [
    { type: 'note', name: 'a', relPath: 'a.mntl', encrypted: false, profile: null },
    {
      type: 'folder',
      name: 'Work',
      relPath: 'Work',
      children: [{ type: 'folder', name: 'Projects', relPath: 'Work/Projects', children: [] }],
    },
    { type: 'folder', name: 'Work2', relPath: 'Work2', children: [] },
  ],
};

describe('findFolder', () => {
  it('treats the empty path as the vault root', () => {
    expect(findFolder(tree, '')).toBe(tree);
  });

  it('finds top-level and nested folders', () => {
    expect(findFolder(tree, 'Work')?.name).toBe('Work');
    expect(findFolder(tree, 'Work/Projects')?.name).toBe('Projects');
  });

  it('does not confuse a folder with one sharing its name as a prefix', () => {
    expect(findFolder(tree, 'Work2')?.relPath).toBe('Work2');
  });

  it('returns null for a folder that is not in the tree, or is a note', () => {
    expect(findFolder(tree, 'Nope')).toBeNull();
    expect(findFolder(tree, 'Work/Nope')).toBeNull();
    expect(findFolder(tree, 'a.mntl')).toBeNull();
  });
});

describe('markdownExtensionOf', () => {
  it('recognizes plain Markdown files and nothing else', () => {
    expect(markdownExtensionOf('Docs/readme.md')).toBe('.md');
    expect(markdownExtensionOf('guide.markdown')).toBe('.markdown');
    expect(markdownExtensionOf('todo.mntl')).toBeNull();
    expect(markdownExtensionOf('secret.mntl.enc')).toBeNull();
  });

  it('names the encrypted file a Markdown file becomes', () => {
    expect(relPathAfter('Docs/readme.md', 'encrypt')).toBe('Docs/readme.mntl.enc');
    expect(relPathAfter('guide.markdown', 'encrypt')).toBe('guide.mntl.enc');
    expect(relPathAfter('todo.mntl', 'encrypt')).toBe('todo.mntl.enc');
  });
});
