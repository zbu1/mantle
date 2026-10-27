import { VaultFolderNode, VaultNode, filterVaultTree, findFolder, flattenVaultNotes, markdownExtensionOf, sortVaultTree } from './vault-tree.model';
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

describe('filterVaultTree', () => {
  const note = (relPath: string) => ({
    type: 'note' as const,
    name: relPath.split('/').pop()!.replace(/\.mntl$/, ''),
    relPath,
    encrypted: false,
    profile: null,
    tags: [],
  });
  const vault: VaultFolderNode = {
    type: 'folder',
    name: 'vault',
    relPath: '',
    children: [
      {
        type: 'folder',
        name: 'Plans',
        relPath: 'Plans',
        children: [note('Plans/Roadmap.mntl'), { type: 'folder', name: 'Old', relPath: 'Plans/Old', children: [note('Plans/Old/Q1 roadmap.mntl')] }],
      },
      { type: 'folder', name: 'Roadmaps', relPath: 'Roadmaps', children: [note('Roadmaps/ideas.mntl')] },
      note('todo.mntl'),
    ],
  };

  it('keeps matching notes (ignoring case) and the folders on the way to them', () => {
    const filtered = filterVaultTree(vault, ' ROADMAP ');
    expect([...flattenVaultNotes(filtered).keys()]).toEqual(['Plans/Roadmap.mntl', 'Plans/Old/Q1 roadmap.mntl']);
    // A folder whose own name matches isn't a hit.
    expect(findFolder(filtered, 'Roadmaps')).toBeNull();
  });

  it('returns the tree untouched for a blank query', () => {
    expect(filterVaultTree(vault, '  ')).toBe(vault);
  });
});

describe('sortVaultTree', () => {
  const note = (name: string, modified: number, created: number): VaultNode =>
    ({ type: 'note', name, relPath: `${name}.mntl`, encrypted: false, profile: null, tags: [], modified, created });
  const root: VaultFolderNode = {
    type: 'folder',
    name: 'vault',
    relPath: '',
    children: [
      note('b', 3, 1),
      { type: 'folder', name: 'Z', relPath: 'Z', children: [] },
      note('note 10', 1, 3),
      note('note 9', 2, 2),
    ],
  };
  const names = (mode: Parameters<typeof sortVaultTree>[1], order = {}) =>
    sortVaultTree(root, mode, order).children.map((child) => child.name);

  it('keeps folders first and sorts the rest by the mode', () => {
    expect(names('name-asc')).toEqual(['Z', 'b', 'note 9', 'note 10']);
    expect(names('name-desc')).toEqual(['Z', 'note 10', 'note 9', 'b']);
    expect(names('modified')).toEqual(['Z', 'b', 'note 9', 'note 10']);
    expect(names('created')).toEqual(['Z', 'note 10', 'note 9', 'b']);
  });

  it("follows the manual order, then names for anything it doesn't list", () => {
    expect(names('manual', { '': ['note 9.mntl', 'b.mntl'] })).toEqual(['Z', 'note 9', 'b', 'note 10']);
  });

  it("sorts a folder with its own mode by that, and falls back to modified for a missing creation time", () => {
    const nested: VaultFolderNode = { ...root, children: [{ type: 'folder', name: 'Sub', relPath: 'Sub', children: root.children.filter((c) => c.type === 'note') }] };
    const sorted = sortVaultTree(nested, 'name-asc', {}, { Sub: 'name-desc' });
    expect((sorted.children[0] as VaultFolderNode).children.map((c) => c.name)).toEqual(['note 10', 'note 9', 'b']);
    const undated: VaultFolderNode = { ...root, children: [note('old', 1, 2), { ...note('new', 5, 0), created: undefined }] };
    expect(sortVaultTree(undated, 'created', {}).children.map((c) => c.name)).toEqual(['new', 'old']);
  });
});
