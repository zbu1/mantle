import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NotesState } from './notes-state';
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
});
