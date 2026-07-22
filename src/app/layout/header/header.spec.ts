import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Header } from './header';
import { SidebarState } from '../sidebar/sidebar-state';

describe('Header', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [Header],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(Header);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('toggleSidebar delegates to SidebarState.toggleCollapsed', () => {
    const fixture = TestBed.createComponent(Header);
    const state = TestBed.inject(SidebarState);
    expect(state.collapsed()).toBe(false);

    fixture.componentInstance.toggleSidebar();

    expect(state.collapsed()).toBe(true);
  });
});
