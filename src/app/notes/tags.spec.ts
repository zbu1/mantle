import { buildTagGroups, isTagChar, normalizeTag, sameTag } from './tags';
import { VaultFolderNode, VaultNoteNode } from './vault-tree.model';

function note(name: string, tags: string[] | null, profile: string | null = null): VaultNoteNode {
  return { type: 'note', name, relPath: `${name}.mntl`, encrypted: profile !== null, profile, tags };
}

function vault(...children: VaultNoteNode[]): VaultFolderNode {
  return { type: 'folder', name: 'vault', relPath: '', children };
}

describe('tags', () => {
  it('normalizeTag strips a leading # and accepts letters, digits, - and _', () => {
    expect(normalizeTag('  #Idea ')).toBe('Idea');
    expect(normalizeTag('to-do_2')).toBe('to-do_2');
    expect(normalizeTag('Ärger')).toBe('Ärger');
  });

  it('normalizeTag rejects spaces, slashes and all-digit tags', () => {
    for (const raw of ['', '#', 'two words', 'work/project', '1984', 'a,b']) {
      expect(normalizeTag(raw)).toBeNull();
    }
  });

  it('isTagChar allows only what a tag can contain', () => {
    expect(['a', 'Z', '7', '-', '_', 'é'].every(isTagChar)).toBe(true);
    expect([' ', '#', '/', ',', '.'].some(isTagChar)).toBe(false);
  });

  it('sameTag ignores case', () => {
    expect(sameTag('Idea', 'idea')).toBe(true);
    expect(sameTag('idea', 'ideas')).toBe(false);
  });

  it('buildTagGroups merges spellings case-insensitively, keeping the first, and sorts by name', () => {
    const plan = note('plan', ['Work', 'idea']);
    const todo = note('todo.mntl', ['work']);
    const groups = buildTagGroups(vault(todo, plan), new Set());

    expect(groups.map((g) => g.name)).toEqual(['idea', 'work']);
    expect(groups[1].notes.map((n) => n.name)).toEqual(['plan', 'todo.mntl']);
  });

  it('buildTagGroups leaves out notes that are locked or whose tags are unknown', () => {
    const open = note('open', ['secret'], 'diary');
    const shut = note('shut', ['secret'], 'work');
    const unknown = note('unknown', null, 'work');

    const groups = buildTagGroups(vault(open, shut, unknown), new Set(['diary']));

    expect(groups).toHaveLength(1);
    expect(groups[0].notes).toEqual([open]);
  });
});
