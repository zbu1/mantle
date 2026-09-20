import { VaultNoteNode } from '../../notes/vault-tree.model';
import { filterQuickSwitcherItems, toQuickSwitcherItems } from './quick-switcher.model';

function note(relPath: string): VaultNoteNode {
  const name = (relPath.split('/').pop() ?? relPath).replace(/\.mntl$/, '');
  return { type: 'note', name, relPath, encrypted: false, profile: null };
}

const items = toQuickSwitcherItems([
  note('alpha.mntl'),
  note('beta.mntl'),
  note('Work/gamma.mntl'),
  note('Work/delta.mntl'),
]);

const paths = (result: ReturnType<typeof filterQuickSwitcherItems>) => result.map((item) => item.note.relPath);

describe('filterQuickSwitcherItems', () => {
  describe('with an empty query', () => {
    it('keeps tree order when there are no recents', () => {
      expect(paths(filterQuickSwitcherItems(items, ''))).toEqual([
        'alpha.mntl',
        'beta.mntl',
        'Work/gamma.mntl',
        'Work/delta.mntl',
      ]);
    });

    it('lists recents first in recency order, then the remaining notes in tree order', () => {
      const result = filterQuickSwitcherItems(items, '  ', ['Work/delta.mntl', 'beta.mntl']);

      expect(paths(result)).toEqual(['Work/delta.mntl', 'beta.mntl', 'alpha.mntl', 'Work/gamma.mntl']);
    });

    it('skips recents that are no longer in the vault, without duplicating any note', () => {
      const result = filterQuickSwitcherItems(items, '', ['gone.mntl', 'alpha.mntl']);

      expect(paths(result)).toEqual(['alpha.mntl', 'beta.mntl', 'Work/gamma.mntl', 'Work/delta.mntl']);
    });

    it('lists only recents in recents-only mode', () => {
      const result = filterQuickSwitcherItems(items, '', ['Work/gamma.mntl', 'alpha.mntl'], true);

      expect(paths(result)).toEqual(['Work/gamma.mntl', 'alpha.mntl']);
    });

    it('lists nothing in recents-only mode when there are no recents', () => {
      expect(filterQuickSwitcherItems(items, '', [], true)).toEqual([]);
    });
  });

  describe('with a query', () => {
    it('ranks by match quality regardless of recents', () => {
      const result = filterQuickSwitcherItems(items, 'a', ['Work/delta.mntl']);

      // "alpha" is a name prefix; the rest are name substrings, ordered by name.
      expect(paths(result)).toEqual(['alpha.mntl', 'beta.mntl', 'Work/delta.mntl', 'Work/gamma.mntl']);
    });

    it('confines matches to recents in recents-only mode', () => {
      const result = filterQuickSwitcherItems(items, 'a', ['beta.mntl', 'Work/gamma.mntl'], true);

      expect(paths(result)).toEqual(['beta.mntl', 'Work/gamma.mntl']);
    });

    it('returns nothing when no recent matches in recents-only mode', () => {
      expect(filterQuickSwitcherItems(items, 'alpha', ['beta.mntl'], true)).toEqual([]);
    });
  });
});
