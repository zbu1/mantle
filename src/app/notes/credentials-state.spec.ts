import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock, TauriMock } from '../../testing/tauri-mock';
import { CredentialsState, CredentialProfile } from './credentials-state';
import { NotesState } from './notes-state';
import { VaultState } from './vault-state';
import { VaultFolderNode, VaultNode, VaultNoteNode } from './vault-tree.model';

function note(relPath: string, profile: string | null = null): VaultNoteNode {
  return {
    type: 'note',
    name: relPath.replace(/\.mntl(\.enc)?$/, ''),
    relPath,
    encrypted: profile !== null || relPath.endsWith('.mntl.enc'),
    profile,
  };
}

function plaintext(relPath: string): VaultNoteNode {
  return { type: 'note', name: relPath, relPath, encrypted: false, profile: null };
}

function tree(children: VaultNode[]): VaultFolderNode {
  return { type: 'folder', name: 'vault', relPath: '', children };
}

function profile(id: string, unlocked = false): CredentialProfile {
  return { id, displayName: id.replace(/-/g, ' '), unlocked, createdAt: 0 };
}

/** Waits for pending promise chains (the invoke mock resolves asynchronously). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Args of the first `invoke` call for `command`.
 *
 * Matching on the call list rather than `toHaveBeenCalledWith` because
 * `@tauri-apps/api`'s wrapper passes a third options argument that has nothing
 * to do with what we're asserting.
 */
function invokeArgs(mock: TauriMock, command: string): Record<string, unknown> | undefined {
  return mock.invoke.mock.calls.find(([cmd]) => cmd === command)?.[1];
}

describe('CredentialsState', () => {
  let mock: TauriMock;
  let credentials: CredentialsState;
  let vaultState: VaultState;
  let notesState: NotesState;

  beforeEach(() => {
    localStorage.clear();
    mock = installTauriMock();
    mock.respondWith('list_credential_profiles', []);
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });

    vaultState = TestBed.inject(VaultState);
    notesState = TestBed.inject(NotesState);
    credentials = TestBed.inject(CredentialsState);
  });

  describe('refresh', () => {
    it('maps the backend payload onto the profiles signal', async () => {
      mock.respondWith('list_credential_profiles', [profile('my-diary', true), profile('work')]);
      vaultState.rootPath.set('/vault');

      await credentials.refresh();

      expect(credentials.profiles().map((p) => p.id)).toEqual(['my-diary', 'work']);
      expect([...credentials.unlockedIds()]).toEqual(['my-diary']);
      expect(credentials.isUnlocked('my-diary')).toBe(true);
      expect(credentials.isUnlocked('work')).toBe(false);
      expect(credentials.isUnlocked(null)).toBe(false);
    });

    it('surfaces a failure without leaving stale profiles behind', async () => {
      mock.respondWith('list_credential_profiles', [profile('my-diary', true)]);
      vaultState.rootPath.set('/vault');
      await credentials.refresh();

      mock.invoke.mockImplementation(async (command: string) => {
        if (command === 'list_credential_profiles') throw new Error('registry unreadable');
        return undefined;
      });
      await credentials.refresh();

      expect(credentials.profiles()).toEqual([]);
      expect(credentials.error()).toContain('registry unreadable');
    });
  });

  describe('membership', () => {
    beforeEach(async () => {
      mock.respondWith('list_credential_profiles', [profile('my-diary', true), profile('work')]);
      vaultState.rootPath.set('/vault');
      await credentials.refresh();
    });

    it('groups encrypted notes by the profile in their header', () => {
      vaultState.tree.set(
        tree([
          note('dream.mntl.enc', 'my-diary'),
          note('therapy.mntl.enc', 'my-diary'),
          note('salary.mntl.enc', 'work'),
          plaintext('todo.mntl'),
        ]),
      );

      const members = credentials.membersByProfile();
      expect(members.get('my-diary')?.map((n) => n.relPath)).toEqual([
        'dream.mntl.enc',
        'therapy.mntl.enc',
      ]);
      expect(members.get('work')?.map((n) => n.relPath)).toEqual(['salary.mntl.enc']);
      expect(credentials.orphans()).toEqual([]);
    });

    it('finds nested notes, not just those at the vault root', () => {
      vaultState.tree.set(
        tree([
          { type: 'folder', name: 'Personal', relPath: 'Personal', children: [note('Personal/dream.mntl.enc', 'my-diary')] },
        ]),
      );

      expect(credentials.membersByProfile().get('my-diary')?.map((n) => n.relPath)).toEqual([
        'Personal/dream.mntl.enc',
      ]);
    });

    it('reports notes naming an unregistered profile as orphans', () => {
      vaultState.tree.set(
        tree([note('dream.mntl.enc', 'my-diary'), note('imported.mntl.enc', 'archive')]),
      );

      const orphans = credentials.orphans();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].profileId).toBe('archive');
      expect(orphans[0].notes.map((n) => n.relPath)).toEqual(['imported.mntl.enc']);
      // And they don't pollute the real profiles' membership.
      expect(credentials.membersByProfile().has('archive')).toBe(false);
    });

    it('treats an unreadable header as an orphan with a null profile', () => {
      vaultState.tree.set(tree([note('corrupt.mntl.enc', null)]));

      const orphans = credentials.orphans();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].profileId).toBeNull();
    });
  });

  describe('lock', () => {
    beforeEach(async () => {
      mock.respondWith('list_credential_profiles', [profile('my-diary', true)]);
      vaultState.rootPath.set('/vault');
      await credentials.refresh();
      vaultState.tree.set(tree([note('dream.mntl.enc', 'my-diary')]));
    });

    it('flushes pending writes before locking, so no edit is lost', async () => {
      // The debounced write still holds decrypted content and still needs the
      // key: locking first would discard the user's last second of typing.
      const flushPending = jest.spyOn(notesState, 'flushPending').mockResolvedValue();
      const markLocked = jest.spyOn(notesState, 'markLocked');

      await credentials.lock('my-diary');

      expect(flushPending).toHaveBeenCalledWith(['dream.mntl.enc']);

      const flushOrder = flushPending.mock.invocationCallOrder[0];
      const lockCall = mock.invoke.mock.calls.findIndex(([cmd]) => cmd === 'lock_credential_profile');
      const lockOrder = mock.invoke.mock.invocationCallOrder[lockCall];

      expect(flushOrder).toBeLessThan(lockOrder);
      expect(markLocked.mock.invocationCallOrder[0]).toBeGreaterThan(lockOrder);
    });

    it('passes the vault root and profile id to the backend', async () => {
      jest.spyOn(notesState, 'flushPending').mockResolvedValue();
      await credentials.lock('my-diary');

      expect(invokeArgs(mock, 'lock_credential_profile')).toEqual({
        vaultRoot: '/vault',
        profileId: 'my-diary',
      });
    });

    it('does not drop decrypted content if the backend refuses to lock', async () => {
      jest.spyOn(notesState, 'flushPending').mockResolvedValue();
      const markLocked = jest.spyOn(notesState, 'markLocked');
      mock.invoke.mockImplementation(async (command: string) => {
        if (command === 'lock_credential_profile') throw new Error('nope');
        if (command === 'list_credential_profiles') return [profile('my-diary', true)];
        return undefined;
      });

      await credentials.lock('my-diary');

      expect(markLocked).not.toHaveBeenCalled();
    });

    it('lockAll flushes every pending write and marks each profile locked', async () => {
      const flushPending = jest.spyOn(notesState, 'flushPending').mockResolvedValue();
      const markLocked = jest.spyOn(notesState, 'markLocked');

      await credentials.lockAll();

      expect(flushPending).toHaveBeenCalledWith();
      expect(invokeArgs(mock, 'lock_all_credential_profiles')).toBeDefined();
      expect(markLocked).toHaveBeenCalledWith(['dream.mntl.enc'], 'my-diary');
    });
  });

  describe('vault switching', () => {
    it('clears profiles when the vault is closed', async () => {
      mock.respondWith('list_credential_profiles', [profile('my-diary', true)]);
      vaultState.rootPath.set('/vault');
      await credentials.refresh();
      expect(credentials.profiles()).toHaveLength(1);

      vaultState.rootPath.set(null);
      await flush();

      expect(credentials.profiles()).toEqual([]);
    });
  });

  describe('displayNameOf', () => {
    it('prefers the registered display name, falling back to the raw id', async () => {
      mock.respondWith('list_credential_profiles', [profile('my-diary')]);
      vaultState.rootPath.set('/vault');
      await credentials.refresh();

      expect(credentials.displayNameOf('my-diary')).toBe('my diary');
      expect(credentials.displayNameOf('archive')).toBe('archive');
      expect(credentials.displayNameOf(null)).toBe('Unknown');
    });
  });
});
