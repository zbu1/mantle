import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { COLLAPSE_THRESHOLD, SidebarState } from './sidebar-state';

describe('SidebarState', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('falls back to defaults when storage is empty', () => {
    const state = TestBed.inject(SidebarState);
    expect(state.width()).toBe(240);
    expect(state.collapsed()).toBe(false);
    expect(state.sections()).toEqual({ favorites: true, recent: true, workspace: true, tags: true });
  });

  it('falls back to defaults when storage is corrupt', () => {
    localStorage.setItem('mantle.sidebar.v1', '{not json');
    const state = TestBed.inject(SidebarState);
    expect(state.width()).toBe(240);
  });

  it('hydrates from a previously persisted value', () => {
    localStorage.setItem(
      'mantle.sidebar.v1',
      JSON.stringify({ width: 300, collapsed: true, sections: { favorites: false, recent: true, workspace: true, tags: true } }),
    );
    const state = TestBed.inject(SidebarState);
    expect(state.width()).toBe(300);
    expect(state.collapsed()).toBe(true);
    expect(state.isSectionExpanded('favorites')).toBe(false);
  });

  it('clamps width to the min/max bounds', () => {
    const state = TestBed.inject(SidebarState);
    state.setWidth(10);
    expect(state.width()).toBe(180);
    state.setWidth(10000);
    expect(state.width()).toBe(400);
  });

  it('toggles collapsed and per-section expanded state', () => {
    const state = TestBed.inject(SidebarState);
    expect(state.collapsed()).toBe(false);
    state.toggleCollapsed();
    expect(state.collapsed()).toBe(true);

    expect(state.isSectionExpanded('tags')).toBe(true);
    state.toggleSection('tags');
    expect(state.isSectionExpanded('tags')).toBe(false);
  });

  it('collapses to zero width via effectiveWidth', () => {
    const state = TestBed.inject(SidebarState);
    state.setWidth(300);
    expect(state.effectiveWidth()).toBe(300);
    state.toggleCollapsed();
    expect(state.effectiveWidth()).toBe(0);
  });

  it('exposes setCollapsed for direct state changes (e.g. drag-to-minimize)', () => {
    const state = TestBed.inject(SidebarState);
    expect(state.collapsed()).toBe(false);
    state.setCollapsed(true);
    expect(state.collapsed()).toBe(true);
    state.setCollapsed(true);
    expect(state.collapsed()).toBe(true);
    state.setCollapsed(false);
    expect(state.collapsed()).toBe(false);
  });

  it('defines COLLAPSE_THRESHOLD below MIN_WIDTH so there is a snap zone before collapsing', () => {
    expect(COLLAPSE_THRESHOLD).toBeLessThan(180);
    expect(COLLAPSE_THRESHOLD).toBeGreaterThan(0);
  });

  it('persists state changes back to localStorage', () => {
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
    const state = TestBed.inject(SidebarState);
    state.setWidth(280);
    TestBed.tick();
    expect(setItemSpy).toHaveBeenCalledWith('mantle.sidebar.v1', expect.stringContaining('"width":280'));
  });
});
