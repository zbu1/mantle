import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../testing/tauri-mock';
import { DialogState } from '../shared/dialog/dialog-state';
import { AttachmentsState, isImagePath } from './attachments-state';
import { VaultState } from './vault-state';

describe('AttachmentsState', () => {
  let mock: ReturnType<typeof installTauriMock>;

  beforeEach(() => {
    localStorage.clear();
    mock = installTauriMock();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    TestBed.inject(VaultState).rootPath.set('/vault');
  });

  /** Answers the open dialog once it appears: confirm (ticking its checkbox if `checked`) or cancel. */
  async function answer(confirm: boolean, checked = false) {
    const dialog = TestBed.inject(DialogState);
    for (let i = 0; i < 10 && !dialog.request(); i++) await Promise.resolve();
    const request = dialog.request();
    if (confirm) dialog.confirmAction(undefined, checked);
    else dialog.cancel();
    return request;
  }

  it('offers the attachments only the deleted note uses, deleting them only when ticked', async () => {
    mock.respondWith('unused_attachments', { paths: ['attachments/a.png'], unchecked: [] });
    const attachments = TestBed.inject(AttachmentsState);

    const pending = attachments.confirmDeleteNotes(['Trip.mntl'], { title: 'Delete Note', message: 'Trash?', scope: 'note' });
    const request = await answer(true, true);
    expect(request?.kind === 'confirm' && request.checkboxLabel).toContain('1 attachment');
    expect(await pending).toEqual({ confirmed: true, attachments: ['attachments/a.png'] });

    const unticked = attachments.confirmDeleteNotes(['Trip.mntl'], { title: 'Delete Note', message: 'Trash?', scope: 'note' });
    await answer(true, false);
    expect(await unticked).toEqual({ confirmed: true, attachments: [] });
  });

  it('asks a plain question when nothing would go along, and says why for locked notes', async () => {
    mock.respondWith('unused_attachments', { paths: [], unchecked: ['a.mntl.enc', 'b.mntl.enc'] });
    const attachments = TestBed.inject(AttachmentsState);

    const pending = attachments.confirmDeleteNotes(['a.mntl.enc', 'b.mntl.enc'], {
      title: 'Delete Folder',
      message: 'Trash?',
      scope: 'folder',
    });
    const request = await answer(false);
    expect(request?.kind === 'confirm' && request.checkboxLabel).toBeNull();
    expect(request?.message).toContain("2 locked notes can't be checked");
    expect(await pending).toEqual({ confirmed: false, attachments: [] });
  });

  it('recognizes images, sealed or not', () => {
    expect(['a.PNG', 'attachments/x.jpg.enc', 'b/c.webp'].map(isImagePath)).toEqual([true, true, true]);
    expect(['notes.mntl', 'plan.pdf', 'png', 'x.mntl.enc'].map(isImagePath)).toEqual([false, false, false, false]);
  });
});
