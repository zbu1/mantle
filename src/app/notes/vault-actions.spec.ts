import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../testing/tauri-mock';
import { VaultActions } from './vault-actions';
import { VaultHistoryState } from './vault-history-state';
import { VaultState } from './vault-state';
import { VaultFolderNode, VaultNoteNode } from './vault-tree.model';

const note = (relPath: string): VaultNoteNode => ({ type: 'note', name: relPath, relPath, encrypted: false, profile: null });
const folder = (relPath: string, children: VaultFolderNode['children'] = []): VaultFolderNode => ({
  type: 'folder',
  name: relPath || 'vault',
  relPath,
  children,
});

describe('VaultActions undo', () => {
  let mock: ReturnType<typeof installTauriMock>;
  let actions: VaultActions;
  let history: VaultHistoryState;

  beforeEach(async () => {
    localStorage.clear();
    mock = installTauriMock();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    mock.respondWith('scan_vault', folder('', [folder('Work'), note('a.mntl')]));
    const vaultState = TestBed.inject(VaultState);
    vaultState.rootPath.set('/vault');
    TestBed.tick();
    await vaultState.refresh();
    actions = TestBed.inject(VaultActions);
    history = TestBed.inject(VaultHistoryState);
  });

  const calls = (command: string) => mock.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

  it('moves an item back where it came from, and redoes the move', async () => {
    mock.respondWith('move_note', { name: 'a', relPath: 'Work/a.mntl' });
    await actions.move(['a.mntl'], 'Work');
    mock.respondWith('scan_vault', folder('', [folder('Work', [note('Work/a.mntl')])]));
    mock.respondWith('move_note', { name: 'a', relPath: 'a.mntl' });

    await history.undo();
    expect(calls('move_note').at(-1)).toMatchObject({ sourceRelPath: 'Work/a.mntl', destRelDir: '' });
    expect(history.canRedo()).toBe(true);

    await history.redo();
    expect(calls('move_note').at(-1)).toMatchObject({ sourceRelPath: 'a.mntl', destRelDir: 'Work' });
    expect(history.canUndo()).toBe(true);
  });

  it('undoes a delete by restoring from the trash, attachments included', async () => {
    await actions.delete([note('a.mntl')], ['attachments/x.png']);
    await history.undo();
    expect(calls('restore_from_trash')).toEqual([{ vaultRoot: '/vault', relPaths: ['a.mntl', 'attachments/x.png'] }]);
  });

  it('skips a step the vault no longer matches', async () => {
    mock.respondWith('move_note', { name: 'a', relPath: 'Work/a.mntl' });
    await actions.move(['a.mntl'], 'Work');
    // Something new took the old path in the meantime.
    mock.respondWith('scan_vault', folder('', [folder('Work', [note('Work/a.mntl')]), note('a.mntl')]));

    void history.undo();
    await new Promise((resolve) => setTimeout(resolve));
    expect(calls('move_note')).toHaveLength(1);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});
