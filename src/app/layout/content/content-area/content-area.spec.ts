import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ContentArea } from './content-area';
import { TabsState } from '../../../notes/tabs-state';
import { VaultState } from '../../../notes/vault-state';
import { FIXTURE_NOTES, flushAsync, installMockVaultInvoke } from '../../../../testing/mock-vault';
import { flattenVaultNotes } from '../../../notes/vault-tree.model';

describe('ContentArea', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [ContentArea],
      providers: [provideZonelessChangeDetection()],
    });
    installMockVaultInvoke();
    TestBed.inject(VaultState).rootPath.set('/fake/vault');
  });

  it('shows the empty state when no tabs are open', () => {
    const fixture = TestBed.createComponent(ContentArea);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No notes open');
  });

  it('renders the active note title and content', async () => {
    const fixture = TestBed.createComponent(ContentArea);
    const tabsState = TestBed.inject(TabsState);
    const note = FIXTURE_NOTES[0];
    tabsState.openNote({ id: note.id, title: note.title });
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain(note.title);
    expect(fixture.nativeElement.querySelector('.ProseMirror')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain(note.content);
  });

  it('propagates the title to the tab and vault explorer as soon as it is typed, before blur', async () => {
    const fixture = TestBed.createComponent(ContentArea);
    const tabsState = TestBed.inject(TabsState);
    const vaultState = TestBed.inject(VaultState);
    await vaultState.refresh();
    const note = FIXTURE_NOTES[0];
    tabsState.openNote({ id: note.id, title: note.title });
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    const input: HTMLTextAreaElement = fixture.nativeElement.querySelector('[data-note-title]');
    input.value = 'renamed-note';
    input.dispatchEvent(new Event('input'));

    // Title and sidebar entry reflect immediately, without needing blur or the debounced disk rename to resolve.
    expect(tabsState.tabs()[0].title).toBe('renamed-note');
    expect(tabsState.tabs()[0].noteId).toBe(note.id);
    expect(flattenVaultNotes(vaultState.tree()!).get(note.id)).toBe('renamed-note');
  });

  it('renames the note on disk and in the vault explorer when the title is edited', async () => {
    const fixture = TestBed.createComponent(ContentArea);
    const tabsState = TestBed.inject(TabsState);
    const vaultState = TestBed.inject(VaultState);
    await vaultState.refresh();
    const note = FIXTURE_NOTES[0];
    tabsState.openNote({ id: note.id, title: note.title });
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    const input: HTMLTextAreaElement = fixture.nativeElement.querySelector('[data-note-title]');
    input.value = 'renamed-note';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(tabsState.tabs()[0].title).toBe('renamed-note');
    expect(tabsState.tabs()[0].noteId).toBe('renamed-note');
    const notes = flattenVaultNotes(vaultState.tree()!);
    expect(notes.get('renamed-note')).toBe('renamed-note');
    expect(notes.has(note.id)).toBe(false);
  });
});
