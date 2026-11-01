import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../testing/tauri-mock';
import { DialogState } from '../shared/dialog/dialog-state';
import { CredentialsState } from './credentials-state';
import { NoteEncryptionActions } from './note-encryption-actions';
import { VaultHistoryState } from './vault-history-state';
import { VaultState } from './vault-state';
import { VaultFolderNode, VaultNoteNode } from './vault-tree.model';

const note = (relPath: string): VaultNoteNode => ({
  type: 'note',
  name: relPath.split('/').pop()!.replace(/\.(md|mntl)$/, ''),
  relPath,
  encrypted: false,
  profile: null,
});
const folder = (relPath: string, children: VaultFolderNode['children'] = []): VaultFolderNode => ({
  type: 'folder',
  name: relPath || 'vault',
  relPath,
  children,
});

describe('NoteEncryptionActions conversion', () => {
  let mock: ReturnType<typeof installTauriMock>;
  let actions: NoteEncryptionActions;
  let dialog: DialogState;

  beforeEach(async () => {
    localStorage.clear();
    mock = installTauriMock();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    mock.respondWith(
      'scan_vault',
      folder('', [
        folder('Docs', [note('Docs/a.md'), note('Docs/a.mntl'), note('Docs/a 2.mntl'), folder('Docs/sub', [note('Docs/sub/b.md')])]),
        note('c.md'),
        note('d.mntl'),
      ]),
    );
    const vaultState = TestBed.inject(VaultState);
    vaultState.rootPath.set('/vault');
    TestBed.tick();
    await vaultState.refresh();
    actions = TestBed.inject(NoteEncryptionActions);
    dialog = TestBed.inject(DialogState);
    jest.spyOn(dialog, 'confirmWithCheckbox').mockResolvedValue({ confirmed: true, checked: true });
  });

  const calls = (command: string) => mock.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

  it('finds the Markdown files in folders at any depth', () => {
    expect(actions.markdownNotesIn(['Docs', 'd.mntl', 'Docs/a.md']).map((n) => n.relPath)).toEqual(['Docs/a.md', 'Docs/sub/b.md']);
  });

  it('renames a clashing note to a free name, and undoes the batch in one step', async () => {
    jest.spyOn(dialog, 'choose').mockResolvedValue('confirm');
    mock.respondWith('convert_markdown_notes', {
      converted: [
        { from: 'Docs/a.md', name: 'a 3', relPath: 'Docs/a 3.mntl' },
        { from: 'Docs/sub/b.md', name: 'b', relPath: 'Docs/sub/b.mntl' },
      ],
      failed: [],
      removed: ['files/x.pdf'],
    });

    await actions.convertToNotes(actions.markdownNotesIn(['Docs']));
    expect(calls('convert_markdown_notes')).toEqual([
      {
        notes: [
          { relPath: 'Docs/a.md', name: 'a 3' },
          { relPath: 'Docs/sub/b.md', name: 'b' },
        ],
        removeOriginals: true,
      },
    ]);

    await TestBed.inject(VaultHistoryState).undo();
    expect(calls('restore_from_trash')).toEqual([
      { relPaths: ['Docs/a.md', 'Docs/sub/b.md', 'files/x.pdf'] },
    ]);
    expect(calls('delete_note').map((args) => (args as { relPath: string }).relPath)).toEqual([
      'Docs/a 3.mntl',
      'Docs/sub/b.mntl',
    ]);
  });

  it('skips a clashing file, or cancels everything', async () => {
    const choose = jest.spyOn(dialog, 'choose').mockResolvedValue('alt');
    mock.respondWith('convert_markdown_notes', { converted: [], failed: [], removed: [] });
    await actions.convertToNotes(actions.markdownNotesIn(['Docs', 'c.md']));
    expect((calls('convert_markdown_notes')[0] as { notes: unknown }).notes).toEqual([
      { relPath: 'Docs/sub/b.md', name: 'b' },
      { relPath: 'c.md', name: 'c' },
    ]);

    choose.mockResolvedValue(null);
    await actions.convertToNotes(actions.markdownNotesIn(['Docs']));
    expect(calls('convert_markdown_notes')).toHaveLength(1);
  });
});

describe('NoteEncryptionActions bulk encryption', () => {
  it('unlocks sources then target, keeps going past a failure, and undoes in one step', async () => {
    localStorage.clear();
    const mock = installTauriMock();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const encrypted = (relPath: string, profile: string): VaultNoteNode => ({ ...note(relPath), name: 'e', encrypted: true, profile });
    let profileOfE = 'work';
    mock.respondWith('scan_vault', folder('', [note('d.mntl'), note('h.mntl')]));
    const scan = () => folder('', [note('d.mntl'), encrypted('e.mntl.enc', profileOfE), encrypted('h.mntl.enc', 'home')]);
    const base = mock.invoke.getMockImplementation()!;
    mock.invoke.mockImplementation((command: string, args?: unknown) => {
      const { relPath, profileId } = (args ?? {}) as { relPath: string; profileId: string };
      if (command === 'scan_vault') return Promise.resolve(scan());
      if (command === 'encrypt_note_to_profile') return Promise.reject('disk full');
      if (command === 'move_note_to_profile') {
        profileOfE = profileId;
        return Promise.resolve({ relPath, name: 'e' });
      }
      return base(command, args);
    });
    const vaultState = TestBed.inject(VaultState);
    vaultState.rootPath.set('/vault');
    TestBed.tick();
    await vaultState.refresh();
    const unlock = jest.spyOn(TestBed.inject(CredentialsState), 'promptUnlock').mockResolvedValue(true);
    const alert = jest.spyOn(TestBed.inject(DialogState), 'alert').mockResolvedValue();
    const actions = TestBed.inject(NoteEncryptionActions);
    const calls = (command: string) => mock.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

    await actions.changeEncryption(actions.allNotesIn(['d.mntl', 'e.mntl.enc', 'h.mntl.enc']), 'home');
    expect(unlock.mock.calls.map(([id]) => id)).toEqual(['work', 'home']);
    expect(calls('encrypt_note_to_profile')).toEqual([{ relPath: 'd.mntl', profileId: 'home' }]);
    expect(calls('move_note_to_profile')).toEqual([{ relPath: 'e.mntl.enc', profileId: 'home' }]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toContain('d.mntl: disk full');

    await TestBed.inject(VaultHistoryState).undo();
    expect(calls('move_note_to_profile')[1]).toEqual({ relPath: 'e.mntl.enc', profileId: 'work' });
    expect(calls('encrypt_note_to_profile')).toHaveLength(1);
  });
});
