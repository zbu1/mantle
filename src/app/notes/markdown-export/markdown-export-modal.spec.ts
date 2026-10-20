import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock, TauriMock } from '../../../testing/tauri-mock';
import { flushAsync } from '../../../testing/mock-vault';
import { CredentialsState } from '../credentials-state';
import { VaultState } from '../vault-state';
import { VaultNoteNode } from '../vault-tree.model';
import { MarkdownExportModal } from './markdown-export-modal';
import { MarkdownExportState } from './markdown-export-state';

const KDF = { mCost: 19456, tCost: 2, pCost: 1 };

const note = (relPath: string, profile: string | null = null): VaultNoteNode => ({
  type: 'note',
  name: relPath.replace(/^.*\//, '').replace(/\.mntl(\.enc)?$/, ''),
  relPath,
  encrypted: profile !== null,
  profile,
});

describe('MarkdownExportModal', () => {
  let mock: TauriMock;
  let fixture: ComponentFixture<MarkdownExportModal>;

  beforeEach(async () => {
    mock = installTauriMock();
    TestBed.configureTestingModule({ imports: [MarkdownExportModal], providers: [provideZonelessChangeDetection()] });
    mock.respondWith('scan_vault', { type: 'folder', name: 'vault', relPath: '', children: [] });
    mock.respondWith('list_credential_profiles', [
      { id: 'diary', displayName: 'Diary', unlocked: false, kdf: KDF },
    ]);
    mock.respondWith('load_vault_meta', { version: 1, favorites: [], order: {}, collapsedFolders: [], recentNotes: [] });
    fixture = TestBed.createComponent(MarkdownExportModal);
    const vaultState = TestBed.inject(VaultState);
    vaultState.rootPath.set('/vault');
    await vaultState.refresh();
    await TestBed.inject(CredentialsState).refresh();
  });

  async function open(notes: VaultNoteNode[]): Promise<string> {
    TestBed.inject(MarkdownExportState).openConvert(notes);
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    return fixture.nativeElement.textContent as string;
  }

  it("refuses Mantle's own attachments folder for notes in the vault root", async () => {
    const text = await open([note('Root.mntl')]);
    expect(text).toContain(`Mantle's own "attachments" folder`);
    const confirm = [...fixture.nativeElement.querySelectorAll('button')].find((b: HTMLButtonElement) => b.textContent?.trim() === 'Convert');
    expect(confirm.disabled).toBe(true);
  });

  it('allows it beside notes in a folder, and says a locked profile is left out', async () => {
    const text = await open([note('Work/A.mntl'), note('Work/B.mntl.enc', 'diary')]);
    expect(text).not.toContain(`Mantle's own`);
    expect(text).toContain('"Diary"');
    expect(text).toContain('Not included');
  });
});
