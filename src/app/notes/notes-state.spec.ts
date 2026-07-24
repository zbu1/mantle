import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NotesState } from './notes-state';
import { findNote } from './notes-data';

describe('NotesState', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('returns seeded notes by id', () => {
    const state = TestBed.inject(NotesState);
    const seeded = findNote('daily-standup')!;
    expect(state.getNote('daily-standup')).toEqual(seeded);
  });

  it('returns undefined for an unknown id', () => {
    const state = TestBed.inject(NotesState);
    expect(state.getNote('does-not-exist')).toBeUndefined();
  });

  it('updateContent mutates only the targeted note', () => {
    const state = TestBed.inject(NotesState);
    const other = state.getNote('architecture-notes');

    state.updateContent('daily-standup', 'new content');

    expect(state.getNote('daily-standup')?.content).toBe('new content');
    expect(state.getNote('architecture-notes')).toBe(other);
  });

  it('updateContent is a no-op for an unknown id', () => {
    const state = TestBed.inject(NotesState);
    expect(() => state.updateContent('does-not-exist', 'x')).not.toThrow();
    expect(state.getNote('does-not-exist')).toBeUndefined();
  });

  it('updateContent is a no-op when content is unchanged', () => {
    const state = TestBed.inject(NotesState);
    const before = state.getNote('daily-standup');

    state.updateContent('daily-standup', before!.content);

    expect(state.getNote('daily-standup')).toBe(before);
  });
});
