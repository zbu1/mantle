import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TabsState } from './tabs-state';
import { NoteRef } from './note.model';
import { VaultRootState } from './vault-root-state';

const noteA: NoteRef = { id: 'daily-standup.mntl', title: 'daily-standup.mntl' };
const noteB: NoteRef = { id: 'architecture-notes.mntl', title: 'architecture-notes.mntl' };
const noteC: NoteRef = { id: 'todo.mntl', title: 'todo.mntl' };

describe('TabsState', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    TestBed.inject(VaultRootState).path.set('/vault');
  });

  describe('without an open vault', () => {
    beforeEach(() => TestBed.inject(VaultRootState).path.set(null));

    it('does not open notes', () => {
      const state = TestBed.inject(TabsState);
      state.openNote(noteA);
      state.openNoteInBackground(noteB);
      state.openInNewTab(noteC);
      expect(state.tabs()).toEqual([]);
      expect(state.activeId()).toBeNull();
    });

    it('drops tabs persisted by an earlier session', () => {
      localStorage.setItem(
        'mantle.tabs.v2',
        JSON.stringify({ tabs: [{ id: 'tab-1', noteId: noteA.id, title: noteA.title }], activeId: 'tab-1' }),
      );
      const state = TestBed.inject(TabsState);
      expect(state.tabs()).toEqual([]);
      expect(state.activeId()).toBeNull();
    });
  });

  it('falls back to defaults when storage is empty', () => {
    const state = TestBed.inject(TabsState);
    expect(state.tabs()).toEqual([]);
    expect(state.activeId()).toBeNull();
  });

  it('falls back to defaults when storage is corrupt', () => {
    localStorage.setItem('mantle.tabs.v2', '{not json');
    const state = TestBed.inject(TabsState);
    expect(state.tabs()).toEqual([]);
  });

  it('keeps persisted tabs even if the note no longer exists on disk (validated lazily by the editor)', () => {
    localStorage.setItem(
      'mantle.tabs.v2',
      JSON.stringify({ tabs: [{ id: 'tab-1', noteId: 'deleted-note', title: 'Gone' }], activeId: 'tab-1' }),
    );
    const state = TestBed.inject(TabsState);
    expect(state.tabs()).toEqual([{ id: 'tab-1', noteId: 'deleted-note', title: 'Gone' }]);
    expect(state.activeId()).toBe('tab-1');
  });

  it('drops persisted tabs that are structurally malformed', () => {
    localStorage.setItem(
      'mantle.tabs.v2',
      JSON.stringify({ tabs: [{ id: 'tab-1' }, { noteId: 'x', title: 'y' }], activeId: 'tab-1' }),
    );
    const state = TestBed.inject(TabsState);
    expect(state.tabs()).toEqual([]);
    expect(state.activeId()).toBeNull();
  });

  it('hydrates from a previously persisted value', () => {
    localStorage.setItem(
      'mantle.tabs.v2',
      JSON.stringify({ tabs: [{ id: 'tab-1', noteId: noteA.id, title: noteA.title }], activeId: 'tab-1' }),
    );
    const state = TestBed.inject(TabsState);
    expect(state.tabs()).toEqual([{ id: 'tab-1', noteId: noteA.id, title: noteA.title }]);
    expect(state.activeId()).toBe('tab-1');
  });

  it('opens a new note as a tab and activates it', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    expect(state.tabs().map((t) => t.noteId)).toEqual([noteA.id]);
    expect(state.activeId()).toBe(state.tabs()[0].id);
  });

  it('replaces the active tab instead of creating a new one', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    const firstTabId = state.tabs()[0].id;
    state.openNote(noteB);
    expect(state.tabs().map((t) => t.noteId)).toEqual([noteB.id]);
    expect(state.tabs()[0].id).toBe(firstTabId);
    expect(state.activeId()).toBe(firstTabId);
  });

  it('switches to the existing tab instead of duplicating it', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openNoteInBackground(noteB);
    state.openNote(noteB);
    expect(state.tabs().map((t) => t.noteId)).toEqual([noteA.id, noteB.id]);
    expect(state.activeId()).toBe(state.tabs()[1].id);
  });

  it('opens a new background tab even if the note is already open', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    const firstTabId = state.tabs()[0].id;
    state.openNoteInBackground(noteA);
    expect(state.tabs().map((t) => t.noteId)).toEqual([noteA.id, noteA.id]);
    expect(state.tabs()[1].id).not.toBe(firstTabId);
    expect(state.activeId()).toBe(firstTabId);
  });

  it('closing a non-active tab leaves the active tab untouched', () => {
    const state = TestBed.inject(TabsState);
    state.openNoteInBackground(noteA);
    state.openNoteInBackground(noteB);
    const [tabA, tabB] = state.tabs();
    state.setActive(tabB.id);
    state.closeTab(tabA.id);
    expect(state.tabs().map((t) => t.id)).toEqual([tabB.id]);
    expect(state.activeId()).toBe(tabB.id);
  });

  it('closing the active tab activates the previous neighbor', () => {
    const state = TestBed.inject(TabsState);
    state.openNoteInBackground(noteA);
    state.openNoteInBackground(noteB);
    state.openNoteInBackground(noteC);
    const [tabA, tabB, tabC] = state.tabs();
    state.setActive(tabB.id);
    state.closeTab(tabB.id);
    expect(state.tabs().map((t) => t.id)).toEqual([tabA.id, tabC.id]);
    expect(state.activeId()).toBe(tabA.id);
  });

  it('closing the leftmost active tab activates the next tab', () => {
    const state = TestBed.inject(TabsState);
    state.openNoteInBackground(noteA);
    state.openNoteInBackground(noteB);
    const [tabA, tabB] = state.tabs();
    state.setActive(tabA.id);
    state.closeTab(tabA.id);
    expect(state.activeId()).toBe(tabB.id);
  });

  it('closing the last remaining tab clears the active id', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.closeTab(state.tabs()[0].id);
    expect(state.tabs()).toEqual([]);
    expect(state.activeId()).toBeNull();
  });

  it('has no history to navigate when a tab has not replaced notes', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    expect(state.canGoBack()).toBe(false);
    expect(state.canGoForward()).toBe(false);
  });

  it('navigates back and forward through notes opened in the same tab', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    const tabId = state.tabs()[0].id;
    state.openNote(noteB);
    state.openNote(noteC);

    expect(state.canGoBack()).toBe(true);
    expect(state.canGoForward()).toBe(false);

    state.goBack();
    expect(state.tabs().find((t) => t.id === tabId)?.noteId).toBe(noteB.id);
    expect(state.canGoBack()).toBe(true);
    expect(state.canGoForward()).toBe(true);

    state.goBack();
    expect(state.tabs().find((t) => t.id === tabId)?.noteId).toBe(noteA.id);
    expect(state.canGoBack()).toBe(false);
    expect(state.canGoForward()).toBe(true);

    state.goForward();
    expect(state.tabs().find((t) => t.id === tabId)?.noteId).toBe(noteB.id);

    state.goForward();
    expect(state.tabs().find((t) => t.id === tabId)?.noteId).toBe(noteC.id);
    expect(state.canGoForward()).toBe(false);
  });

  it('jumps several entries back or forward at once, as pressing the button that many times would', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    const tabId = state.tabs()[0].id;
    state.openNote(noteB);
    state.openNote(noteC);
    const noteIds = (entries: { noteId: string }[]) => entries.map((e) => e.noteId);
    expect(noteIds(state.backEntries())).toEqual([noteB.id, noteA.id]);

    state.goBack(2);
    expect(state.tabs().find((t) => t.id === tabId)?.noteId).toBe(noteA.id);
    expect(noteIds(state.backEntries())).toEqual([]);
    expect(noteIds(state.forwardEntries())).toEqual([noteB.id, noteC.id]);

    state.goForward(2);
    expect(state.tabs().find((t) => t.id === tabId)?.noteId).toBe(noteC.id);
    expect(noteIds(state.backEntries())).toEqual([noteB.id, noteA.id]);
    expect(state.canGoForward()).toBe(false);
  });

  it('clears forward history when navigating to a new note after going back', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openNote(noteB);
    state.goBack();
    expect(state.canGoForward()).toBe(true);

    state.openNote(noteC);
    expect(state.canGoForward()).toBe(false);
    expect(state.canGoBack()).toBe(true);
    expect(state.tabs()[0].noteId).toBe(noteC.id);
  });

  it('drops history for a tab once it is closed', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openNote(noteB);
    const tabId = state.tabs()[0].id;
    state.closeTab(tabId);
    expect(state.canGoBack()).toBe(false);
  });

  it('navigates back and forward across tab switches', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openInNewTab(noteB);
    const [tabA, tabB] = state.tabs();
    state.openNote(noteC); // replaces B in tabB
    state.setActive(tabA.id);

    state.goBack();
    expect(state.activeId()).toBe(tabB.id);
    expect(state.tabs()[1].noteId).toBe(noteC.id);
    state.goBack();
    expect(state.tabs()[1].noteId).toBe(noteB.id);
    state.goBack();
    expect(state.activeId()).toBe(tabA.id);
    expect(state.canGoBack()).toBe(false);

    state.goForward();
    state.goForward();
    state.goForward();
    expect(state.activeId()).toBe(tabA.id);
    expect(state.tabs()[1].noteId).toBe(noteC.id);
    expect(state.canGoForward()).toBe(false);
  });

  it('does not record re-activating the current tab', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.setActive(state.tabs()[0].id);
    expect(state.canGoBack()).toBe(false);
  });

  it('skips a closed tab and entries that collapse onto the current location', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openInNewTab(noteB);
    const [tabA, tabB] = state.tabs();
    state.setActive(tabA.id); // history: A, B -> now A
    state.closeTab(tabB.id);
    expect(state.canGoBack()).toBe(false);
    expect(state.canGoForward()).toBe(false);
  });

  describe('empty tabs', () => {
    it('fills an empty tab with the next note opened, skipping it in history', () => {
      const state = TestBed.inject(TabsState);
      state.openNote(noteA);
      state.openEmptyTab();
      const empty = state.activeId()!;
      expect(state.tabs().find((t) => t.id === empty)?.noteId).toBeNull();
      // Opening a note that's already in another tab still lands in the empty one.
      state.openNote(noteA);
      expect(state.activeId()).toBe(empty);
      expect(state.tabs().map((t) => t.noteId)).toEqual([noteA.id, noteA.id]);
      state.goBack();
      expect(state.tabs().find((t) => t.id === state.activeId())?.noteId).toBe(noteA.id);
    });

    it('does not record an empty tab as a place to go back to', () => {
      const state = TestBed.inject(TabsState);
      state.openEmptyTab();
      state.openInNewTab(noteB);
      expect(state.tabs()).toHaveLength(1);
      expect(state.canGoBack()).toBe(false);
    });

    it('is persisted and restored', () => {
      const state = TestBed.inject(TabsState);
      state.openEmptyTab();
      TestBed.tick();
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      TestBed.inject(VaultRootState).path.set('/vault');
      const restored = TestBed.inject(TabsState);
      expect(restored.tabs().map((t) => t.noteId)).toEqual([null]);
      expect(restored.activeId()).toBe(restored.tabs()[0].id);
    });
  });

  it('persists state changes back to localStorage', () => {
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    TestBed.tick();
    expect(setItemSpy).toHaveBeenCalledWith('mantle.tabs.v2', expect.stringContaining(`"noteId":"${noteA.id}"`));
  });
  describe('panes', () => {
    it('splits beside the active pane, nesting a split of the other direction', () => {
      const state = TestBed.inject(TabsState);
      state.openNote(noteA);
      const first = state.activePane().id;
      state.openBeside(noteB, 'row');
      expect(state.panes().map((p) => state.tabsOf(p.id).map((t) => t.noteId))).toEqual([[noteA.id], [noteB.id]]);
      expect(state.tabs().find((t) => t.id === state.activeId())?.noteId).toBe(noteB.id);
      state.openBeside(noteA, 'column');
      const layout = state.layout();
      expect(layout.kind === 'split' && layout.direction).toBe('row');
      expect(layout.kind === 'split' && layout.children[1].kind).toBe('split');
      state.focusPane(first);
      expect(state.tabs().find((t) => t.id === state.activeId())?.noteId).toBe(noteA.id);
    });

    it('moves tabs between panes, reorders them, and drops a pane once it is empty', () => {
      const state = TestBed.inject(TabsState);
      state.openNote(noteA);
      state.openInNewTab(noteB);
      state.openBeside(noteC);
      const [left, right] = state.panes();
      const [tabA, tabB] = state.tabsOf(left.id);
      state.moveTab(tabB.id, left.id, 0);
      expect(state.tabsOf(left.id).map((t) => t.noteId)).toEqual([noteB.id, noteA.id]);
      state.moveTab(tabA.id, right.id, 0);
      expect(state.tabsOf(right.id).map((t) => t.noteId)).toEqual([noteA.id, noteC.id]);
      expect(state.activeId()).toBe(tabA.id);
      state.moveTab(tabB.id, right.id, 2);
      expect(state.panes()).toHaveLength(1);
      expect(state.layout().kind).toBe('pane');
    });

    it('collapses a split when a pane closes its last tab, and restores the layout from storage', () => {
      const state = TestBed.inject(TabsState);
      state.openNote(noteA);
      state.openBeside(noteB);
      TestBed.tick();
      const saved = JSON.parse(localStorage.getItem('mantle.tabs.v2')!);
      expect(saved.layout.kind).toBe('split');

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
      TestBed.inject(VaultRootState).path.set('/vault');
      const restored = TestBed.inject(TabsState);
      expect(restored.panes()).toHaveLength(2);
      restored.closeTab(restored.activeId()!);
      expect(restored.layout().kind).toBe('pane');
      expect(restored.tabs().map((t) => t.noteId)).toEqual([noteA.id]);
    });
  });
});
