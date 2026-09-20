import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../testing/tauri-mock';
import { VaultState } from './vault-state';
import { TabsState } from './tabs-state';
import { VaultMeta, VaultMetaState } from './vault-meta-state';
import { VaultFolderNode, VaultNoteNode } from './vault-tree.model';

function note(relPath: string, name = relPath): VaultNoteNode {
  return { type: 'note', name, relPath, encrypted: false, profile: null };
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

describe('VaultState recent notes', () => {
  let mock: ReturnType<typeof installTauriMock>;

  const emptyMeta: VaultMeta = { version: 1, favorites: [], order: {}, collapsedFolders: [], recentNotes: [] };

  beforeEach(() => {
    localStorage.clear();
    mock = installTauriMock();
    mock.respondWith('load_vault_meta', emptyMeta);
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  /** Opens `/vault`, runs the effects that load its metadata, and scans `notes` into the tree. */
  async function openVault(notes: VaultNoteNode[]) {
    const vaultState = TestBed.inject(VaultState);
    const tabsState = TestBed.inject(TabsState);
    const vaultMeta = TestBed.inject(VaultMetaState);
    mock.respondWith('scan_vault', tree(notes));
    vaultState.rootPath.set('/vault');
    TestBed.tick();
    await vaultMeta.load('/vault');
    await vaultState.refresh();
    TestBed.tick();
    return { vaultState, tabsState, vaultMeta };
  }

  const paths = (vaultMeta: VaultMetaState) => vaultMeta.recentNotes().map((entry) => entry.relPath);

  it('records a note when it becomes the active tab', async () => {
    const { tabsState, vaultMeta } = await openVault([note('a.mntl'), note('b.mntl')]);

    tabsState.openNote({ id: 'a.mntl', title: 'a' });
    TestBed.tick();
    tabsState.openInNewTab({ id: 'b.mntl', title: 'b' });
    TestBed.tick();

    expect(paths(vaultMeta)).toEqual(['b.mntl', 'a.mntl']);
  });

  it('records switching back to an already-open tab', async () => {
    const { tabsState, vaultMeta } = await openVault([note('a.mntl'), note('b.mntl')]);
    tabsState.openInNewTab({ id: 'a.mntl', title: 'a' });
    TestBed.tick();
    tabsState.openInNewTab({ id: 'b.mntl', title: 'b' });
    TestBed.tick();

    tabsState.openNote({ id: 'a.mntl', title: 'a' });
    TestBed.tick();

    expect(paths(vaultMeta)).toEqual(['a.mntl', 'b.mntl']);
  });

  it('does not record the tab that was restored as active at launch', async () => {
    localStorage.setItem(
      'mantle.tabs.v2',
      JSON.stringify({ tabs: [{ id: 't1', noteId: 'a.mntl', title: 'a' }], activeId: 't1' }),
    );

    const { vaultMeta } = await openVault([note('a.mntl')]);

    expect(paths(vaultMeta)).toEqual([]);
  });

  it('does not record notes that are not in the vault', async () => {
    const { tabsState, vaultMeta } = await openVault([note('a.mntl')]);

    tabsState.openNote({ id: 'daily-standup', title: 'Daily Standup' });
    TestBed.tick();

    expect(paths(vaultMeta)).toEqual([]);
  });

  it('records a freshly created note once it shows up in the tree', async () => {
    const { vaultState, tabsState, vaultMeta } = await openVault([note('a.mntl')]);

    tabsState.openNote({ id: 'new.mntl', title: 'new' });
    TestBed.tick();
    expect(paths(vaultMeta)).toEqual([]);

    mock.respondWith('scan_vault', tree([note('a.mntl'), note('new.mntl')]));
    await vaultState.refresh();
    TestBed.tick();

    expect(paths(vaultMeta)).toEqual(['new.mntl']);
  });

  it('follows a note renamed externally', async () => {
    const { vaultState, tabsState, vaultMeta } = await openVault([note('a.mntl'), note('b.mntl')]);
    tabsState.openNote({ id: 'a.mntl', title: 'a' });
    TestBed.tick();

    mock.respondWith('scan_vault', tree([note('Work/a.mntl', 'a'), note('b.mntl')]));
    await vaultState.refresh();

    expect(paths(vaultMeta)).toEqual(['Work/a.mntl']);
  });

  it('drops a note deleted externally', async () => {
    const { vaultState, tabsState, vaultMeta } = await openVault([note('a.mntl'), note('b.mntl')]);
    tabsState.openNote({ id: 'a.mntl', title: 'a' });
    TestBed.tick();
    tabsState.openInNewTab({ id: 'b.mntl', title: 'b' });
    TestBed.tick();

    mock.respondWith('scan_vault', tree([note('b.mntl')]));
    await vaultState.refresh();

    expect(paths(vaultMeta)).toEqual(['b.mntl']);
  });
});
