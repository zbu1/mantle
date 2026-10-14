import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { EncryptionPanel } from './encryption-panel';
import { EncryptionPanelState } from './encryption-panel-state';
import { CredentialsState } from '../credentials-state';
import { NoteEncryptionModalState } from '../note-encryption-modal/note-encryption-modal-state';
import { VaultNoteNode } from '../vault-tree.model';
import { VaultState } from '../vault-state';
import { installMockVaultInvoke, flushAsync } from '../../../testing/mock-vault';

function plainNote(relPath = 'todo.mntl'): VaultNoteNode {
  return { type: 'note', name: 'todo.mntl', relPath, encrypted: false, profile: null };
}

function encryptedNote(relPath = 'secret.mntl.enc', profile: string | null = 'ghost-profile'): VaultNoteNode {
  return { type: 'note', name: 'secret', relPath, encrypted: true, profile };
}

// jsdom doesn't lay elements out, so getBoundingClientRect() reports all zeros
// by default; the panel's positioning math only needs a stable, non-degenerate
// rect to run against.
function anchorAt(rect: Partial<DOMRect>): HTMLButtonElement {
  const el = document.createElement('button');
  document.body.appendChild(el);
  jest.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    right: 140,
    top: 40,
    bottom: 60,
    width: 40,
    height: 20,
    x: 100,
    y: 40,
    toJSON: () => {},
    ...rect,
  } as DOMRect);
  return el;
}

describe('EncryptionPanel', () => {
  let state: EncryptionPanelState;
  let anchor: HTMLButtonElement;
  let writeText: jest.Mock;

  beforeEach(() => {
    // VaultState.rootPath persists to localStorage, so tests that set it
    // would otherwise leak into later tests' fresh injector.
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [EncryptionPanel],
      providers: [provideZonelessChangeDetection()],
    });
    installMockVaultInvoke();
    state = TestBed.inject(EncryptionPanelState);
    anchor = anchorAt({});

    // jsdom has no Clipboard implementation.
    writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
  });

  afterEach(() => anchor.remove());

  it('renders nothing until opened', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-menu-surface')).toBeNull();
  });

  it('shows status and file info, with the full filesystem location, for a plaintext note', async () => {
    TestBed.inject(VaultState).rootPath.set('/fake/vault');
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, plainNote('Projects/todo.mntl'));
    fixture.detectChanges();
    await flushAsync();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Not encrypted');
    expect(text).toContain('todo.mntl');
    expect(text).toContain('/fake/vault/Projects');
    expect(text).toContain('Plaintext (.mntl)');
  });

  it('copies the file name on click and shows "Copied!" until the timeout clears it', () => {
    jest.useFakeTimers();
    try {
      const fixture = TestBed.createComponent(EncryptionPanel);
      state.toggle(anchor, plainNote('todo.mntl'));
      fixture.detectChanges();

      const button: HTMLButtonElement = fixture.nativeElement.querySelector('button[title="Copy file name"]');
      button.click();
      fixture.detectChanges();

      expect(writeText).toHaveBeenCalledWith('todo.mntl');
      expect(button.textContent?.trim()).toBe('Copied!');

      jest.advanceTimersByTime(1200);
      fixture.detectChanges();

      expect(button.textContent?.trim()).toBe('todo.mntl');
    } finally {
      jest.useRealTimers();
    }
  });

  it('copies the full filesystem location on click, separately from the file name', async () => {
    TestBed.inject(VaultState).rootPath.set('/fake/vault');
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, plainNote('Projects/todo.mntl'));
    fixture.detectChanges();
    await flushAsync();
    fixture.detectChanges();

    const fileButton: HTMLButtonElement = fixture.nativeElement.querySelector('button[title="Copy file name"]');
    const locationButton: HTMLButtonElement = fixture.nativeElement.querySelector('button[title="Copy location"]');
    locationButton.click();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledWith('/fake/vault/Projects');
    expect(locationButton.textContent?.trim()).toBe('Copied!');
    expect(fileButton.textContent?.trim()).toBe('todo.mntl');
  });

  it('offers to create a profile when a plaintext note has none to encrypt into', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, plainNote());
    fixture.detectChanges();

    const rows = Array.from(fixture.nativeElement.querySelectorAll('app-menu-item'));
    expect(rows.map((r: Element) => r.textContent?.trim())).toEqual(['Encrypt…']);
  });

  it('shows a locked status and a disabled action for a note naming an unknown profile', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, encryptedNote());
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Locked');
    expect(text).toContain('not in this vault');
    expect(text).toContain('Encrypted (.mntl.enc)');

    const button = fixture.nativeElement.querySelector('app-menu-item button');
    expect(button.disabled).toBe(true);
  });

  it('offers a profile picker for an unlocked encrypted note, and does not offer one with nowhere else to move', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, encryptedNote('secret.mntl.enc', 'personal'));
    fixture.detectChanges();

    // No other profiles registered yet, so there's nothing to move to.
    expect(fixture.nativeElement.querySelector('select')).toBeNull();

    TestBed.inject(CredentialsState).profiles.set([
      { id: 'personal', displayName: 'Personal', unlocked: true },
      { id: 'work', displayName: 'Work', unlocked: true },
    ]);
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    expect(select).toBeTruthy();
    expect(Array.from(select.options).map((o) => o.textContent?.trim())).toEqual([
      'Choose a profile…',
      'Work',
    ]);
  });

  it('moves the note and closes the panel when a profile is picked', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, encryptedNote('secret.mntl.enc', 'personal'));
    // CredentialsState resets `profiles` to [] the first time its constructor
    // effect flushes (no vault root is set in this test), so the profiles
    // used by the assertion have to be set after that first flush, not before.
    fixture.detectChanges();
    TestBed.inject(CredentialsState).profiles.set([
      { id: 'personal', displayName: 'Personal', unlocked: true },
      { id: 'work', displayName: 'Work', unlocked: true },
    ]);
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    select.value = 'work';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(state.target()).toBeNull();
  });

  it('offers a single "Encrypt…" row rather than a profile picker for a plaintext note, even once profiles exist', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, plainNote());
    fixture.detectChanges();
    TestBed.inject(CredentialsState).profiles.set([
      { id: 'personal', displayName: 'Personal', unlocked: true },
      { id: 'work', displayName: 'Work', unlocked: false },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('select')).toBeNull();
    const rows = Array.from(fixture.nativeElement.querySelectorAll('app-menu-item'));
    expect(rows.map((r: Element) => r.textContent?.trim())).toEqual(['Encrypt…']);
  });

  it('opens the encryption modal for the note and closes the panel when "Encrypt…" is picked', () => {
    const note = plainNote();
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, note);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('app-menu-item button').click();
    fixture.detectChanges();

    expect(TestBed.inject(NoteEncryptionModalState).note()).toEqual(note);
    expect(state.target()).toBeNull();
  });

  it('runs the selected action and closes the panel', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, plainNote());
    fixture.detectChanges();

    fixture.nativeElement.querySelector('app-menu-item button').click();
    fixture.detectChanges();

    expect(state.target()).toBeNull();
    expect(fixture.nativeElement.querySelector('app-menu-surface')).toBeNull();
  });

  it('closes when Escape is pressed', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, plainNote());
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(state.target()).toBeNull();
  });

  it('closes on a pointerdown outside the panel and its anchor', () => {
    const fixture = TestBed.createComponent(EncryptionPanel);
    state.toggle(anchor, plainNote());
    fixture.detectChanges();

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    fixture.detectChanges();

    expect(state.target()).toBeNull();
  });
});
