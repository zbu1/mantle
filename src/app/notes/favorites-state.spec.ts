import { TestBed } from '@angular/core/testing';
import { installTauriMock, TauriMock } from '../../testing/tauri-mock';
import { CredentialsState } from './credentials-state';
import { FavoritesState } from './favorites-state';
import { VaultMetaState } from './vault-meta-state';
import { VaultState } from './vault-state';
import { VaultFolderNode, VaultNoteNode } from './vault-tree.model';

function note(relPath: string, profile: string | null = null, extra: Partial<VaultNoteNode> = {}): VaultNoteNode {
  const name = relPath.replace(/\.mntl(\.enc)?$/, '');
  return { type: 'note', name, relPath, encrypted: profile !== null, profile, tags: [], ...extra };
}

describe('FavoritesState', () => {
  let mock: TauriMock;

  async function setup(children: VaultNoteNode[], favorites: string[]): Promise<FavoritesState> {
    mock = installTauriMock();
    mock.respondWith('scan_vault', { type: 'folder', name: 'vault', relPath: '', children } satisfies VaultFolderNode);
    mock.respondWith('list_credential_profiles', [
      { id: 'diary', displayName: 'Diary', unlocked: true },
      { id: 'work', displayName: 'Work', unlocked: false },
    ]);
    mock.respondWith('load_vault_meta', { version: 1, favorites, order: {}, collapsedFolders: [], recentNotes: [] });

    const vaultState = TestBed.inject(VaultState);
    vaultState.rootPath.set('/vault');
    TestBed.tick();
    await vaultState.refresh();
    await TestBed.inject(CredentialsState).refresh();
    await TestBed.inject(VaultMetaState).load('/vault');
    const state = TestBed.inject(FavoritesState);
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    return state;
  }

  const sealCalls = () => mock.invoke.mock.calls.filter(([command]) => command === 'set_note_favorite').map(([, args]) => args);

  it('lists plaintext favorites in stored order, then sealed ones', async () => {
    const state = await setup(
      [note('a.mntl'), note('b.mntl'), note('secret.mntl.enc', 'diary', { favorite: true })],
      ['b.mntl', 'a.mntl'],
    );

    expect(state.notes().map((n) => n.relPath)).toEqual(['b.mntl', 'a.mntl', 'secret.mntl.enc']);
    expect(state.isFavorite('secret.mntl.enc')).toBe(true);
  });

  it('moves an unlocked encrypted note out of state.json and into the note, leaving locked ones', async () => {
    const state = await setup(
      [note('a.mntl'), note('open.mntl.enc', 'diary'), note('shut.mntl.enc', 'work', { tags: null })],
      ['open.mntl.enc', 'shut.mntl.enc', 'a.mntl'],
    );

    expect(sealCalls()).toEqual([expect.objectContaining({ relPath: 'open.mntl.enc', favorite: true })]);
    expect(TestBed.inject(VaultMetaState).favorites()).toEqual(['shut.mntl.enc', 'a.mntl']);
    expect(state.notes().map((n) => n.relPath)).toEqual(['a.mntl', 'open.mntl.enc']);
  });

  it('toggles a plaintext favorite in state.json and an encrypted one in the note', async () => {
    const state = await setup([note('a.mntl'), note('secret.mntl.enc', 'diary')], []);

    state.toggle('a.mntl');
    state.toggle('secret.mntl.enc');
    await new Promise((resolve) => setTimeout(resolve));

    expect(TestBed.inject(VaultMetaState).favorites()).toEqual(['a.mntl']);
    expect(sealCalls()).toEqual([expect.objectContaining({ relPath: 'secret.mntl.enc', favorite: true })]);
    expect(state.isFavorite('secret.mntl.enc')).toBe(true);
  });
});
