import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { VaultSelectionState } from './vault-selection-state';

describe('VaultSelectionState', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  function setup(): VaultSelectionState {
    return TestBed.inject(VaultSelectionState);
  }

  it('starts with nothing selected', () => {
    const state = setup();
    expect(state.selected().size).toBe(0);
    expect(state.isSelected('a.mntl')).toBe(false);
  });

  it('selectOnly replaces the selection with a single note', () => {
    const state = setup();
    state.toggle('a.mntl');
    state.toggle('b.mntl');
    state.selectOnly('c.mntl');
    expect([...state.selected()]).toEqual(['c.mntl']);
  });

  it('toggle adds and removes a note from the selection', () => {
    const state = setup();
    state.toggle('a.mntl');
    state.toggle('b.mntl');
    expect(state.selected()).toEqual(new Set(['a.mntl', 'b.mntl']));

    state.toggle('a.mntl');
    expect(state.selected()).toEqual(new Set(['b.mntl']));
  });

  it('selectRange selects everything between the anchor and the target, inclusive', () => {
    const state = setup();
    const ordered = ['a.mntl', 'b.mntl', 'c.mntl', 'd.mntl'];
    state.selectOnly('b.mntl');
    state.selectRange('d.mntl', ordered);
    expect(state.selected()).toEqual(new Set(['b.mntl', 'c.mntl', 'd.mntl']));
  });

  it('selectRange works in reverse order', () => {
    const state = setup();
    const ordered = ['a.mntl', 'b.mntl', 'c.mntl', 'd.mntl'];
    state.selectOnly('c.mntl');
    state.selectRange('a.mntl', ordered);
    expect(state.selected()).toEqual(new Set(['a.mntl', 'b.mntl', 'c.mntl']));
  });

  it('selectRange falls back to selecting just the target when there is no anchor context', () => {
    const state = setup();
    state.selectRange('z.mntl', ['a.mntl', 'b.mntl']);
    expect([...state.selected()]).toEqual(['z.mntl']);
  });

  it('remove drops a single note without touching the rest', () => {
    const state = setup();
    state.toggle('a.mntl');
    state.toggle('b.mntl');
    state.remove('a.mntl');
    expect(state.selected()).toEqual(new Set(['b.mntl']));
  });

  it('clear empties the selection', () => {
    const state = setup();
    state.toggle('a.mntl');
    state.toggle('b.mntl');
    state.clear();
    expect(state.selected().size).toBe(0);
  });
});
