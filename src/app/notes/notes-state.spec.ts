import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NotesState, titleFromRelPath } from './notes-state';
import { VaultState } from './vault-state';
import { FIXTURE_NOTES, installMockVaultInvoke } from '../../testing/mock-vault';

/** Flushes pending microtasks (e.g. the mocked async `invoke` chain) without advancing real time. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('NotesState', () => {
  let invoke: jest.Mock;

  beforeEach(() => {
    localStorage.clear();
    // Fake timers keep each test's debounce timers self-contained — with real
    // timers, a stray setTimeout scheduled by one test's updateContent() call
    // can fire mid-way through a later test and pollute its invoke.mock.calls.
    jest.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    invoke = installMockVaultInvoke();
    TestBed.inject(VaultState).rootPath.set('/fake/vault');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns undefined for a note that has not been loaded', () => {
    const state = TestBed.inject(NotesState);
    expect(state.getNote('daily-standup.mntl')).toBeUndefined();
  });

  it('loads note content asynchronously via ensureLoaded', async () => {
    const state = TestBed.inject(NotesState);
    state.ensureLoaded('daily-standup.mntl');
    expect(state.entry('daily-standup.mntl')?.status).toBe('loading');

    await flushMicrotasks();

    expect(state.getNote('daily-standup.mntl')?.content).toBe(FIXTURE_NOTES[0].content);
  });

  it('takes a change made on disk by another app, unless it has unsaved edits', async () => {
    const state = TestBed.inject(NotesState);
    state.ensureLoaded('daily-standup.mntl');
    state.ensureLoaded('todo.mntl');
    await flushMicrotasks();
    await invoke('write_note', { relPath: 'daily-standup.mntl', content: 'edited elsewhere' });
    await invoke('write_note', { relPath: 'todo.mntl', content: 'edited elsewhere' });
    state.updateContent('todo.mntl', 'typed here');

    await state['refreshFromDisk']('daily-standup.mntl');
    await state['refreshFromDisk']('todo.mntl');

    expect(state.getNote('daily-standup.mntl')?.content).toBe('edited elsewhere');
    expect(state.getNote('todo.mntl')?.content).toBe('typed here');
  });

  it('returns an error entry for an id the vault cannot read', async () => {
    const state = TestBed.inject(NotesState);
    state.ensureLoaded('does-not-exist');
    await flushMicrotasks();

    expect(state.entry('does-not-exist')?.status).toBe('error');
    expect(state.getNote('does-not-exist')).toBeUndefined();
  });

  it('updateContent mutates only the targeted loaded note', async () => {
    const state = TestBed.inject(NotesState);
    state.ensureLoaded('daily-standup.mntl');
    state.ensureLoaded('architecture-notes.mntl');
    await flushMicrotasks();

    const other = state.getNote('architecture-notes.mntl');
    state.updateContent('daily-standup.mntl', 'new content');

    expect(state.getNote('daily-standup.mntl')?.content).toBe('new content');
    expect(state.getNote('architecture-notes.mntl')).toBe(other);
  });

  it('updateContent is a no-op for a note that has not been loaded', () => {
    const state = TestBed.inject(NotesState);
    expect(() => state.updateContent('does-not-exist', 'x')).not.toThrow();
    expect(state.getNote('does-not-exist')).toBeUndefined();
  });

  it('debounces disk writes, flushing only the latest content once the quiet period elapses', async () => {
    const state = TestBed.inject(NotesState);
    state.ensureLoaded('daily-standup.mntl');
    await flushMicrotasks();

    invoke.mockClear();
    state.updateContent('daily-standup.mntl', 'v1');
    state.updateContent('daily-standup.mntl', 'v2');
    state.updateContent('daily-standup.mntl', 'v3');

    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(0);

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    const writeCalls = invoke.mock.calls.filter(([cmd]) => cmd === 'write_note');
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0][1]).toMatchObject({ relPath: 'daily-standup.mntl', content: 'v3' });
  });

  it('follows attachment links a save re-pointed, without saving again', async () => {
    const state = TestBed.inject(NotesState);
    state.ensureLoaded('daily-standup.mntl');
    await flushMicrotasks();

    const respond = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) =>
      command === 'write_note' ? Promise.resolve({ 'a.png': 'attachments/x.png.enc' }) : respond(command, args),
    );
    state.updateContent('daily-standup.mntl', '![](a.png) and ![[a.png|300]]');
    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(state.getNote('daily-standup.mntl')?.content).toBe(
      '![](attachments/x.png.enc) and ![[attachments/x.png.enc|300]]',
    );
    expect(state.relinked()).toEqual({ noteId: 'daily-standup.mntl', sources: { 'a.png': 'attachments/x.png.enc' } });
    invoke.mockClear();
    jest.advanceTimersByTime(1000);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(0);
  });

  describe('tags', () => {
    it('loads a note with its tags', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup.mntl');
      await flushMicrotasks();

      expect(state.getNote('daily-standup.mntl')?.tags).toEqual(FIXTURE_NOTES[0].tags);
    });

    it('saves tag edits with the same debounce as content, alongside it', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup.mntl');
      await flushMicrotasks();

      invoke.mockClear();
      state.updateTags('daily-standup.mntl', ['work', 'urgent', 'idea']);
      state.updateContent('daily-standup.mntl', 'edited');
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();

      const writes = invoke.mock.calls.filter(([cmd]) => cmd === 'write_note');
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toMatchObject({ content: 'edited', tags: ['work', 'urgent', 'idea'] });
    });

    it('does not save when the tags are unchanged', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup.mntl');
      await flushMicrotasks();

      invoke.mockClear();
      state.updateTags('daily-standup.mntl', [...FIXTURE_NOTES[0].tags]);
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();

      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(0);
    });

    it('retagLoaded mirrors a vault-wide rename, merging duplicates, without writing', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup.mntl');
      state.ensureLoaded('architecture-notes.mntl');
      await flushMicrotasks();

      invoke.mockClear();
      state.retagLoaded('URGENT', 'work');
      expect(state.getNote('daily-standup.mntl')?.tags).toEqual(['work']);

      state.retagLoaded('work', null);
      expect(state.getNote('architecture-notes.mntl')?.tags).toEqual([]);

      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(0);
    });
  });

  describe('titleFromRelPath', () => {
    it('strips the whole compound extension of an encrypted note', () => {
      // `.mntl.enc` has to be tried first: stripping `.mntl` alone would
      // leave every encrypted tab titled "Dream journal.mntl.enc".
      expect(titleFromRelPath('Personal/dream.mntl.enc')).toBe('dream');
      expect(titleFromRelPath('Personal/todo.mntl')).toBe('todo');
      expect(titleFromRelPath('todo.mntl')).toBe('todo');
    });

    it('strips the extension of a plain Markdown file', () => {
      expect(titleFromRelPath('Docs/readme.md')).toBe('readme');
      expect(titleFromRelPath('guide.markdown')).toBe('guide');
    });
  });

  describe('locked notes', () => {
    it('maps the backend locked sentinel onto a locked entry', async () => {
      const state = TestBed.inject(NotesState);
      invoke.mockImplementation(async (command: string) => {
        if (command === 'read_note') throw new Error('mantle:locked:my-diary');
        return undefined;
      });

      state.ensureLoaded('dream.mntl.enc');
      await flushMicrotasks();

      expect(state.entry('dream.mntl.enc')).toEqual({ status: 'locked', profileId: 'my-diary' });
    });

    it('keeps an ordinary read failure an error, not a lock', async () => {
      const state = TestBed.inject(NotesState);
      invoke.mockImplementation(async (command: string) => {
        if (command === 'read_note') throw new Error('Failed to read note: no such file');
        return undefined;
      });

      state.ensureLoaded('missing.mntl');
      await flushMicrotasks();

      expect(state.entry('missing.mntl')?.status).toBe('error');
    });

    it('markLocked replaces loaded content so nothing decrypted lingers', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup.mntl');
      await flushMicrotasks();
      expect(state.getNote('daily-standup.mntl')).toBeDefined();

      state.markLocked(['daily-standup.mntl'], 'my-diary');

      expect(state.getNote('daily-standup.mntl')).toBeUndefined();
      expect(state.entry('daily-standup.mntl')).toEqual({ status: 'locked', profileId: 'my-diary' });
    });

    it('markLocked ignores notes that were never loaded', () => {
      const state = TestBed.inject(NotesState);
      state.markLocked(['never-opened'], 'my-diary');
      expect(state.entry('never-opened')).toBeUndefined();
    });

    it('reload re-reads a note after its profile is unlocked', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup.mntl');
      await flushMicrotasks();
      state.markLocked(['daily-standup.mntl'], 'my-diary');

      state.reload('daily-standup.mntl');
      await flushMicrotasks();

      expect(state.getNote('daily-standup.mntl')?.content).toBe(FIXTURE_NOTES[0].content);
    });
  });

  describe('flushPending', () => {
    it('writes a debounced edit immediately instead of waiting out the timer', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup.mntl');
      await flushMicrotasks();

      invoke.mockClear();
      state.updateContent('daily-standup.mntl', 'urgent');

      await state.flushPending(['daily-standup.mntl']);

      const writes = invoke.mock.calls.filter(([cmd]) => cmd === 'write_note');
      expect(writes).toHaveLength(1);
      expect(writes[0][1]).toMatchObject({ content: 'urgent' });

      // The timer was cancelled, so letting it elapse writes nothing more.
      jest.advanceTimersByTime(1000);
      await flushMicrotasks();
      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(1);
    });

    it('flushes every pending note when called with no arguments', async () => {
      const state = TestBed.inject(NotesState);
      for (const note of FIXTURE_NOTES) {
        state.ensureLoaded(note.id);
      }
      await flushMicrotasks();

      invoke.mockClear();
      state.updateContent('daily-standup.mntl', 'a');
      state.updateContent('todo.mntl', 'b');

      await state.flushPending();

      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(2);
    });

    it('is a no-op when nothing is pending', async () => {
      const state = TestBed.inject(NotesState);
      invoke.mockClear();
      await state.flushPending(['daily-standup.mntl']);
      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(0);
    });
  });
});
