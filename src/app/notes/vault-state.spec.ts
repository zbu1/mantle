import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../testing/tauri-mock';
import { VaultState } from './vault-state';
import { TabsState } from './tabs-state';
import { VaultFolderNode, VaultNoteNode } from './vault-tree.model';

function note(relPath: string, name = relPath): VaultNoteNode {
  return { type: 'note', name, relPath, locked: false };
}

function tree(children: VaultFolderNode['children']): VaultFolderNode {
  return { type: 'folder', name: 'vault', relPath: '', children };
}

describe('VaultState external-change reconciliation', () => {
  let mock: ReturnType<typeof installTauriMock>;

  beforeEach(() => {
    localStorage.clear();
    mock = installTauriMock();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  function setup(): { vaultState: VaultState; tabsState: TabsState } {
    const vaultState = TestBed.inject(VaultState);
    const tabsState = TestBed.inject(TabsState);
    vaultState.rootPath.set('/vault');
    return { vaultState, tabsState };
  }

  it('marks an open tab missing when its note is deleted externally', async () => {
    const { vaultState, tabsState } = setup();

    mock.respondWith('scan_vault', tree([note('a.mntl'), note('b.mntl')]));
    await vaultState.refresh();
    tabsState.openNote({ id: 'a.mntl', title: 'a' });

    mock.respondWith('scan_vault', tree([note('b.mntl')]));
    await vaultState.refresh();

    expect(tabsState.tabs().find((t) => t.noteId === 'a.mntl')?.missing).toBe(true);
  });

  it('retargets an open tab when exactly one note is renamed/moved externally', async () => {
    const { vaultState, tabsState } = setup();

    mock.respondWith('scan_vault', tree([note('a.mntl')]));
    await vaultState.refresh();
    tabsState.openNote({ id: 'a.mntl', title: 'a' });

    mock.respondWith('scan_vault', tree([note('Work/a.mntl', 'a')]));
    await vaultState.refresh();

    const tabs = tabsState.tabs();
    expect(tabs.find((t) => t.noteId === 'a.mntl')).toBeUndefined();
    const moved = tabs.find((t) => t.noteId === 'Work/a.mntl');
    expect(moved).toBeTruthy();
    expect(moved?.missing).toBeFalsy();
  });

  it('clears the missing flag once a note reappears', async () => {
    const { vaultState, tabsState } = setup();

    mock.respondWith('scan_vault', tree([note('a.mntl'), note('b.mntl')]));
    await vaultState.refresh();
    tabsState.openNote({ id: 'a.mntl', title: 'a' });

    mock.respondWith('scan_vault', tree([note('b.mntl')]));
    await vaultState.refresh();
    expect(tabsState.tabs().find((t) => t.noteId === 'a.mntl')?.missing).toBe(true);

    mock.respondWith('scan_vault', tree([note('a.mntl'), note('b.mntl')]));
    await vaultState.refresh();
    expect(tabsState.tabs().find((t) => t.noteId === 'a.mntl')?.missing).toBeFalsy();
  });

  it('does not reconcile across a vault switch', async () => {
    const { vaultState, tabsState } = setup();

    mock.respondWith('scan_vault', tree([note('a.mntl')]));
    await vaultState.refresh();
    tabsState.openNote({ id: 'a.mntl', title: 'a' });

    vaultState.rootPath.set('/other-vault');
    mock.respondWith('scan_vault', tree([note('unrelated.mntl')]));
    await vaultState.refresh();

    expect(tabsState.tabs().find((t) => t.noteId === 'a.mntl')?.missing).toBeFalsy();
  });
});
