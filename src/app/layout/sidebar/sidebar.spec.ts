import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Sidebar } from './sidebar';
import { SidebarState } from './sidebar-state';

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
    TestBed.configureTestingModule({
      imports: [Sidebar],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(Sidebar);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('reflects the collapsed state from SidebarState', () => {
    const fixture = TestBed.createComponent(Sidebar);
    const state = TestBed.inject(SidebarState);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-sidebar-section')).toBeTruthy();

    state.toggleCollapsed();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-sidebar-section')).toBeFalsy();
  });
});
