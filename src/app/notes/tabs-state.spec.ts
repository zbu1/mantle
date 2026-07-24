import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TabsState } from './tabs-state';
import { findNote } from './notes-data';

const noteA = findNote('daily-standup')!;
const noteB = findNote('architecture-notes')!;
const noteC = findNote('todo')!;

describe('TabsState', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
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

  it('drops persisted tabs that no longer reference a real note', () => {
    localStorage.setItem(
      'mantle.tabs.v2',
      JSON.stringify({ tabs: [{ id: 'tab-1', noteId: 'deleted-note', title: 'Gone' }], activeId: 'tab-1' }),
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

  it('persists state changes back to localStorage', () => {
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    TestBed.tick();
    expect(setItemSpy).toHaveBeenCalledWith('mantle.tabs.v2', expect.stringContaining(`"noteId":"${noteA.id}"`));
  });
});
