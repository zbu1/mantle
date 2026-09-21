import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SettingsModal } from './settings-modal';
import { SettingsModalState } from './settings-modal-state';
import { CredentialProfile, CredentialsState } from '../../notes/credentials-state';
import { installMockVaultInvoke } from '../../../testing/mock-vault';

function profile(id: string, displayName: string, unlocked = false): CredentialProfile {
  return { id, displayName, unlocked, kdf: { mCost: 8, tCost: 1, pCost: 1 } };
}

describe('SettingsModal sidebar', () => {
  let fixture: ComponentFixture<SettingsModal>;
  let root: HTMLElement;
  let state: SettingsModalState;
  let credentials: CredentialsState;

  const nav = () => root.querySelector('nav') as HTMLElement;
  const headings = () => Array.from(nav().querySelectorAll('h3')).map((h) => h.textContent?.trim());
  const groupItems = (heading: string) => {
    const h = Array.from(nav().querySelectorAll('h3')).find((el) => el.textContent?.trim() === heading);
    return Array.from(nav().querySelectorAll(`[aria-labelledby="${h?.id}"] button`)) as HTMLButtonElement[];
  };
  const panel = () => root.querySelector('app-profile-settings-panel');

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    // VaultState persists to localStorage, which would leak between tests.
    localStorage.clear();
    installMockVaultInvoke();
    TestBed.configureTestingModule({ imports: [SettingsModal], providers: [provideZonelessChangeDetection()] });
    fixture = TestBed.createComponent(SettingsModal);
    root = fixture.nativeElement;
    state = TestBed.inject(SettingsModalState);
    credentials = TestBed.inject(CredentialsState);
    // Let CredentialsState's initial "no vault open" effect run before seeding profiles.
    await settle();
    credentials.profiles.set([profile('work', 'Work', true), profile('journal', 'Journal')]);
    state.open();
    await settle();
  });

  it('groups the existing settings under an "Options" header, then the profiles under "Credential Profiles"', () => {
    expect(headings()).toEqual(['Options', 'Credential Profiles']);
    expect(groupItems('Options').map((b) => b.textContent?.trim())).toEqual([
      'General',
      'Appearance',
      'Editor',
      'Sidebar & Navigation',
      'Files & Vault',
      'Encryption & Privacy',
      'Keyboard Shortcuts',
      'Advanced',
      'About',
    ]);
  });

  it('lists one item per credential profile, with its lock state', () => {
    const items = groupItems('Credential Profiles');
    expect(items.map((b) => b.textContent?.trim())).toEqual(['Work', 'Journal']);
    expect(items[0].querySelector('[title="Unlocked"]')).not.toBeNull();
    expect(items[1].querySelector('[title="Locked"]')).not.toBeNull();
  });

  it('keeps the header when the vault has no profiles', async () => {
    credentials.profiles.set([]);
    await settle();
    expect(headings()).toContain('Credential Profiles');
    expect(groupItems('Credential Profiles')).toHaveLength(0);
  });

  it('shows a profile in the content pane when its item is clicked, and highlights only that item', async () => {
    groupItems('Credential Profiles')[1].click();
    await settle();

    expect(state.profileId()).toBe('journal');
    expect(panel()).not.toBeNull();
    expect(panel()?.textContent).toContain('Journal');
    expect(panel()?.textContent).toContain('Danger Zone');
    expect(groupItems('Credential Profiles')[1].className).toContain('bg-accent');
    expect(groupItems('Credential Profiles')[0].className).not.toContain('bg-accent');
    for (const category of groupItems('Options')) expect(category.className).not.toContain('bg-accent');
  });

  it('switches back to a category when one is clicked', async () => {
    groupItems('Credential Profiles')[0].click();
    await settle();
    groupItems('Options')[1].click();
    await settle();

    expect(panel()).toBeNull();
    expect(state.profileId()).toBeNull();
    expect(groupItems('Options')[1].className).toContain('bg-accent');
    expect(root.textContent).toContain('Accent Color');
  });

  it('opens on a profile when asked to (as the sidebar profile menu does)', async () => {
    state.close();
    await settle();
    state.openProfile('work');
    await settle();

    expect(panel()?.textContent).toContain('Work');
  });

  it('the Encryption & Privacy profile gear selects that profile instead of opening another window', async () => {
    state.selectCategory('encryption');
    await settle();

    root.querySelector<HTMLButtonElement>('button[title="Profile Settings"]')?.click();
    await settle();

    expect(state.isOpen()).toBe(true);
    expect(state.profileId()).toBe('work');
    expect(panel()).not.toBeNull();
  });

  it('falls back to Encryption & Privacy when the selected profile disappears', async () => {
    state.selectProfile('journal');
    await settle();
    expect(panel()).not.toBeNull();

    credentials.profiles.set([profile('work', 'Work', true)]);
    await settle();

    expect(state.profileId()).toBeNull();
    expect(state.category()).toBe('encryption');
    expect(panel()).toBeNull();
    expect(groupItems('Options')[5].className).toContain('bg-accent');
  });
});
