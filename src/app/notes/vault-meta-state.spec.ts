import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../testing/tauri-mock';
import { MAX_RECENT_NOTES, VaultMeta, VaultMetaState } from './vault-meta-state';

function meta(overrides: Partial<VaultMeta> = {}): VaultMeta {
  return { version: 1, favorites: [], order: {}, collapsedFolders: [], sortMode: 'name-asc', folderSort: {}, recentNotes: [], propertyTypes: {}, styles: {}, ...overrides };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('VaultMetaState', () => {
  let mock: ReturnType<typeof installTauriMock>;
  let state: VaultMetaState;

  function saves(): { vaultRoot: string; state: VaultMeta }[] {
    return mock.invoke.mock.calls.filter(([command]) => command === 'save_vault_meta').map(([, args]) => args);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mock = installTauriMock();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    state = TestBed.inject(VaultMetaState);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('load', () => {
    it('exposes the recent notes stored in the vault', async () => {
      mock.respondWith('load_vault_meta', meta({ recentNotes: [{ relPath: 'a.mntl', openedAt: 5 }] }));

      await state.load('/vault');

      expect(mock.invoke).toHaveBeenCalledWith('load_vault_meta', { vaultRoot: '/vault' }, undefined);
      expect(state.loaded()).toBe(true);
      expect(state.recentNotes()).toEqual([{ relPath: 'a.mntl', openedAt: 5 }]);
    });

    it('fills in defaults for a payload with missing or malformed fields', async () => {
      mock.respondWith('load_vault_meta', { version: 1, recentNotes: [{ relPath: 'ok.mntl', openedAt: 1 }, { relPath: 7 }, null] });

      await state.load('/vault');

      expect(state.recentNotes()).toEqual([{ relPath: 'ok.mntl', openedAt: 1 }]);
    });

    it('does not become loaded, or write anything, when loading fails', async () => {
      mock.invoke.mockImplementation((command: string) =>
        command === 'load_vault_meta' ? Promise.reject(new Error('Failed to parse vault state')) : Promise.resolve(undefined),
      );

      await state.load('/vault');
      state.recordOpened('a.mntl');
      jest.advanceTimersByTime(5_000);

      expect(state.loaded()).toBe(false);
      expect(state.recentNotes()).toEqual([]);
      expect(saves()).toEqual([]);
    });

    it('discards a load that finishes after the vault has changed', async () => {
      let resolveFirst!: (value: VaultMeta) => void;
      mock.invoke.mockImplementationOnce(() => new Promise<VaultMeta>((resolve) => (resolveFirst = resolve)));

      const first = state.load('/vault-a');
      mock.respondWith('load_vault_meta', meta({ recentNotes: [{ relPath: 'b.mntl', openedAt: 2 }] }));
      await state.load('/vault-b');
      resolveFirst(meta({ recentNotes: [{ relPath: 'a.mntl', openedAt: 1 }] }));
      await first;

      expect(state.recentNotes()).toEqual([{ relPath: 'b.mntl', openedAt: 2 }]);
    });
  });

  describe('folders', () => {
    it('keeps collapsed folders, and their manual order, attached to a renamed folder', async () => {
      mock.respondWith('load_vault_meta', meta({ collapsedFolders: ['Work', 'Work/Old', 'Home'], order: { Work: ['a.mntl'] } }));
      await state.load('/vault');

      state.renameFolder('Work', 'Job');
      expect([...state.collapsedFolders()]).toEqual(['Job', 'Job/Old', 'Home']);
      expect(state.order()).toEqual({ Job: ['a.mntl'] });

      state.forgetFolder('Job');
      expect([...state.collapsedFolders()]).toEqual(['Home']);
    });

    it("falls back to sorting by name for a sort mode it doesn't know", async () => {
      mock.respondWith('load_vault_meta', { ...meta(), sortMode: 'by-color' });
      await state.load('/vault');
      expect(state.sortMode()).toBe('name-asc');
    });
  });

  describe('recents', () => {
    beforeEach(async () => {
      mock.respondWith('load_vault_meta', meta());
      await state.load('/vault');
    });

    it('puts the most recently opened note first and stamps it', () => {
      state.recordOpened('a.mntl', 1);
      state.recordOpened('b.mntl', 2);

      expect(state.recentNotes()).toEqual([
        { relPath: 'b.mntl', openedAt: 2 },
        { relPath: 'a.mntl', openedAt: 1 },
      ]);
    });

    it('moves a re-opened note to the top instead of listing it twice', () => {
      state.recordOpened('a.mntl', 1);
      state.recordOpened('b.mntl', 2);
      state.recordOpened('a.mntl', 3);

      expect(state.recentNotes()).toEqual([
        { relPath: 'a.mntl', openedAt: 3 },
        { relPath: 'b.mntl', openedAt: 2 },
      ]);
    });

    it('keeps at most MAX_RECENT_NOTES, dropping the oldest', () => {
      for (let i = 0; i < MAX_RECENT_NOTES + 5; i++) state.recordOpened(`n${i}.mntl`, i);

      const recents = state.recentNotes();
      expect(recents).toHaveLength(MAX_RECENT_NOTES);
      expect(recents[0].relPath).toBe(`n${MAX_RECENT_NOTES + 4}.mntl`);
      expect(recents.some((entry) => entry.relPath === 'n0.mntl')).toBe(false);
    });

    it('removes a single note and clears the whole list', () => {
      state.recordOpened('a.mntl', 1);
      state.recordOpened('b.mntl', 2);

      state.removeRecent('a.mntl');
      expect(state.recentNotes().map((entry) => entry.relPath)).toEqual(['b.mntl']);

      state.clearRecents();
      expect(state.recentNotes()).toEqual([]);
    });

    it('repoints a renamed note in place, keeping its position and timestamp', () => {
      state.recordOpened('a.mntl', 1);
      state.recordOpened('b.mntl', 2);
      state.recordOpened('c.mntl', 3);

      state.renameRecent('b.mntl', 'Work/b.mntl');

      expect(state.recentNotes()).toEqual([
        { relPath: 'c.mntl', openedAt: 3 },
        { relPath: 'Work/b.mntl', openedAt: 2 },
        { relPath: 'a.mntl', openedAt: 1 },
      ]);
    });

    it('does not duplicate an entry when a note is renamed onto an already-listed path', () => {
      state.recordOpened('a.mntl', 1);
      state.recordOpened('b.mntl', 2);

      state.renameRecent('a.mntl', 'b.mntl');

      expect(state.recentNotes()).toEqual([{ relPath: 'b.mntl', openedAt: 1 }]);
    });

    it('ignores renames and removals of notes that are not listed', () => {
      state.recordOpened('a.mntl', 1);
      jest.advanceTimersByTime(1_000);
      const before = saves().length;

      state.renameRecent('missing.mntl', 'other.mntl');
      state.removeRecent('missing.mntl');
      jest.advanceTimersByTime(1_000);

      expect(saves()).toHaveLength(before);
    });
  });

  describe('favorites', () => {
    beforeEach(async () => {
      mock.respondWith('load_vault_meta', meta({ favorites: ['a.mntl', 'b.mntl', 'c.mntl'] }));
      await state.load('/vault');
    });

    it('exposes stored favorites in order', () => {
      expect(state.favorites()).toEqual(['a.mntl', 'b.mntl', 'c.mntl']);
      expect(state.isFavorite('b.mntl')).toBe(true);
      expect(state.isFavorite('z.mntl')).toBe(false);
    });

    it('toggles a note on (appended at the end) and off', () => {
      state.toggleFavorite('d.mntl');
      expect(state.favorites()).toEqual(['a.mntl', 'b.mntl', 'c.mntl', 'd.mntl']);

      state.toggleFavorite('b.mntl');
      expect(state.favorites()).toEqual(['a.mntl', 'c.mntl', 'd.mntl']);
    });

    it('adds only notes that are not favorites yet, and removes several at once', () => {
      state.addFavorites(['b.mntl', 'd.mntl', 'e.mntl', 'd.mntl']);
      expect(state.favorites()).toEqual(['a.mntl', 'b.mntl', 'c.mntl', 'd.mntl', 'e.mntl']);

      state.removeFavorites(['a.mntl', 'e.mntl', 'nope.mntl']);
      expect(state.favorites()).toEqual(['b.mntl', 'c.mntl', 'd.mntl']);
    });

    it('reorders a favorite before another, or to the end', () => {
      state.placeFavorites(['c.mntl'], 'a.mntl');
      expect(state.favorites()).toEqual(['c.mntl', 'a.mntl', 'b.mntl']);

      state.placeFavorites(['c.mntl'], null);
      expect(state.favorites()).toEqual(['a.mntl', 'b.mntl', 'c.mntl']);
    });

    it('treats dropping a favorite right before itself as a no-op', () => {
      state.placeFavorites(['b.mntl'], 'b.mntl');
      jest.advanceTimersByTime(600);

      expect(state.favorites()).toEqual(['a.mntl', 'b.mntl', 'c.mntl']);
      expect(saves()).toHaveLength(0);
    });

    it('inserts new notes at the drop position, keeping their order', () => {
      state.placeFavorites(['x.mntl', 'c.mntl', 'y.mntl'], 'b.mntl');
      expect(state.favorites()).toEqual(['a.mntl', 'x.mntl', 'c.mntl', 'y.mntl', 'b.mntl']);
    });

    it('follows a renamed note in place and without duplicating an existing entry', () => {
      state.renameNote('b.mntl', 'Work/b.mntl.enc');
      expect(state.favorites()).toEqual(['a.mntl', 'Work/b.mntl.enc', 'c.mntl']);

      // The renamed entry keeps its own (first) position; the old 'c.mntl' entry goes.
      state.renameNote('a.mntl', 'c.mntl');
      expect(state.favorites()).toEqual(['c.mntl', 'Work/b.mntl.enc']);
    });

    it('forgets a deleted note from both favorites and recents', () => {
      state.recordOpened('b.mntl', 1);

      state.forgetNote('b.mntl');

      expect(state.favorites()).toEqual(['a.mntl', 'c.mntl']);
      expect(state.recentNotes()).toEqual([]);
    });

    it('drops malformed and duplicate entries when loading', async () => {
      mock.respondWith('load_vault_meta', { version: 1, favorites: ['a.mntl', 3, 'a.mntl', null, 'b.mntl'] });

      await state.load('/other');

      expect(state.favorites()).toEqual(['a.mntl', 'b.mntl']);
    });

    it('saves favorite changes', () => {
      state.toggleFavorite('a.mntl');
      jest.advanceTimersByTime(600);

      expect(saves()[0].state.favorites).toEqual(['b.mntl', 'c.mntl']);
    });
  });

  describe('saving', () => {
    beforeEach(async () => {
      mock.respondWith(
        'load_vault_meta',
        meta({ favorites: ['fav.mntl'], order: { '': ['a.mntl'] }, collapsedFolders: ['Archive'] }),
      );
      await state.load('/vault');
    });

    it('debounces a burst of changes into one save', () => {
      state.recordOpened('a.mntl', 1);
      state.recordOpened('b.mntl', 2);
      expect(saves()).toHaveLength(0);

      jest.advanceTimersByTime(600);

      expect(saves()).toHaveLength(1);
    });

    it('writes the whole state back, preserving the fields it does not own', () => {
      state.recordOpened('a.mntl', 1);
      jest.advanceTimersByTime(600);

      expect(saves()[0]).toEqual({
        vaultRoot: '/vault',
        state: meta({
          favorites: ['fav.mntl'],
          order: { '': ['a.mntl'] },
          collapsedFolders: ['Archive'],
          recentNotes: [{ relPath: 'a.mntl', openedAt: 1 }],
        }),
      });
    });

    it('stores property types by lowercased name, dropping ones it does not know', async () => {
      mock.respondWith('load_vault_meta', { ...meta(), propertyTypes: { due: 'date', odd: 'hologram' } });
      await state.load('/other-vault');
      expect(state.propertyType('Due')).toBe('date');
      expect(state.propertyType('odd')).toBeUndefined();

      state.setPropertyType('Rating', 'number');
      jest.advanceTimersByTime(600);
      expect(saves().at(-1)!.state.propertyTypes).toEqual({ due: 'date', rating: 'number' });
    });

    it('follows icons and colors through renames and forgets them with the item', async () => {
      mock.respondWith('load_vault_meta', meta({ styles: { 'a.mntl': { icon: 'star' }, 'Work/b.mntl': { color: 'primary' } } }));
      await state.load('/vault');

      state.renameNote('a.mntl', 'c.mntl');
      state.renameFolder('Work', 'Jobs');
      expect(state.styles()).toEqual({ 'c.mntl': { icon: 'star' }, 'Jobs/b.mntl': { color: 'primary' } });

      state.setStyle('c.mntl', { icon: 'heart', color: 'success' });
      state.forgetNote('Jobs/b.mntl');
      state.setStyle('x.mntl', {});
      expect(state.styles()).toEqual({ 'c.mntl': { icon: 'heart', color: 'success' } });
      jest.advanceTimersByTime(600);
      expect(saves().at(-1)!.state.styles).toEqual({ 'c.mntl': { icon: 'heart', color: 'success' } });
    });

    it('flushes a pending save to the old vault before switching to another', async () => {
      state.recordOpened('a.mntl', 1);

      mock.respondWith('load_vault_meta', meta());
      await state.load('/other-vault');

      expect(saves()).toHaveLength(1);
      expect(saves()[0].vaultRoot).toBe('/vault');
      expect(saves()[0].state.recentNotes).toEqual([{ relPath: 'a.mntl', openedAt: 1 }]);
      expect(state.recentNotes()).toEqual([]);
    });

    it('flushes a pending save when the vault is unloaded, then ignores further changes', () => {
      state.recordOpened('a.mntl', 1);

      state.unload();
      state.recordOpened('b.mntl', 2);
      jest.advanceTimersByTime(5_000);

      expect(saves()).toHaveLength(1);
      expect(state.loaded()).toBe(false);
    });

    it('logs and carries on when a save fails', async () => {
      mock.invoke.mockImplementation((command: string) =>
        command === 'save_vault_meta' ? Promise.reject(new Error('disk full')) : Promise.resolve(undefined),
      );

      state.recordOpened('a.mntl', 1);
      jest.advanceTimersByTime(600);
      await flushMicrotasks();

      expect(state.recentNotes()).toEqual([{ relPath: 'a.mntl', openedAt: 1 }]);
    });
  });
});
