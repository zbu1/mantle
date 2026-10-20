import { LinkIndex, linkFixes, splitLink } from './links';
import { VaultFolderNode, VaultNoteNode } from './vault-tree.model';

const note = (relPath: string, links: string[] | null = []): VaultNoteNode => ({
  type: 'note',
  name: relPath.replace(/^.*\//, '').replace(/\.(mntl(\.enc)?|md)$/, ''),
  relPath,
  encrypted: relPath.endsWith('.enc'),
  profile: null,
  tags: [],
  links,
});

const tree = (...notes: VaultNoteNode[]): VaultFolderNode => ({ type: 'folder', name: '', relPath: '', children: notes });

describe('LinkIndex', () => {
  const index = new LinkIndex(
    tree(note('Archive/Ideas.mntl'), note('Work/Ideas.md'), note('Work/Deep/Plan.mntl.enc'), note('Other/Plan.mntl'), note('Solo.mntl')),
  );

  it('resolves names, partial paths and full paths, preferring the same folder then the shortest path', () => {
    expect(index.resolve('solo', 'x.mntl')?.relPath).toBe('Solo.mntl');
    expect(index.resolve('Ideas', 'Work/x.mntl')?.relPath).toBe('Work/Ideas.md');
    expect(index.resolve('Ideas', 'Other/x.mntl')?.relPath).toBe('Work/Ideas.md');
    expect(index.resolve('Archive/Ideas', 'Work/x.mntl')?.relPath).toBe('Archive/Ideas.mntl');
    expect(index.resolve('Deep/Plan', 'x.mntl')?.relPath).toBe('Work/Deep/Plan.mntl.enc');
    expect(index.resolve('Work/Ideas', 'x.mntl')?.relPath).toBe('Work/Ideas.md');
    expect(index.resolve('ideas.md', 'Archive/x.mntl')?.relPath).toBe('Archive/Ideas.mntl');
    expect(index.resolve('Missing', 'x.mntl')).toBeNull();
  });

  it('links by name unless the name is shared', () => {
    expect(index.linkText(index.note('Solo.mntl')!)).toBe('Solo');
    expect(index.linkText(index.note('Work/Ideas.md')!)).toBe('Work/Ideas');
  });

  it('splits a link into target, heading and alias', () => {
    expect(splitLink('Note#Part|see')).toEqual({ target: 'Note', heading: 'Part', alias: 'see' });
    expect(splitLink('Note')).toEqual({ target: 'Note', heading: null, alias: null });
  });
});

describe('linkFixes', () => {
  it('rewrites the links a rename or move would break, and only those', () => {
    const before = new LinkIndex(tree(note('A.mntl', ['B', 'Dir/C', 'Missing']), note('B.mntl', ['A']), note('Dir/C.mntl', ['B'])));
    const after = new LinkIndex(tree(note('A.mntl', ['B', 'Dir/C', 'Missing']), note('Bee.mntl', ['A']), note('New/C.mntl', ['B'])));
    const moved = (path: string) => ({ 'B.mntl': 'Bee.mntl', 'Dir/C.mntl': 'New/C.mntl' })[path] ?? path;
    expect(linkFixes(before, after, moved)).toEqual([
      { note: 'A.mntl', from: 'B', to: 'Bee' },
      { note: 'A.mntl', from: 'Dir/C', to: 'C' },
      { note: 'New/C.mntl', from: 'B', to: 'Bee' },
    ]);
  });

  it('spells out a path when a rename makes a name ambiguous', () => {
    const before = new LinkIndex(tree(note('Dir/A.mntl', ['X']), note('Other/X.mntl'), note('Dir/Y.mntl')));
    const after = new LinkIndex(tree(note('Dir/A.mntl', ['X']), note('Other/X.mntl'), note('Dir/X.mntl')));
    expect(linkFixes(before, after, (p) => (p === 'Dir/Y.mntl' ? 'Dir/X.mntl' : p))).toEqual([
      { note: 'Dir/A.mntl', from: 'X', to: 'Other/X' },
    ]);
  });
});
