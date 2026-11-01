import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock, TauriMock } from '../../../testing/tauri-mock';
import { flushAsync } from '../../../testing/mock-vault';
import { DialogState } from '../../shared/dialog/dialog-state';
import { CredentialProfile, CredentialsState } from '../credentials-state';
import { NoteEncryptionActions } from '../note-encryption-actions';
import { VaultState } from '../vault-state';
import { VaultNode, VaultNoteNode } from '../vault-tree.model';
import { NoteEncryptionModal } from './note-encryption-modal';
import { NoteEncryptionModalState } from './note-encryption-modal-state';
import { relPathAfter } from './note-encryption-modal.model';
import { dirOf, fileNameOf } from '../vault-tree.model';

const KDF = { mCost: 19456, tCost: 2, pCost: 1 };

function profile(id: string, unlocked: boolean, displayName = id): CredentialProfile {
  return { id, displayName, unlocked, kdf: KDF };
}

function plainNote(name: string, dir = ''): VaultNoteNode {
  return { type: 'note', name, relPath: `${dir ? `${dir}/` : ''}${name}.mntl`, encrypted: false, profile: null };
}

function encryptedNote(name: string, profileId = 'work', dir = ''): VaultNoteNode {
  return { type: 'note', name, relPath: `${dir ? `${dir}/` : ''}${name}.mntl.enc`, encrypted: true, profile: profileId };
}

function invokeArgs(mock: TauriMock, command: string): Record<string, unknown> | undefined {
  return mock.invoke.mock.calls.find(([cmd]) => cmd === command)?.[1];
}

describe('NoteEncryptionModal', () => {
  let mock: TauriMock;
  let fixture: ComponentFixture<NoteEncryptionModal>;
  let state: NoteEncryptionModalState;

  beforeEach(() => {
    localStorage.clear();
    mock = installTauriMock();
    TestBed.configureTestingModule({
      imports: [NoteEncryptionModal],
      providers: [provideZonelessChangeDetection()],
    });
    state = TestBed.inject(NoteEncryptionModalState);
  });

  /** Loads a vault and its profiles, so the modal opens against realistic state. */
  async function loadVault(profiles: CredentialProfile[], children: VaultNode[] = []): Promise<void> {
    mock.respondWith('scan_vault', { type: 'folder', name: 'vault', relPath: '', children });
    mock.respondWith('list_credential_profiles', profiles);
    mock.respondWith('load_vault_meta', {
      version: 1,
      favorites: [],
      order: {},
      collapsedFolders: [],
      recentNotes: [],
    });
    fixture = TestBed.createComponent(NoteEncryptionModal);
    const vaultState = TestBed.inject(VaultState);
    vaultState.rootPath.set('/vault');
    TestBed.tick();
    await vaultState.refresh();
    await TestBed.inject(CredentialsState).refresh();
  }

  /** Renders, then lets the async backend calls the render kicked off settle and renders their result. */
  async function render(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    await flushAsync();
    fixture.detectChanges();
  }

  async function open(note: VaultNoteNode): Promise<void> {
    state.open(note);
    await render();
  }

  const el = () => fixture.nativeElement as HTMLElement;

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  }

  function radioByText(text: string): HTMLButtonElement {
    return [...el().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) => r.textContent?.includes(text))!;
  }

  function checkedRadio(): string {
    return (
      [...el().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) => r.getAttribute('aria-checked') === 'true')
        ?.textContent ?? ''
    );
  }

  const reason = () => el().querySelector('#note-encryption-disabled-reason')?.textContent?.trim() ?? null;

  async function click(button: HTMLButtonElement): Promise<void> {
    button.click();
    await render();
  }

  it('renders nothing until opened', async () => {
    await loadVault([profile('work', true)]);
    await render();

    expect(el().querySelector('[role="dialog"]')).toBeNull();
  });

  describe('encrypting a plaintext note', () => {
    it('titles itself for encrypting, and says the note is not encrypted yet', async () => {
      await loadVault([profile('work', true, 'Work')], [plainNote('Journal')]);
      await open(plainNote('Journal'));

      expect(el().querySelector('h2')!.textContent).toContain('Encrypt note');
      expect(el().textContent).toContain('Journal');
      expect(el().textContent).toContain('Not encrypted');
    });

    it('previews the encrypted file it will leave behind, in its own folder', async () => {
      const note = plainNote('Ideas', 'Work');
      await loadVault([profile('work', true, 'Work')], [note]);
      await open(note);

      const text = el().textContent;
      expect(text).toContain('Work');
      expect(text).toContain('Ideas.mntl.enc');
      expect(text).toContain('Work/Ideas.mntl.enc');
      expect(text).toContain('visible on disk');
    });

    it('preselects the first unlocked profile and offers no "No encryption" option', async () => {
      await loadVault([profile('home', false, 'Home'), profile('work', true, 'Work')], [plainNote('Journal')]);
      await open(plainNote('Journal'));

      expect(checkedRadio()).toContain('Work');
      expect(radioByText('No encryption')).toBeUndefined();
      expect(reason()).toBeNull();
    });

    it('encrypts into the chosen profile, and closes', async () => {
      const note = plainNote('Journal', 'Work');
      await loadVault([profile('work', true, 'Work')], [note]);
      mock.respondWith('encrypt_note_to_profile', { name: 'Journal', relPath: 'Work/Journal.mntl.enc' });
      await open(note);

      await click(buttonByText('Encrypt note')!);

      expect(invokeArgs(mock, 'encrypt_note_to_profile')).toMatchObject({
        relPath: 'Work/Journal.mntl',
        profileId: 'work',
      });
      expect(state.isOpen()).toBe(false);
    });

    it('will not encrypt into a locked profile, and asks for its password inline', async () => {
      await loadVault([profile('work', false, 'Work')], [plainNote('Journal')]);
      await open(plainNote('Journal'));

      expect(el().querySelector('input[type="password"]')).toBeTruthy();
      expect(buttonByText('Encrypt note')!.disabled).toBe(true);
      expect(reason()).toBe('"Work" is locked. Enter its password above and press Unlock to continue.');
    });

    it('starts on the new-profile form when the vault has no profiles', async () => {
      await loadVault([], [plainNote('Journal')]);
      await open(plainNote('Journal'));

      expect(checkedRadio()).toContain('New profile');
      expect(buttonByText('Encrypt note')!.disabled).toBe(true);
      expect(reason()).toBe('Notes are encrypted with a profile. Create one above to continue.');
    });

    it('is blocked, by name, when the encrypted file would collide with an existing note', async () => {
      const note = plainNote('Journal');
      await loadVault([profile('work', true, 'Work')], [note, encryptedNote('Journal', 'home')]);
      await open(note);

      expect(buttonByText('Encrypt note')!.disabled).toBe(true);
      expect(reason()).toBe('A note named "Journal.mntl.enc" already exists in this folder.');
    });
  });

  describe('changing an encrypted note', () => {
    const note = encryptedNote('Diary', 'work');

    it('titles itself for changing, and names the current profile', async () => {
      await loadVault([profile('work', true, 'Work'), profile('home', true, 'Home')], [note]);
      await open(note);

      expect(el().querySelector('h2')!.textContent).toContain('Change encryption');
      expect(el().textContent).toContain('Encrypted with "Work"');
    });

    it('lists the current profile as unselectable, and preselects nothing', async () => {
      await loadVault([profile('work', true, 'Work'), profile('home', true, 'Home')], [note]);
      await open(note);

      const current = radioByText('Work');
      expect(current.textContent).toContain('Current');
      expect(current.disabled).toBe(true);
      expect(checkedRadio()).toBe('');
      expect(buttonByText('Move note')!.disabled).toBe(true);
      expect(reason()).toBe('Pick a profile to move this note to, or remove its encryption.');
    });

    it('keeps the filename when moving to another profile', async () => {
      await loadVault([profile('work', true, 'Work'), profile('home', true, 'Home')], [note]);
      await open(note);
      await click(radioByText('Home'));

      expect(el().textContent).toContain('Diary.mntl.enc');
      expect(buttonByText('Move note')!.disabled).toBe(false);
    });

    it('moves the note to the chosen profile, and closes', async () => {
      await loadVault([profile('work', true, 'Work'), profile('home', true, 'Home')], [note]);
      await open(note);
      await click(radioByText('Home'));

      await click(buttonByText('Move note')!);

      expect(invokeArgs(mock, 'move_note_to_profile')).toMatchObject({
        relPath: 'Diary.mntl.enc',
        profileId: 'home',
      });
      expect(state.isOpen()).toBe(false);
    });

    it('will not move into a locked profile until it is unlocked', async () => {
      await loadVault([profile('work', true, 'Work'), profile('home', false, 'Home')], [note]);
      await open(note);
      await click(radioByText('Home'));

      expect(buttonByText('Move note')!.disabled).toBe(true);
      expect(reason()).toContain('"Home" is locked');
    });

    it('offers "No encryption", previewing the plaintext file and warning what it means', async () => {
      await loadVault([profile('work', true, 'Work')], [note]);
      await open(note);
      await click(radioByText('No encryption'));

      const text = el().textContent;
      expect(text).toContain('Diary.mntl');
      expect(text).not.toContain('Diary.mntl.enc');
      expect(text).toContain('readable text on disk, no longer protected by "Work"');
      expect(buttonByText('Decrypt note')!.disabled).toBe(false);
    });

    it('decrypts without a second confirmation, since the warning is already on screen', async () => {
      await loadVault([profile('work', true, 'Work')], [note]);
      mock.respondWith('decrypt_note_to_plaintext', { name: 'Diary', relPath: 'Diary.mntl' });
      await open(note);
      await click(radioByText('No encryption'));

      await click(buttonByText('Decrypt note')!);

      expect(invokeArgs(mock, 'decrypt_note_to_plaintext')).toMatchObject({ relPath: 'Diary.mntl.enc' });
      expect(TestBed.inject(DialogState).request()).toBeNull();
      expect(state.isOpen()).toBe(false);
    });

    it('is blocked when the plaintext file would collide with an existing note', async () => {
      await loadVault([profile('work', true, 'Work')], [note, plainNote('Diary')]);
      await open(note);
      await click(radioByText('No encryption'));

      expect(buttonByText('Decrypt note')!.disabled).toBe(true);
      expect(reason()).toBe('A note named "Diary.mntl" already exists in this folder.');
    });
  });

  describe('dismissal', () => {
    it('closes on Escape', async () => {
      await loadVault([profile('work', true)], [plainNote('Journal')]);
      await open(plainNote('Journal'));

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await render();

      expect(state.isOpen()).toBe(false);
      expect(el().querySelector('[role="dialog"]')).toBeNull();
    });

    it('closes on Cancel and on a backdrop click, but not a click inside the dialog', async () => {
      await loadVault([profile('work', true)], [plainNote('Journal')]);
      await open(plainNote('Journal'));

      el().querySelector('[role="dialog"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await render();
      expect(state.isOpen()).toBe(true);

      el().firstElementChild!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await render();
      expect(state.isOpen()).toBe(false);

      await open(plainNote('Journal'));
      await click(buttonByText('Cancel')!);
      expect(state.isOpen()).toBe(false);
    });

    it('does nothing to the note when cancelled', async () => {
      await loadVault([profile('work', true)], [plainNote('Journal')]);
      await open(plainNote('Journal'));

      await click(buttonByText('Cancel')!);

      expect(invokeArgs(mock, 'encrypt_note_to_profile')).toBeUndefined();
    });

    it('starts from a clean form each time it opens', async () => {
      await loadVault([profile('work', true, 'Work'), profile('home', true, 'Home')], [encryptedNote('Diary')]);
      await open(encryptedNote('Diary'));
      await click(radioByText('No encryption'));
      state.close();
      await render();

      await open(encryptedNote('Diary'));

      expect(checkedRadio()).toBe('');
    });
  });
});

describe('NoteEncryptionActions.menuItems', () => {
  let actions: NoteEncryptionActions;
  let credentials: CredentialsState;

  beforeEach(() => {
    localStorage.clear();
    installTauriMock();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    actions = TestBed.inject(NoteEncryptionActions);
    credentials = TestBed.inject(CredentialsState);
  });

  function labels(note: VaultNoteNode): string[] {
    return actions.menuItems(note).flatMap((item) => (item.kind === 'item' ? [item.label] : []));
  }

  it('is a single "Encrypt…" for a plaintext note, however many profiles exist', () => {
    credentials.profiles.set([profile('a', true), profile('b', false), profile('c', true)]);

    expect(labels(plainNote('Journal'))).toEqual(['Encrypt…']);
  });

  it('is a single "Change Encryption…" for an unlocked encrypted note', () => {
    credentials.profiles.set([profile('work', true), profile('home', true)]);

    expect(labels(encryptedNote('Diary'))).toEqual(['Change Encryption…']);
  });

  it('still only offers to unlock a locked note, since it cannot be re-sealed without its key', () => {
    credentials.profiles.set([profile('work', false, 'Work'), profile('home', true)]);

    expect(labels(encryptedNote('Diary'))).toEqual(['Unlock "Work"']);
  });

  it('opens the modal for the note when chosen', () => {
    credentials.profiles.set([profile('work', true)]);
    const note = plainNote('Journal');

    const item = actions.menuItems(note)[0];
    if (item.kind === 'item') item.action();

    expect(TestBed.inject(NoteEncryptionModalState).note()).toBe(note);
  });
});

describe('note-encryption-modal.model', () => {
  it('swaps the extension only when encrypting or decrypting', () => {
    expect(relPathAfter('a/b.mntl', 'encrypt')).toBe('a/b.mntl.enc');
    expect(relPathAfter('a/b.mntl.enc', 'decrypt')).toBe('a/b.mntl');
    expect(relPathAfter('a/b.mntl.enc', 'move')).toBe('a/b.mntl.enc');
  });

  it('splits a vault-relative path into folder and filename', () => {
    expect(dirOf('a/b/c.mntl')).toBe('a/b');
    expect(dirOf('c.mntl')).toBe('');
    expect(fileNameOf('a/b/c.mntl')).toBe('c.mntl');
    expect(fileNameOf('c.mntl')).toBe('c.mntl');
  });
});
