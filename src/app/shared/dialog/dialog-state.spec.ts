import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DialogState } from './dialog-state';

describe('DialogState', () => {
  let state: DialogState;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    state = TestBed.inject(DialogState);
  });

  describe('confirm / alert', () => {
    it('resolves true when confirmed and false when cancelled', async () => {
      const confirmed = state.confirm('Delete it?', { title: 'Delete' });
      state.confirmAction();
      expect(await confirmed).toBe(true);
      expect(state.request()).toBeNull();

      const cancelled = state.confirm('Delete it?', { title: 'Delete' });
      state.cancel();
      expect(await cancelled).toBe(false);
    });

    it('resolves an alert on either button path', async () => {
      const done = state.alert('Something went wrong', { title: 'Error' });
      state.confirmAction();
      await expect(done).resolves.toBeUndefined();
    });
  });

  describe('prompt', () => {
    it('resolves the submitted value', async () => {
      const value = state.prompt('Name it', { title: 'New' });
      state.confirmAction('Journal');
      expect(await value).toBe('Journal');
    });

    it('resolves null when cancelled, distinguishing it from an empty string', async () => {
      const value = state.prompt('Name it', { title: 'New' });
      state.cancel();
      expect(await value).toBeNull();
    });
  });

  describe('password', () => {
    it('closes and resolves true when submit reports no error', async () => {
      const submit = jest.fn().mockResolvedValue(null);
      const done = state.password('Unlock', { title: 'Unlock' }, submit);

      await state.submitPassword({ name: '', password: 'hunter2' });

      expect(submit).toHaveBeenCalledWith({ name: '', password: 'hunter2' });
      expect(await done).toBe(true);
      expect(state.request()).toBeNull();
      expect(state.inlineError()).toBeNull();
    });

    it('stays open with an inline error when submit reports one', async () => {
      // A wrong password must not close the dialog — the user should be able
      // to correct a typo without the modal flashing shut and reopening.
      const submit = jest.fn().mockResolvedValue('Incorrect password');
      state.password('Unlock', { title: 'Unlock' }, submit);

      await state.submitPassword({ name: '', password: 'wrong' });

      expect(state.request()).not.toBeNull();
      expect(state.inlineError()).toBe('Incorrect password');
      expect(state.busy()).toBe(false);
    });

    it('allows a retry after a failure and resolves on success', async () => {
      const submit = jest
        .fn()
        .mockResolvedValueOnce('Incorrect password')
        .mockResolvedValueOnce(null);
      const done = state.password('Unlock', { title: 'Unlock' }, submit);

      await state.submitPassword({ name: '', password: 'wrong' });
      await state.submitPassword({ name: '', password: 'right' });

      expect(await done).toBe(true);
      expect(state.inlineError()).toBeNull();
    });

    it('resolves false when cancelled', async () => {
      const done = state.password('Unlock', { title: 'Unlock' }, jest.fn());
      state.cancel();
      expect(await done).toBe(false);
    });

    it('ignores cancel while submit is in flight', async () => {
      // Unlocking runs Argon2id, which takes a few hundred milliseconds;
      // Escape during that window must not tear the dialog down mid-derivation.
      let release!: (value: string | null) => void;
      const submit = jest.fn().mockReturnValue(new Promise<string | null>((r) => (release = r)));
      const done = state.password('Unlock', { title: 'Unlock' }, submit);

      const pending = state.submitPassword({ name: '', password: 'hunter2' });
      expect(state.busy()).toBe(true);

      state.cancel();
      expect(state.request()).not.toBeNull();

      release(null);
      await pending;
      expect(await done).toBe(true);
    });

    it('does not close through confirmAction, which bypasses validation', () => {
      state.password('Unlock', { title: 'Unlock' }, jest.fn());
      state.confirmAction();
      expect(state.request()).not.toBeNull();
    });
  });
});
