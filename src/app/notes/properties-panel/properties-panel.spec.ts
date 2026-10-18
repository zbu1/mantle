import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { PropertiesPanel } from './properties-panel';
import { NotePropertiesState } from '../note-properties-state';
import { NotesState } from '../notes-state';
import { NoteProperty } from '../properties';
import { VaultState } from '../vault-state';
import { flushAsync, installMockVaultInvoke } from '../../../testing/mock-vault';

describe('PropertiesPanel', () => {
  async function setup(noteId: string, properties: NoteProperty[] = [], unreadable = false) {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [PropertiesPanel],
      providers: [provideZonelessChangeDetection()],
    });
    const invoke = installMockVaultInvoke();
    if (unreadable) {
      // As `read_note` reports a Markdown file whose frontmatter can't be read.
      const serve = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        const result = await serve(command, args);
        return command === 'read_note' ? { ...result, properties: null } : result;
      });
    }
    const vaultState = TestBed.inject(VaultState);
    vaultState.rootPath.set('/fake/vault');
    await vaultState.refresh();
    const notesState = TestBed.inject(NotesState);
    notesState.ensureLoaded(noteId);
    await flushAsync();
    if (properties.length) notesState.updateProperties(noteId, properties);

    const fixture = TestBed.createComponent(PropertiesPanel);
    fixture.componentRef.setInput('noteId', noteId);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, notesState, root: fixture.nativeElement as HTMLElement };
  }

  async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
  }

  it('is hidden for a note with no tags or properties', async () => {
    const { root } = await setup('todo.mntl');
    expect(root.querySelector('[data-note-properties]')).toBeNull();
  });

  it('shows each property as its type, after the tags', async () => {
    const { root } = await setup('daily-standup.mntl', [
      { key: 'due', value: '2026-10-17' },
      { key: 'done', value: true },
      { key: 'nested', value: { a: 1 } },
    ]);
    expect(root.querySelector('[aria-label="Tags"]')).toBeTruthy();
    expect(root.querySelector<HTMLInputElement>('[data-property="due"] input')!.type).toBe('date');
    expect(root.querySelector<HTMLInputElement>('[data-property="done"] input')!.checked).toBe(true);
    expect(root.querySelector('[data-property="nested"] code')!.textContent).toContain('{"a":1}');
  });

  it('edits a value in place', async () => {
    const { root, notesState, fixture } = await setup('daily-standup.mntl', [{ key: 'status', value: 'draft' }]);
    const field = root.querySelector<HTMLInputElement>('[data-property="status"] input')!;
    field.value = 'done';
    field.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(notesState.getNote('daily-standup.mntl')?.properties).toEqual([{ key: 'status', value: 'done' }]);
  });

  it('adds a property when asked to, typed by its vault-wide type', async () => {
    const { root, notesState, fixture } = await setup('todo.mntl');
    TestBed.inject(NotePropertiesState).requestAdd('todo.mntl', 'property');
    await settle(fixture);

    const name = root.querySelector<HTMLInputElement>('input[aria-label="New property name"]')!;
    name.value = 'rating';
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(fixture);

    expect(notesState.getNote('todo.mntl')?.properties).toEqual([{ key: 'rating', value: null }]);
    expect(root.querySelector('[data-property="rating"]')).toBeTruthy();
  });

  it("says so, and offers nothing to edit, when a Markdown file's frontmatter can't be read", async () => {
    const { root } = await setup('daily-standup.mntl', [], true);

    expect(root.querySelector('[role="note"]')?.textContent).toContain("isn't valid YAML");
    expect([...root.querySelectorAll('button')].some((b) => b.textContent?.includes('Add property'))).toBe(false);
  });
});
