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

  it('starts with no profile selected and the category active', () => {
    expect(state.profileId()).toBeNull();
    expect(state.activeCategory()).toBe('general');
  });

  it('selectProfile() shows the profile and deactivates every category', () => {
    state.selectProfile('work');
    expect(state.profileId()).toBe('work');
    expect(state.activeCategory()).toBeNull();
  });

  it('selectCategory() leaves a selected profile', () => {
    state.selectProfile('work');
    state.selectCategory('editor');
    expect(state.profileId()).toBeNull();
    expect(state.activeCategory()).toBe('editor');
  });

  it('openProfile() opens the window on that profile, restoring it if minimized', () => {
    state.open();
    state.minimize();
    state.openProfile('work');
    expect(state.isOpen()).toBe(true);
    expect(state.minimized()).toBe(false);
    expect(state.profileId()).toBe('work');
  });

  it('open(category) leaves a selected profile for that category', () => {
    state.selectProfile('work');
    state.open('appearance');
    expect(state.profileId()).toBeNull();
    expect(state.category()).toBe('appearance');
  });

  it('open() with no category keeps a selected profile', () => {
    state.selectProfile('work');
    state.open();
    expect(state.profileId()).toBe('work');
  });

  it('close() keeps the selected profile for next time', () => {
    state.openProfile('work');
    state.close();
    expect(state.profileId()).toBe('work');
  });
});
