import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock, TauriMock } from '../../../testing/tauri-mock';
import { flushAsync } from '../../../testing/mock-vault';
import { CredentialProfile, CredentialsState } from '../credentials-state';
import { EditorFocusState } from '../editor/editor-focus-state';
import { TabsState } from '../tabs-state';
import { VaultState } from '../vault-state';
import { VaultFolderNode, VaultNode } from '../vault-tree.model';
import { NewEncryptedNote } from './new-encrypted-note';
import { NewEncryptedNoteState } from './new-encrypted-note-state';

const KDF = { mCost: 19456, tCost: 2, pCost: 1 };

function profile(id: string, unlocked: boolean, displayName = id): CredentialProfile {
  return { id, displayName, unlocked, kdf: KDF };
}

function tree(children: VaultNode[]): VaultFolderNode {
  return { type: 'folder', name: 'vault', relPath: '', children };
}

function encryptedNote(name: string, dir = '', profileId = 'work'): VaultNode {
  const relPath = `${dir ? `${dir}/` : ''}${name}.mntl.enc`;
  return { type: 'note', name, relPath, encrypted: true, profile: profileId };
}

function invokeArgs(mock: TauriMock, command: string): Record<string, unknown> | undefined {
  return mock.invoke.mock.calls.find(([cmd]) => cmd === command)?.[1];
}

describe('NewEncryptedNote', () => {
  let mock: TauriMock;
  let fixture: ComponentFixture<NewEncryptedNote>;
  let state: NewEncryptedNoteState;

  beforeEach(() => {
    localStorage.clear();
    mock = installTauriMock();
    TestBed.configureTestingModule({
      imports: [NewEncryptedNote],
      providers: [provideZonelessChangeDetection()],
    });
    state = TestBed.inject(NewEncryptedNoteState);
  });

  /** Loads a vault and its profiles, so the modal opens against realistic state. */
  async function loadVault(profiles: CredentialProfile[], children: VaultNode[] = []): Promise<void> {
    mock.respondWith('scan_vault', tree(children));
    mock.respondWith('list_credential_profiles', profiles);
    mock.respondWith('load_vault_meta', {
      version: 1,
      favorites: [],
      order: {},
      collapsedFolders: [],
      recentNotes: [],
    });
    fixture = TestBed.createComponent(NewEncryptedNote);
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

  async function open(options: Parameters<NewEncryptedNoteState['open']>[0] = {}): Promise<void> {
    state.open(options);
    await render();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const titleInput = () => el().querySelector<HTMLInputElement>('#new-encrypted-note-title')!;
  const createButton = () => buttonByText('Create note')!;

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  }

  function profileRadios(): HTMLButtonElement[] {
    return [...el().querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  }

  function checkedRadio(): string {
    return profileRadios().find((r) => r.getAttribute('aria-checked') === 'true')?.textContent ?? '';
  }

  async function typeTitle(value: string): Promise<void> {
    const input = titleInput();
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  }

  function field(selector: string): HTMLInputElement {
    return el().querySelector<HTMLInputElement>(selector)!;
  }

  it('renders nothing until opened', async () => {
    await loadVault([profile('work', true)]);
    await render();

    expect(el().querySelector('[role="dialog"]')).toBeNull();
  });

  describe('note details', () => {
    it('suggests Untitled, selected so typing replaces it, and previews the file it will create', async () => {
      await loadVault([profile('work', true)]);
      await open();

      expect(titleInput().value).toBe('Untitled');
      expect(document.activeElement).toBe(titleInput());
      expect(titleInput().selectionStart).toBe(0);
      expect(titleInput().selectionEnd).toBe('Untitled'.length);

      const text = el().textContent;
      expect(text).toContain('Vault root');
      expect(text).toContain('Untitled.mntl.enc');
    });

    it('suggests the next free name when Untitled is already taken in that folder', async () => {
      await loadVault([profile('work', true)], [encryptedNote('Untitled'), encryptedNote('Untitled 2')]);
      await open();

      expect(titleInput().value).toBe('Untitled 3');
    });

    it('shows the folder it will be created in, and the full path', async () => {
      const projects: VaultFolderNode = { type: 'folder', name: 'Projects', relPath: 'Work/Projects', children: [] };
      await loadVault([profile('work', true)], [{ type: 'folder', name: 'Work', relPath: 'Work', children: [projects] }]);
      await open({ relDir: 'Work/Projects' });
      await typeTitle('Ideas');

      const text = el().textContent;
      expect(text).toContain('Work/Projects');
      expect(text).toContain('Work/Projects/Ideas.mntl.enc');
    });

    it('blocks a title that collides with an encrypted note in the folder', async () => {
      await loadVault([profile('work', true)], [encryptedNote('Journal')]);
      await open();
      await typeTitle('Journal');

      expect(el().textContent).toContain('already exists');
      expect(createButton().disabled).toBe(true);
    });

    it('does not treat a plaintext note of the same name as a collision', async () => {
      await loadVault(
        [profile('work', true)],
        [{ type: 'note', name: 'Journal', relPath: 'Journal.mntl', encrypted: false, profile: null }],
      );
      await open();
      await typeTitle('Journal');

      expect(createButton().disabled).toBe(false);
    });

    it('rejects a title with an illegal character', async () => {
      await loadVault([profile('work', true)]);
      await open();
      await typeTitle('a/b');

      expect(el().textContent).toContain(`can't contain "/"`);
      expect(createButton().disabled).toBe(true);
    });

    it('states that the filename and folder are visible on disk, inside the box that lists them', async () => {
      await loadVault([profile('work', true)]);
      await open();

      const details = el().querySelector('dl')!.parentElement!;
      expect(details.textContent).toContain('Filename');
      expect(details.textContent).toContain("The note's contents are encrypted. Its filename and folder are visible on disk.");
      expect(el().textContent!.split('visible on disk')).toHaveLength(2);
    });
  });

  describe('profile picker', () => {
    it('lists each profile with its lock state and note count', async () => {
      await loadVault(
        [profile('work', true, 'Work'), profile('home', false, 'Home')],
        [encryptedNote('a'), encryptedNote('b'), encryptedNote('c', '', 'home')],
      );
      await open();

      const [work, home] = profileRadios();
      expect(work.textContent).toContain('Work');
      expect(work.textContent).toContain('Unlocked');
      expect(work.textContent).toContain('2 notes');
      expect(home.textContent).toContain('Locked');
      expect(home.textContent).toContain('1 note');
      expect(home.textContent).not.toContain('1 notes');
    });

    it('preselects the first unlocked profile', async () => {
      await loadVault([profile('home', false, 'Home'), profile('work', true, 'Work')]);
      await open();

      expect(checkedRadio()).toContain('Work');
      expect(createButton().disabled).toBe(false);
    });

    it('falls back to the first profile when none is unlocked', async () => {
      await loadVault([profile('home', false, 'Home'), profile('work', false, 'Work')]);
      await open();

      expect(checkedRadio()).toContain('Home');
    });

    it("preselects the profile the entry point names, even when another is unlocked", async () => {
      await loadVault([profile('home', true, 'Home'), profile('work', false, 'Work')]);
      await open({ profileId: 'work' });

      expect(checkedRadio()).toContain('Work');
    });

    it('will not create into a locked profile, and asks for its password inline', async () => {
      await loadVault([profile('work', false, 'Work')]);
      await open();

      expect(field('input[type="password"]')).toBeTruthy();
      expect(createButton().disabled).toBe(true);
    });
  });

  describe('inline unlock', () => {
    it('unlocks with the typed password, then allows creating', async () => {
      await loadVault([profile('work', false, 'Work')]);
      await open();

      field('input[type="password"]').value = 'hunter22';
      mock.respondWith('list_credential_profiles', [profile('work', true, 'Work')]);
      buttonByText('Unlock')!.click();
      await render();

      expect(invokeArgs(mock, 'unlock_credential_profile')).toMatchObject({
        profileId: 'work',
        password: 'hunter22',
      });
      expect(el().querySelector('input[type="password"]')).toBeNull();
      expect(createButton().disabled).toBe(false);
    });

    it('shows a wrong password inline and keeps what was typed', async () => {
      await loadVault([profile('work', false, 'Work')]);
      await open();
      const original = mock.invoke.getMockImplementation()!;
      mock.invoke.mockImplementation((command: string, ...rest: unknown[]) =>
        command === 'unlock_credential_profile'
          ? Promise.reject('Incorrect password.')
          : (original as (...args: unknown[]) => Promise<unknown>)(command, ...rest),
      );

      const password = field('input[type="password"]');
      password.value = 'nope';
      buttonByText('Unlock')!.click();
      await render();

      expect(el().textContent).toContain('Incorrect password.');
      expect(field('input[type="password"]').value).toBe('nope');
      expect(createButton().disabled).toBe(true);
    });

    it('asks for a password rather than sending an empty one', async () => {
      await loadVault([profile('work', false, 'Work')]);
      await open();

      buttonByText('Unlock')!.click();
      await render();

      expect(el().textContent).toContain('Enter a password.');
      expect(invokeArgs(mock, 'unlock_credential_profile')).toBeUndefined();
    });
  });

  describe('inline profile creation', () => {
    it('starts on the new-profile form when the vault has no profiles', async () => {
      await loadVault([]);
      await open();

      expect(profileRadios()).toHaveLength(1);
      expect(checkedRadio()).toContain('New profile');
      expect(field('input[placeholder="Profile name"]')).toBeTruthy();
      expect(createButton().disabled).toBe(true);
    });

    it('creates the profile, selects it, and then allows creating the note', async () => {
      await loadVault([]);
      await open();

      field('input[placeholder="Profile name"]').value = 'Work';
      field('input[placeholder="Password"]').value = 'correct horse';
      field('input[placeholder="Confirm password"]').value = 'correct horse';
      mock.respondWith('create_credential_profile', profile('work', true, 'Work'));
      mock.respondWith('list_credential_profiles', [profile('work', true, 'Work')]);
      buttonByText('Create profile')!.click();
      await render();

      expect(invokeArgs(mock, 'create_credential_profile')).toMatchObject({
        displayName: 'Work',
        password: 'correct horse',
      });
      expect(checkedRadio()).toContain('Work');
      expect(el().querySelector('input[placeholder="Profile name"]')).toBeNull();
      expect(createButton().disabled).toBe(false);
    });

    it('rejects mismatched passwords without calling the backend', async () => {
      await loadVault([]);
      await open();

      field('input[placeholder="Profile name"]').value = 'Work';
      field('input[placeholder="Password"]').value = 'correct horse';
      field('input[placeholder="Confirm password"]').value = 'correct hors';
      buttonByText('Create profile')!.click();
      await render();

      expect(el().textContent).toContain("Passwords don't match.");
      expect(invokeArgs(mock, 'create_credential_profile')).toBeUndefined();
    });

    it('rejects a too-short password', async () => {
      await loadVault([]);
      await open();

      field('input[placeholder="Profile name"]').value = 'Work';
      field('input[placeholder="Password"]').value = 'short';
      field('input[placeholder="Confirm password"]').value = 'short';
      buttonByText('Create profile')!.click();
      await render();

      expect(el().textContent).toContain('at least');
      expect(invokeArgs(mock, 'create_credential_profile')).toBeUndefined();
    });

    it('is reachable from the picker even when profiles already exist', async () => {
      await loadVault([profile('work', true, 'Work')]);
      await open();

      buttonByText('New profile')!.click();
      await render();

      expect(checkedRadio()).toContain('New profile');
      expect(field('input[placeholder="Profile name"]')).toBeTruthy();
      expect(createButton().disabled).toBe(true);
    });
  });

  describe('why Create is disabled', () => {
    const reason = () => el().querySelector('#new-encrypted-note-disabled-reason')?.textContent?.trim() ?? null;

    it('says nothing when the note can be created', async () => {
      await loadVault([profile('work', true, 'Work')]);
      await open();

      expect(createButton().disabled).toBe(false);
      expect(reason()).toBeNull();
      expect(createButton().hasAttribute('aria-describedby')).toBe(false);
    });

    it('tells you to unlock the selected profile, by name, and how', async () => {
      await loadVault([profile('work', false, 'Work')]);
      await open();

      expect(createButton().disabled).toBe(true);
      expect(reason()).toBe('"Work" is locked. Enter its password above and press Unlock to create the note.');
      expect(createButton().getAttribute('aria-describedby')).toBe('new-encrypted-note-disabled-reason');
    });

    it('goes away once the profile is unlocked', async () => {
      await loadVault([profile('work', false, 'Work')]);
      await open();

      field('input[type="password"]').value = 'hunter22';
      mock.respondWith('list_credential_profiles', [profile('work', true, 'Work')]);
      buttonByText('Unlock')!.click();
      await render();

      expect(reason()).toBeNull();
    });

    it('tells you to create a profile when the vault has none', async () => {
      await loadVault([]);
      await open();

      expect(reason()).toBe('Notes are encrypted with a profile. Create one above to continue.');
    });

    it('tells you to finish or abandon a new profile when others exist', async () => {
      await loadVault([profile('work', true, 'Work')]);
      await open();
      buttonByText('New profile')!.click();
      await render();

      expect(reason()).toBe('Finish creating the new profile, or pick an existing one above.');
    });

    it('points at the title when that is what is wrong', async () => {
      await loadVault([profile('work', true, 'Work')]);
      await open();
      await typeTitle('');

      expect(reason()).toBe('Fix the title above to create the note.');
    });

    it('names the title first when the profile is also not ready', async () => {
      await loadVault([profile('work', false, 'Work')]);
      await open();
      await typeTitle('a/b');

      expect(reason()).toBe('Fix the title above to create the note.');

      await typeTitle('ok');
      expect(reason()).toContain('is locked');
    });

    it('stays quiet while busy, since the button already says Working…', async () => {
      await loadVault([profile('work', true, 'Work')]);
      await open();
      const original = mock.invoke.getMockImplementation()!;
      mock.invoke.mockImplementation((command: string, ...rest: unknown[]) =>
        command === 'create_encrypted_note'
          ? new Promise(() => {})
          : (original as (...args: unknown[]) => Promise<unknown>)(command, ...rest),
      );

      createButton().click();
      fixture.detectChanges();

      // The label changes while busy, so `createButton()` can no longer find it by text.
      const buttons = el().querySelectorAll<HTMLButtonElement>('button');
      const create = buttons[buttons.length - 1];
      expect(create.disabled).toBe(true);
      expect(create.textContent).toContain('Working');
      expect(reason()).toBeNull();
    });
  });

  describe('creating the note', () => {
    it('creates it in the chosen folder and profile, then opens it and asks the editor to focus', async () => {
      await loadVault([profile('work', true, 'Work')], [{ type: 'folder', name: 'Work', relPath: 'Work', children: [] }]);
      mock.respondWith('create_encrypted_note', { name: 'Ideas', relPath: 'Work/Ideas.mntl.enc' });
      await open({ relDir: 'Work' });
      await typeTitle('  Ideas ');

      createButton().click();
      await render();

      expect(invokeArgs(mock, 'create_encrypted_note')).toMatchObject({
        relDir: 'Work',
        name: 'Ideas',
        profileId: 'work',
      });
      expect(state.isOpen()).toBe(false);
      expect(TestBed.inject(TabsState).tabs().map((tab) => tab.noteId)).toEqual(['Work/Ideas.mntl.enc']);
      expect(TestBed.inject(EditorFocusState).consume('Work/Ideas.mntl.enc')).toBe(true);
    });

    it('creates on Enter in the title field', async () => {
      await loadVault([profile('work', true, 'Work')]);
      mock.respondWith('create_encrypted_note', { name: 'Untitled', relPath: 'Untitled.mntl.enc' });
      await open();

      titleInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await render();

      expect(invokeArgs(mock, 'create_encrypted_note')).toBeDefined();
      expect(state.isOpen()).toBe(false);
    });

    it("keeps the modal open and shows the backend's error when creation fails", async () => {
      await loadVault([profile('work', true, 'Work')]);
      await open();
      const original = mock.invoke.getMockImplementation()!;
      mock.invoke.mockImplementation((command: string, ...rest: unknown[]) =>
        command === 'create_encrypted_note'
          ? Promise.reject('A note named "Untitled" already exists in this folder')
          : (original as (...args: unknown[]) => Promise<unknown>)(command, ...rest),
      );

      createButton().click();
      await render();

      expect(state.isOpen()).toBe(true);
      expect(el().textContent).toContain('already exists in this folder');
      expect(TestBed.inject(TabsState).tabs()).toHaveLength(0);
      expect(createButton().disabled).toBe(false);
    });
  });

  describe('dismissal', () => {
    it('closes on Escape', async () => {
      await loadVault([profile('work', true)]);
      await open();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await render();

      expect(state.isOpen()).toBe(false);
      expect(el().querySelector('[role="dialog"]')).toBeNull();
    });

    it('closes on Cancel and on a backdrop click, but not a click inside the dialog', async () => {
      await loadVault([profile('work', true)]);
      await open();

      el().querySelector('[role="dialog"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await render();
      expect(state.isOpen()).toBe(true);

      el().firstElementChild!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await render();
      expect(state.isOpen()).toBe(false);

      await open();
      buttonByText('Cancel')!.click();
      await render();
      expect(state.isOpen()).toBe(false);
    });

    it('starts from a clean form each time it opens', async () => {
      await loadVault([profile('work', true)]);
      await open();
      await typeTitle('Draft');
      state.close();
      await render();

      await open();

      expect(titleInput().value).toBe('Untitled');
    });
  });
});
