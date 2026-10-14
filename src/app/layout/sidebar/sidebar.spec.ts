import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../../testing/tauri-mock';
import { TabsState } from '../../notes/tabs-state';
import { VaultSelectionState } from '../../notes/vault-selection-state';
import { NewEncryptedNoteState } from '../../notes/new-encrypted-note/new-encrypted-note-state';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { VaultRootState } from '../../notes/vault-root-state';
import { VaultState } from '../../notes/vault-state';
import { VaultFolderNode, VaultNoteNode } from '../../notes/vault-tree.model';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
import { TagsState } from '../../notes/tags-state';
import { Sidebar } from './sidebar';
import { SidebarState } from './sidebar-state';

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    TestBed.configureTestingModule({
      imports: [Sidebar],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(Sidebar);
    expect(fixture.componentInstance).toBeTruthy();
  });

  /** Marks `/vault` as the open vault (without scanning it) before the sidebar is created. */
  function openVault(): void {
    installTauriMock();
    TestBed.inject(VaultRootState).path.set('/vault');
  }

  it('reflects the collapsed state from SidebarState', () => {
    openVault();
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-sidebar-section')).toBeTruthy();

    state.toggleCollapsed();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-sidebar-section')).toBeFalsy();
  });

  it('removes hidden sections from the sidebar, but always shows the vault tree', () => {
    openVault();
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const ids = () =>
      [...fixture.nativeElement.querySelectorAll('app-sidebar-section')].map((el: HTMLElement) => el.getAttribute('id'));
    expect(ids()).toEqual(['favorites', 'recent', 'tags', 'credentials']);

    for (const section of ['favorites', 'recent', 'tags', 'credentials'] as const) state.toggleSectionVisibility(section);
    fixture.detectChanges();

    expect(ids()).toEqual([]);
    expect(fixture.nativeElement.querySelector('[data-vault-tree]')).toBeTruthy();
  });

  function resizeHandle(fixture: ComponentFixture<Sidebar>): HTMLElement {
    return fixture.nativeElement.querySelector('[class*="cursor-col-resize"]');
  }

  // JSDOM has no PointerEvent constructor — build a MouseEvent and tack on
  // the pointer-specific fields the component reads (clientX, pointerId).
  function pointerEvent(type: string, clientX: number): Event {
    const event = new MouseEvent(type, { clientX });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
  }

  it('collapses when the resize handle is dragged past the collapse threshold', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    handle.dispatchEvent(pointerEvent('pointermove', 100));

    expect(state.collapsed()).toBe(true);
  });

  it('does not collapse when dragged narrower but still above the collapse threshold', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    handle.dispatchEvent(pointerEvent('pointermove', 470));

    expect(state.collapsed()).toBe(false);
    expect(state.width()).toBe(210);
  });

  it('re-expands when the resize handle is dragged out from a collapsed state', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    state.setCollapsed(true);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 0));
    handle.dispatchEvent(pointerEvent('pointermove', 220));

    expect(state.collapsed()).toBe(false);
    expect(state.width()).toBe(220);
  });

  it('resets drag state when pointer capture is lost mid-drag', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    expect(state.resizing()).toBe(true);

    handle.dispatchEvent(new Event('lostpointercapture'));
    expect(state.resizing()).toBe(false);

    // A stray pointermove after capture loss should not resume the drag.
    handle.dispatchEvent(pointerEvent('pointermove', 100));
    expect(state.collapsed()).toBe(false);
  });

  it('resets drag state on window blur (mouse released outside the window)', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const handle = resizeHandle(fixture);

    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    expect(state.resizing()).toBe(true);

    // Neither pointerup nor lostpointercapture fires when the button is
    // released outside the OS window — only the window blur.
    window.dispatchEvent(new Event('blur'));
    expect(state.resizing()).toBe(false);

    // A fresh drag should work normally afterwards.
    handle.dispatchEvent(pointerEvent('pointerdown', 500));
    handle.dispatchEvent(pointerEvent('pointermove', 470));
    expect(state.width()).toBe(210);
  });

  describe('Recent Files section', () => {
    const HOUR = 3_600_000;

    function note(relPath: string): VaultNoteNode {
      return { type: 'note', name: relPath.replace(/\.mntl$/, ''), relPath, encrypted: false, profile: null, tags: [] };
    }

    /** Opens `/vault` containing `inTree`, whose metadata lists `recent` (most recent first, an hour apart). */
    async function setup(inTree: string[], recent: string[]) {
      const mock = installTauriMock();
      const root: VaultFolderNode = { type: 'folder', name: 'vault', relPath: '', children: inTree.map(note) };
      const now = Date.now();
      mock.respondWith('scan_vault', root);
      mock.respondWith('list_credential_profiles', []);
      mock.respondWith('load_vault_meta', {
        version: 1,
        favorites: [],
        order: {},
        collapsedFolders: [],
        recentNotes: recent.map((relPath, i) => ({ relPath, openedAt: now - (i + 1) * HOUR })),
      });

      const fixture = TestBed.createComponent(Sidebar);
      const vaultState = TestBed.inject(VaultState);
      vaultState.rootPath.set('/vault');
      TestBed.tick();
      await vaultState.refresh();
      fixture.detectChanges();
      return fixture;
    }

    function rows(fixture: ComponentFixture<Sidebar>): HTMLElement[] {
      return [...fixture.nativeElement.querySelectorAll('app-sidebar-section[id="recent"] app-sidebar-item-button')];
    }

    function sectionText(fixture: ComponentFixture<Sidebar>): string {
      return fixture.nativeElement.querySelector('app-sidebar-section[id="recent"]').textContent;
    }

    function clickButton(fixture: ComponentFixture<Sidebar>, label: RegExp): void {
      const buttons: HTMLButtonElement[] = [
        ...fixture.nativeElement.querySelectorAll('app-sidebar-section[id="recent"] > button, app-sidebar-section[id="recent"] button'),
      ];
      buttons.find((button) => label.test(button.textContent ?? ''))?.click();
      fixture.detectChanges();
    }

    it('says so when nothing has been opened yet', async () => {
      const fixture = await setup(['a.mntl'], []);

      expect(rows(fixture)).toHaveLength(0);
      expect(sectionText(fixture)).toContain('No recent notes yet.');
    });

    it('lists real recent notes, most recent first, with how long ago each was opened', async () => {
      const fixture = await setup(['a.mntl', 'b.mntl', 'c.mntl'], ['c.mntl', 'a.mntl']);

      const labels = rows(fixture).map((row) => row.textContent?.replace(/\s+/g, ' ').trim());
      // Title and age are separate flex children, so there is no text between them.
      expect(labels).toEqual(['c1h ago', 'a2h ago']);
    });

    it('hides recents that no longer exist in the vault', async () => {
      const fixture = await setup(['a.mntl'], ['gone.mntl', 'a.mntl']);

      expect(rows(fixture)).toHaveLength(1);
      expect(rows(fixture)[0].textContent).toContain('a');
    });

    it('shows five recents and expands to all of them on request', async () => {
      const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `${name}.mntl`);
      const fixture = await setup(all, all);

      expect(rows(fixture)).toHaveLength(5);
      expect(sectionText(fixture)).toContain('Show 2 more');

      clickButton(fixture, /Show 2 more/);
      expect(rows(fixture)).toHaveLength(7);
      expect(sectionText(fixture)).toContain('Show less');

      clickButton(fixture, /Show less/);
      expect(rows(fixture)).toHaveLength(5);
    });

    it('offers no expander when everything already fits', async () => {
      const fixture = await setup(['a.mntl', 'b.mntl'], ['a.mntl', 'b.mntl']);

      expect(sectionText(fixture)).not.toContain('Show');
    });

    it('opens the note when a row is clicked', async () => {
      const fixture = await setup(['a.mntl', 'b.mntl'], ['b.mntl', 'a.mntl']);

      rows(fixture)[1].querySelector('button')!.click();

      const tabs = TestBed.inject(TabsState);
      expect(tabs.tabs().map((tab) => tab.noteId)).toEqual(['a.mntl']);
    });

    it('removes a note from recents through its context menu', async () => {
      const fixture = await setup(['a.mntl', 'b.mntl'], ['b.mntl', 'a.mntl']);

      rows(fixture)[0].querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const remove = TestBed.inject(ContextMenuState)
        .menu()
        ?.items.find((item) => item.kind === 'item' && item.label === 'Remove from Recents');
      expect(remove).toBeTruthy();
      if (remove?.kind === 'item') remove.action();
      fixture.detectChanges();

      expect(TestBed.inject(VaultMetaState).recentNotes().map((entry) => entry.relPath)).toEqual(['a.mntl']);
      expect(rows(fixture)).toHaveLength(1);
    });
  });

  describe('Favorites section', () => {
    function note(relPath: string): VaultNoteNode {
      const name = relPath.split('/').pop()!.replace(/\.mntl(\.enc)?$/, '');
      const encrypted = relPath.endsWith('.enc');
      return { type: 'note', name, relPath, encrypted, profile: encrypted ? 'p' : null, tags: encrypted ? null : [] };
    }

    /** Opens `/vault` containing `inTree` (flat, folders implied by relPath), whose metadata lists `favorites`. */
    async function setup(inTree: string[], favorites: string[]) {
      const mock = installTauriMock();
      const root: VaultFolderNode = { type: 'folder', name: 'vault', relPath: '', children: inTree.map(note) };
      mock.respondWith('scan_vault', root);
      mock.respondWith('list_credential_profiles', []);
      mock.respondWith('load_vault_meta', { version: 1, favorites, order: {}, collapsedFolders: [], recentNotes: [] });

      const fixture = TestBed.createComponent(Sidebar);
      const vaultState = TestBed.inject(VaultState);
      vaultState.rootPath.set('/vault');
      TestBed.tick();
      await vaultState.refresh();
      fixture.detectChanges();
      return fixture;
    }

    function rowTexts(fixture: ComponentFixture<Sidebar>): string[] {
      return [...fixture.nativeElement.querySelectorAll('app-sidebar-section[id="favorites"] app-sidebar-item-button')].map(
        (row) => (row as HTMLElement).textContent!.replace(/\s+/g, ' ').trim(),
      );
    }

    it('lists favorites in stored order, hiding ones missing from the vault', async () => {
      const fixture = await setup(['a.mntl', 'b.mntl'], ['b.mntl', 'gone.mntl', 'a.mntl']);

      expect(rowTexts(fixture)).toEqual(['b', 'a']);
    });

    it('hides the favorites of locked encrypted notes', async () => {
      const fixture = await setup(['a.mntl', 'secret.mntl.enc'], ['secret.mntl.enc', 'a.mntl']);

      expect(rowTexts(fixture)).toEqual(['a']);
    });

    it('shows the parent folder only for favorites that share a name', async () => {
      const fixture = await setup(['todo.mntl', 'Work/todo.mntl', 'ideas.mntl'], ['todo.mntl', 'Work/todo.mntl', 'ideas.mntl']);

      expect(rowTexts(fixture)).toEqual(['todo/', 'todoWork', 'ideas']);
    });

    it('shows an empty state with no favorites', async () => {
      const fixture = await setup(['a.mntl'], []);

      expect(fixture.nativeElement.querySelector('app-sidebar-section[id="favorites"]').textContent).toContain(
        'No favorites yet.',
      );
    });

    it('removes a favorite from its context menu', async () => {
      const fixture = await setup(['a.mntl', 'b.mntl'], ['a.mntl', 'b.mntl']);
      const row = fixture.nativeElement.querySelector('app-sidebar-section[id="favorites"] app-sidebar-item-button button');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const item = TestBed.inject(ContextMenuState)
        .menu()!
        .items.find((i) => i.kind === 'item' && i.label === 'Remove from Favorites');

      if (item?.kind === 'item') item.action();
      fixture.detectChanges();

      expect(rowTexts(fixture)).toEqual(['b']);
    });
  });

  describe('folder context menu', () => {
    async function openFolderMenu() {
      const mock = installTauriMock();
      const root: VaultFolderNode = {
        type: 'folder',
        name: 'vault',
        relPath: '',
        children: [{ type: 'folder', name: 'Work', relPath: 'Work', children: [] }],
      };
      mock.respondWith('scan_vault', root);
      mock.respondWith('list_credential_profiles', []);
      mock.respondWith('load_vault_meta', { version: 1, favorites: [], order: {}, collapsedFolders: [], recentNotes: [] });

      const fixture = TestBed.createComponent(Sidebar);
      const vaultState = TestBed.inject(VaultState);
      vaultState.rootPath.set('/vault');
      TestBed.tick();
      await vaultState.refresh();
      fixture.detectChanges();

      const folderRow = [...fixture.nativeElement.querySelectorAll('app-vault-tree-node [role="button"]')].find((b) =>
        (b as HTMLElement).textContent?.includes('Work'),
      ) as HTMLElement;
      folderRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return TestBed.inject(ContextMenuState).menu()!.items;
    }

    it('offers New Note, New Encrypted Note and New Folder together', async () => {
      const items = await openFolderMenu();

      const labels = items.flatMap((item) => (item.kind === 'item' ? [item.label] : []));
      expect(labels.slice(0, 3)).toEqual(['New Note', 'New Encrypted Note', 'New Folder']);
    });

    it('opens the New Encrypted Note modal for that folder', async () => {
      const items = await openFolderMenu();
      const item = items.find((i) => i.kind === 'item' && i.label === 'New Encrypted Note');

      if (item?.kind === 'item') item.action();

      expect(TestBed.inject(NewEncryptedNoteState).request()).toEqual({ relDir: 'Work', profileId: null });
    });
  });

  describe('vault background context menu', () => {
    async function openVaultMenu() {
      const mock = installTauriMock();
      const root: VaultFolderNode = {
        type: 'folder',
        name: 'vault',
        relPath: '',
        children: [{ type: 'folder', name: 'Work', relPath: 'Work', children: [] }],
      };
      mock.respondWith('scan_vault', root);
      mock.respondWith('list_credential_profiles', []);
      mock.respondWith('load_vault_meta', { version: 1, favorites: [], order: {}, collapsedFolders: [], recentNotes: [] });

      const fixture = TestBed.createComponent(Sidebar);
      const vaultState = TestBed.inject(VaultState);
      vaultState.rootPath.set('/vault');
      TestBed.tick();
      await vaultState.refresh();
      fixture.detectChanges();

      const tree = fixture.nativeElement.querySelector('[data-vault-tree]') as HTMLElement;
      tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return TestBed.inject(ContextMenuState).menu()!.items;
    }

    it('offers New Note, New Encrypted Note and New Folder at the vault root', async () => {
      const items = await openVaultMenu();

      const labels = items.flatMap((item) => (item.kind === 'item' ? [item.label] : []));
      expect(labels.slice(0, 3)).toEqual(['New Note', 'New Encrypted Note', 'New Folder']);
    });

    it('opens the New Encrypted Note modal for the vault root', async () => {
      const items = await openVaultMenu();
      const item = items.find((i) => i.kind === 'item' && i.label === 'New Encrypted Note');

      if (item?.kind === 'item') item.action();

      expect(TestBed.inject(NewEncryptedNoteState).request()).toEqual({ relDir: '', profileId: null });
    });
  });

  describe('Vault tree', () => {
    function note(relPath: string): VaultNoteNode {
      const name = relPath.split('/').pop()!.replace(/\.mntl$/, '');
      return { type: 'note', name, relPath, encrypted: false, profile: null, tags: [] };
    }

    async function setup() {
      const mock = installTauriMock();
      mock.respondWith('scan_vault', {
        type: 'folder',
        name: 'vault',
        relPath: '',
        children: [
          { type: 'folder', name: 'Work', relPath: 'Work', children: [note('Work/Roadmap.mntl'), note('Work/standup.mntl')] },
          note('todo.mntl'),
        ],
      });
      mock.respondWith('list_credential_profiles', []);
      mock.respondWith('load_vault_meta', { version: 1, favorites: [], order: {}, collapsedFolders: [], recentNotes: [] });
      const fixture = TestBed.createComponent(Sidebar);
      const vaultState = TestBed.inject(VaultState);
      vaultState.rootPath.set('/vault');
      TestBed.tick();
      await vaultState.refresh();
      fixture.detectChanges();
      return fixture;
    }

    function notePaths(fixture: ComponentFixture<Sidebar>): string[] {
      return [...fixture.nativeElement.querySelectorAll('[data-vault-tree] [data-tree-path]')]
        .map((el) => (el as HTMLElement).dataset['treePath']!)
        .filter((path) => path.endsWith('.mntl'));
    }

    function filter(fixture: ComponentFixture<Sidebar>, value: string): void {
      const input: HTMLInputElement = fixture.nativeElement.querySelector('input[aria-label="Filter notes"]');
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    }

    it('narrows the tree to notes matching the header filter, marking the match', async () => {
      const fixture = await setup();
      expect(notePaths(fixture)).toEqual(['Work/Roadmap.mntl', 'Work/standup.mntl', 'todo.mntl']);

      filter(fixture, 'road');
      expect(notePaths(fixture)).toEqual(['Work/Roadmap.mntl']);
      expect(fixture.nativeElement.querySelector('[data-vault-tree] mark').textContent).toBe('Road');

      filter(fixture, 'zzz');
      expect(notePaths(fixture)).toEqual([]);
      expect(fixture.nativeElement.querySelector('[data-vault-tree]').textContent).toContain('No notes match “zzz”');
    });

    it('marks the note open in the active tab', async () => {
      const fixture = await setup();
      TestBed.inject(TabsState).openNote({ id: 'todo.mntl', title: 'todo' });
      fixture.detectChanges();

      const current = [...fixture.nativeElement.querySelectorAll('[data-vault-tree] [aria-current="page"]')];
      expect(current).toHaveLength(1);
      expect((current[0] as HTMLElement).textContent).toContain('todo');
    });

    function pressCtrlA(target: Element): void {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    }

    it('ctrl-click selects a folder without toggling it', async () => {
      const fixture = await setup();
      const folderRow = fixture.nativeElement.querySelector('[data-tree-path="Work"] [role="button"]') as HTMLElement;
      folderRow.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
      fixture.detectChanges();
      expect([...TestBed.inject(VaultSelectionState).selected()]).toEqual(['Work']);
      expect(folderRow.getAttribute('aria-expanded')).toBe('true');
    });

    it('Ctrl+A selects the direct children of the focused item’s folder, or of the root', async () => {
      const fixture = await setup();
      const selection = TestBed.inject(VaultSelectionState);

      pressCtrlA(fixture.nativeElement.querySelector('[data-vault-tree]'));
      expect([...selection.selected()]).toEqual(['Work', 'todo.mntl']);

      pressCtrlA(fixture.nativeElement.querySelector('[data-tree-path="Work/standup.mntl"] button'));
      expect([...selection.selected()]).toEqual(['Work/Roadmap.mntl', 'Work/standup.mntl']);
    });
  });

  describe('Tags section', () => {
    function note(name: string, tags: string[]): VaultNoteNode {
      return { type: 'note', name, relPath: `${name}.mntl`, encrypted: false, profile: null, tags };
    }

    async function setup(children: VaultNoteNode[]) {
      const mock = installTauriMock();
      mock.respondWith('scan_vault', { type: 'folder', name: 'vault', relPath: '', children });
      mock.respondWith('list_credential_profiles', []);
      mock.respondWith('load_vault_meta', { version: 1, favorites: [], order: {}, collapsedFolders: [], recentNotes: [] });
      const fixture = TestBed.createComponent(Sidebar);
      const vaultState = TestBed.inject(VaultState);
      vaultState.rootPath.set('/vault');
      TestBed.tick();
      await vaultState.refresh();
      fixture.detectChanges();
      return fixture;
    }

    function tagRows(fixture: ComponentFixture<Sidebar>): string[] {
      return [...fixture.nativeElement.querySelectorAll('app-sidebar-section[id="tags"] app-explorer-row')].map((row) => {
        const label = (row as HTMLElement).querySelector('.truncate')!.textContent!.trim();
        const count = (row as HTMLElement).querySelector('.tabular-nums')!.textContent!.trim();
        return `${label} ${count}`;
      });
    }

    it("lists the vault's tags with their note counts", async () => {
      const fixture = await setup([note('plan', ['work', 'Idea']), note('todo.mntl', ['work'])]);
      expect(tagRows(fixture)).toEqual(['Idea 1', 'work 2']);
    });

    it('says so when the vault has no tags', async () => {
      const fixture = await setup([note('plan', [])]);
      expect(fixture.nativeElement.querySelector('app-sidebar-section[id="tags"]').textContent).toContain('No tags yet');
    });

    it('reveals a tag by reopening the sidebar and its Tags section', async () => {
      const fixture = await setup([note('plan', ['work'])]);
      const state = TestBed.inject(SidebarState);
      state.toggleSectionVisibility('tags');
      state.setCollapsed(true);
      fixture.detectChanges();

      TestBed.inject(TagsState).reveal('WORK');
      TestBed.tick();
      fixture.detectChanges();

      expect(state.collapsed()).toBe(false);
      expect(state.isSectionVisible('tags')).toBe(true);
      expect(state.isSectionExpanded('tags')).toBe(true);
      expect(tagRows(fixture)).toEqual(['work 1']);
    });

    it('offers to rename or remove a tag from its context menu', async () => {
      const fixture = await setup([note('plan', ['work'])]);
      const header: HTMLElement = fixture.nativeElement.querySelector(
        'app-sidebar-section[id="tags"] app-explorer-row [role="button"]',
      );
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

      const labels = TestBed.inject(ContextMenuState)
        .menu()
        ?.items.map((item) => (item.kind === 'item' ? item.label : '-'));
      expect(labels).toEqual(['Rename Tag…', '-', 'Remove Tag from All Notes']);
    });
  });
});
