import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { installTauriMock } from '../../../testing/tauri-mock';
import { TabsState } from '../../notes/tabs-state';
import { VaultMetaState } from '../../notes/vault-meta-state';
import { VaultState } from '../../notes/vault-state';
import { VaultFolderNode, VaultNoteNode } from '../../notes/vault-tree.model';
import { ContextMenuState } from '../../shared/context-menu/context-menu-state';
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

  it('reflects the collapsed state from SidebarState', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-sidebar-section')).toBeTruthy();

    state.toggleCollapsed();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-sidebar-section')).toBeFalsy();
  });

  it('removes hidden sections from the sidebar but never the Vault', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();
    const ids = () =>
      [...fixture.nativeElement.querySelectorAll('app-sidebar-section')].map((el: HTMLElement) => el.getAttribute('id'));
    expect(ids()).toEqual(['favorites', 'recent', 'workspace', 'tags', 'credentials']);

    for (const section of ['favorites', 'recent', 'tags', 'credentials'] as const) state.toggleSectionVisibility(section);
    state.toggleSectionVisibility('workspace');
    fixture.detectChanges();

    expect(ids()).toEqual(['workspace']);
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
      return { type: 'note', name: relPath.replace(/\.mntl$/, ''), relPath, encrypted: false, profile: null };
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
});
