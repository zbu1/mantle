import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../testing/tauri-mock';
import { DialogState } from '../shared/dialog/dialog-state';
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
        vaultRoot: '/vault',
        notes: [
          { relPath: 'Docs/a.md', name: 'a 3' },
          { relPath: 'Docs/sub/b.md', name: 'b' },
        ],
        removeOriginals: true,
      },
    ]);

    await TestBed.inject(VaultHistoryState).undo();
    expect(calls('restore_from_trash')).toEqual([
      { vaultRoot: '/vault', relPaths: ['Docs/a.md', 'Docs/sub/b.md', 'files/x.pdf'] },
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
