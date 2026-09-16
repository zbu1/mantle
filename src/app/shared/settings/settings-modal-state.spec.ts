import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SettingsModalState } from './settings-modal-state';

describe('SettingsModalState', () => {
  let state: SettingsModalState;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    state = TestBed.inject(SettingsModalState);
  });

  it('starts closed on the general category', () => {
    expect(state.isOpen()).toBe(false);
    expect(state.category()).toBe('general');
  });

  it('open() opens the modal without changing the category', () => {
    state.selectCategory('encryption');
    state.open();
    expect(state.isOpen()).toBe(true);
    expect(state.category()).toBe('encryption');
  });

  it('open(category) switches to that category', () => {
    state.open('appearance');
    expect(state.isOpen()).toBe(true);
    expect(state.category()).toBe('appearance');
  });

  it('close() leaves the last-viewed category in place', () => {
    state.open('files');
    state.close();
    expect(state.isOpen()).toBe(false);
    expect(state.category()).toBe('files');
  });

  it('selectCategory() switches the visible category while open', () => {
    state.open();
    state.selectCategory('advanced');
    expect(state.category()).toBe('advanced');
  });
});
