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
    localStorage.setItem('stash.tabs.v1', '{not json');
    const state = TestBed.inject(TabsState);
    expect(state.tabs()).toEqual([]);
  });

  it('drops persisted tabs that no longer reference a real note', () => {
    localStorage.setItem(
      'stash.tabs.v1',
      JSON.stringify({ tabs: [{ id: 'deleted-note', title: 'Gone' }], activeId: 'deleted-note' }),
    );
    const state = TestBed.inject(TabsState);
    expect(state.tabs()).toEqual([]);
    expect(state.activeId()).toBeNull();
  });

  it('hydrates from a previously persisted value', () => {
    localStorage.setItem(
      'stash.tabs.v1',
      JSON.stringify({ tabs: [{ id: noteA.id, title: noteA.title }], activeId: noteA.id }),
    );
    const state = TestBed.inject(TabsState);
    expect(state.tabs()).toEqual([{ id: noteA.id, title: noteA.title }]);
    expect(state.activeId()).toBe(noteA.id);
  });

  it('opens a new note as a tab and activates it', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    expect(state.tabs()).toEqual([{ id: noteA.id, title: noteA.title }]);
    expect(state.activeId()).toBe(noteA.id);
  });

  it('switches to the existing tab instead of duplicating it', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openNote(noteB);
    state.openNote(noteA);
    expect(state.tabs().map((t) => t.id)).toEqual([noteA.id, noteB.id]);
    expect(state.activeId()).toBe(noteA.id);
  });

  it('closing a non-active tab leaves the active tab untouched', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openNote(noteB);
    state.closeTab(noteA.id);
    expect(state.tabs().map((t) => t.id)).toEqual([noteB.id]);
    expect(state.activeId()).toBe(noteB.id);
  });

  it('closing the active tab activates the previous neighbor', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openNote(noteB);
    state.openNote(noteC);
    state.setActive(noteB.id);
    state.closeTab(noteB.id);
    expect(state.tabs().map((t) => t.id)).toEqual([noteA.id, noteC.id]);
    expect(state.activeId()).toBe(noteA.id);
  });

  it('closing the leftmost active tab activates the next tab', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.openNote(noteB);
    state.setActive(noteA.id);
    state.closeTab(noteA.id);
    expect(state.activeId()).toBe(noteB.id);
  });

  it('closing the last remaining tab clears the active id', () => {
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    state.closeTab(noteA.id);
    expect(state.tabs()).toEqual([]);
    expect(state.activeId()).toBeNull();
  });

  it('persists state changes back to localStorage', () => {
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
    const state = TestBed.inject(TabsState);
    state.openNote(noteA);
    TestBed.tick();
    expect(setItemSpy).toHaveBeenCalledWith('stash.tabs.v1', expect.stringContaining(`"id":"${noteA.id}"`));
  });
});
