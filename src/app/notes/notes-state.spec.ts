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
    expect(state.getNote('daily-standup')).toBeUndefined();
  });

  it('loads note content asynchronously via ensureLoaded', async () => {
    const state = TestBed.inject(NotesState);
    state.ensureLoaded('daily-standup');
    expect(state.entry('daily-standup')?.status).toBe('loading');

    await flushMicrotasks();

    expect(state.getNote('daily-standup')?.content).toBe(FIXTURE_NOTES[0].content);
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
    state.ensureLoaded('daily-standup');
    state.ensureLoaded('architecture-notes');
    await flushMicrotasks();

    const other = state.getNote('architecture-notes');
    state.updateContent('daily-standup', 'new content');

    expect(state.getNote('daily-standup')?.content).toBe('new content');
    expect(state.getNote('architecture-notes')).toBe(other);
  });

  it('updateContent is a no-op for a note that has not been loaded', () => {
    const state = TestBed.inject(NotesState);
    expect(() => state.updateContent('does-not-exist', 'x')).not.toThrow();
    expect(state.getNote('does-not-exist')).toBeUndefined();
  });

  it('debounces disk writes, flushing only the latest content once the quiet period elapses', async () => {
    const state = TestBed.inject(NotesState);
    state.ensureLoaded('daily-standup');
    await flushMicrotasks();

    invoke.mockClear();
    state.updateContent('daily-standup', 'v1');
    state.updateContent('daily-standup', 'v2');
    state.updateContent('daily-standup', 'v3');

    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(0);

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    const writeCalls = invoke.mock.calls.filter(([cmd]) => cmd === 'write_note');
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0][1]).toMatchObject({ relPath: 'daily-standup', content: 'v3' });
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
      state.ensureLoaded('daily-standup');
      await flushMicrotasks();
      expect(state.getNote('daily-standup')).toBeDefined();

      state.markLocked(['daily-standup'], 'my-diary');

      expect(state.getNote('daily-standup')).toBeUndefined();
      expect(state.entry('daily-standup')).toEqual({ status: 'locked', profileId: 'my-diary' });
    });

    it('markLocked ignores notes that were never loaded', () => {
      const state = TestBed.inject(NotesState);
      state.markLocked(['never-opened'], 'my-diary');
      expect(state.entry('never-opened')).toBeUndefined();
    });

    it('reload re-reads a note after its profile is unlocked', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup');
      await flushMicrotasks();
      state.markLocked(['daily-standup'], 'my-diary');

      state.reload('daily-standup');
      await flushMicrotasks();

      expect(state.getNote('daily-standup')?.content).toBe(FIXTURE_NOTES[0].content);
    });
  });

  describe('flushPending', () => {
    it('writes a debounced edit immediately instead of waiting out the timer', async () => {
      const state = TestBed.inject(NotesState);
      state.ensureLoaded('daily-standup');
      await flushMicrotasks();

      invoke.mockClear();
      state.updateContent('daily-standup', 'urgent');

      await state.flushPending(['daily-standup']);

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
      state.updateContent('daily-standup', 'a');
      state.updateContent('todo', 'b');

      await state.flushPending();

      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(2);
    });

    it('is a no-op when nothing is pending', async () => {
      const state = TestBed.inject(NotesState);
      invoke.mockClear();
      await state.flushPending(['daily-standup']);
      expect(invoke.mock.calls.filter(([cmd]) => cmd === 'write_note')).toHaveLength(0);
    });
  });
});
