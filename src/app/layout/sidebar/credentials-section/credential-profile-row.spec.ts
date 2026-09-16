import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../../../testing/tauri-mock';
import { CredentialsState } from '../../../notes/credentials-state';
import { VaultNoteNode } from '../../../notes/vault-tree.model';
import { CredentialProfileRow } from './credential-profile-row';

function note(relPath: string, profile: string): VaultNoteNode {
  return { type: 'note', name: relPath.replace('.mntl.enc', ''), relPath, encrypted: true, profile };
}

describe('CredentialProfileRow', () => {
  let fixture: ComponentFixture<CredentialProfileRow>;
  let credentials: CredentialsState;

  beforeEach(async () => {
    localStorage.clear();
    const mock = installTauriMock();
    mock.respondWith('list_credential_profiles', []);

    TestBed.configureTestingModule({
      imports: [CredentialProfileRow],
      providers: [provideZonelessChangeDetection()],
    });

    credentials = TestBed.inject(CredentialsState);
    fixture = TestBed.createComponent(CredentialProfileRow);
    fixture.componentRef.setInput('profileId', 'my-diary');
    fixture.componentRef.setInput('displayName', 'My Diary');
    fixture.componentRef.setInput('notes', [note('dream.mntl.enc', 'my-diary'), note('therapy.mntl.enc', 'my-diary')]);
    fixture.componentRef.setInput('unlocked', false);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  function rowButton(): HTMLElement {
    return fixture.nativeElement.querySelector('[role="button"]')!;
  }

  /** The trailing lock/unlock button — the only one carrying an aria-label. */
  function lockButton(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('button[aria-label]');
  }

  it('shows the display name and note count', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('My Diary');
    expect(text).toContain('2');
  });

  it('starts collapsed and expands when the row is clicked', async () => {
    const content = fixture.nativeElement.querySelector('.grid') as HTMLElement;
    expect(content.style.gridTemplateRows).toBe('0fr');

    rowButton().click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(content.style.gridTemplateRows).toBe('1fr');
    expect(fixture.nativeElement.textContent).toContain('dream');
    expect(fixture.nativeElement.textContent).toContain('therapy');
  });

  it('expanding a locked profile never prompts for a password', async () => {
    // Looking at which notes a profile holds shouldn't open a modal — that's
    // why the lock action is a separate trailing button.
    const promptUnlock = jest.spyOn(credentials, 'promptUnlock');

    rowButton().click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(promptUnlock).not.toHaveBeenCalled();
  });

  it('the trailing button unlocks a locked profile without expanding the row', async () => {
    const promptUnlock = jest.spyOn(credentials, 'promptUnlock').mockResolvedValue(true);

    lockButton()!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(promptUnlock).toHaveBeenCalledWith('my-diary');
    const content = fixture.nativeElement.querySelector('.grid') as HTMLElement;
    expect(content.style.gridTemplateRows).toBe('0fr');
  });

  it('the trailing button arms a confirmation before locking an unlocked profile', async () => {
    const lock = jest.spyOn(credentials, 'lock').mockResolvedValue();
    fixture.componentRef.setInput('unlocked', true);
    fixture.detectChanges();
    await fixture.whenStable();

    lockButton()!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(lock).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Lock profile?');

    lockButton()!.click();
    await fixture.whenStable();

    expect(lock).toHaveBeenCalledWith('my-diary');
  });

  it('cancelling the lock confirmation leaves the profile unlocked', async () => {
    const lock = jest.spyOn(credentials, 'lock').mockResolvedValue();
    fixture.componentRef.setInput('unlocked', true);
    fixture.detectChanges();
    await fixture.whenStable();

    lockButton()!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const cancelButton = fixture.nativeElement.querySelector('button[aria-label="Cancel locking"]') as HTMLButtonElement;
    cancelButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).not.toContain('Lock profile?');
    expect(lock).not.toHaveBeenCalled();
  });

  it('offers no lock button for an unknown profile', async () => {
    fixture.componentRef.setInput('unknown', true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(lockButton()).toBeNull();
  });

  it('the more-actions menu locks/unlocks immediately, without the confirm step', async () => {
    const promptUnlock = jest.spyOn(credentials, 'promptUnlock').mockResolvedValue(true);

    const menuTrigger = fixture.nativeElement.querySelector('button[aria-label="More actions for My Diary"]') as HTMLButtonElement;
    menuTrigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const lockItem = Array.from(fixture.nativeElement.querySelectorAll('button[role="menuitem"]')).find(
      (el) => (el as HTMLElement).textContent?.trim() === 'Unlock',
    ) as HTMLButtonElement;
    lockItem.click();
    await fixture.whenStable();

    expect(promptUnlock).toHaveBeenCalledWith('my-diary');
  });

  it('explains why an unknown profile cannot be unlocked', async () => {
    fixture.componentRef.setInput('unknown', true);
    fixture.componentRef.setInput('profileId', 'archive');
    fixture.detectChanges();
    await fixture.whenStable();

    rowButton().click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain("isn't in this vault");
  });
});
