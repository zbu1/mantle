import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../testing/tauri-mock';
import { MAX_RECENT_NOTES, VaultMeta, VaultMetaState } from './vault-meta-state';

function meta(overrides: Partial<VaultMeta> = {}): VaultMeta {
  return { version: 1, favorites: [], order: {}, collapsedFolders: [], recentNotes: [], ...overrides };
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
