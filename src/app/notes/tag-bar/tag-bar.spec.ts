import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TagBar } from './tag-bar';
import { NotesState } from '../notes-state';
import { TagsState } from '../tags-state';
import { VaultState } from '../vault-state';
import { flushAsync, installMockVaultInvoke } from '../../../testing/mock-vault';

describe('TagBar', () => {
  async function setup(noteId = 'daily-standup.mntl') {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [TagBar],
      providers: [provideZonelessChangeDetection()],
    });
    installMockVaultInvoke();
    const vaultState = TestBed.inject(VaultState);
    vaultState.rootPath.set('/fake/vault');
    await vaultState.refresh();
    TestBed.inject(NotesState).ensureLoaded(noteId);
    await flushAsync();

    const fixture = TestBed.createComponent(TagBar);
    fixture.componentRef.setInput('noteId', noteId);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  function chipLabels(root: HTMLElement): string[] {
    return [...root.querySelectorAll('[role="listitem"] button[title]')].map((b) => b.textContent!.trim());
  }

  async function openInput(fixture: Awaited<ReturnType<typeof setup>>): Promise<HTMLInputElement> {
    const root: HTMLElement = fixture.nativeElement;
    const add = root.querySelector<HTMLButtonElement>('button[aria-label="Add tag"]')!;
    add.click();
    fixture.detectChanges();
    await fixture.whenStable();
    return root.querySelector('input')!;
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  function press(input: HTMLInputElement, key: string): void {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
  }

  it("renders the note's tags as chips", async () => {
    const fixture = await setup();
    expect(chipLabels(fixture.nativeElement)).toEqual(['#work', '#urgent']);
  });

  it('adds a typed tag on Enter, dropping characters a tag cannot contain', async () => {
    const fixture = await setup();
    const input = await openInput(fixture);

    type(input, '#new idea!');
    expect(input.value).toBe('newidea');
    press(input, 'Enter');
    fixture.detectChanges();

    expect(TestBed.inject(NotesState).getNote('daily-standup.mntl')?.tags).toEqual(['work', 'urgent', 'newidea']);
  });

  it("reuses the vault's spelling of an existing tag", async () => {
    const fixture = await setup('todo.mntl');
    const input = await openInput(fixture);

    type(input, 'WORK');
    press(input, 'Enter');

    expect(TestBed.inject(NotesState).getNote('todo.mntl')?.tags).toEqual(['work']);
  });

  it('offers to create a new tag, and suggests existing ones not already on the note', async () => {
    const fixture = await setup('todo.mntl');
    const input = await openInput(fixture);

    type(input, 'ur');
    fixture.detectChanges();
    const rows = [...fixture.nativeElement.querySelectorAll('app-menu-item')].map((r: Element) => r.textContent!.trim());

    expect(rows[0]).toBe('Create #ur');
    expect(rows[1]).toContain('urgent');
  });

  it('rejects an all-digit tag with the naming rules', async () => {
    const fixture = await setup();
    const input = await openInput(fixture);

    type(input, '2024');
    press(input, 'Enter');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('at least one letter');
    expect(TestBed.inject(NotesState).getNote('daily-standup.mntl')?.tags).toEqual(['work', 'urgent']);
  });

  it('removes the last tag on Backspace in an empty input', async () => {
    const fixture = await setup();
    const input = await openInput(fixture);

    press(input, 'Backspace');

    expect(TestBed.inject(NotesState).getNote('daily-standup.mntl')?.tags).toEqual(['work']);
  });

  it('removes a tag with its × button and updates the sidebar index at once', async () => {
    const fixture = await setup();
    const remove: HTMLButtonElement = fixture.nativeElement.querySelector('[aria-label="Remove tag urgent"]');
    remove.click();

    expect(TestBed.inject(NotesState).getNote('daily-standup.mntl')?.tags).toEqual(['work']);
    expect(TestBed.inject(TagsState).names()).toEqual(['work']);
  });

  it('asks the sidebar to reveal a tag when its chip is clicked', async () => {
    const fixture = await setup();
    const chip: HTMLButtonElement = fixture.nativeElement.querySelector('[role="listitem"] button[title]');
    chip.click();

    expect(TestBed.inject(TagsState).revealRequest()).toEqual({ key: 'work' });
  });
});
