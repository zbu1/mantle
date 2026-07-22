import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SidebarItemButton } from './sidebar-item-button';

describe('SidebarItemButton', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SidebarItemButton],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(SidebarItemButton);
    fixture.componentRef.setInput('label', 'Favorites');
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('hides the label when collapsed', () => {
    const fixture = TestBed.createComponent(SidebarItemButton);
    fixture.componentRef.setInput('label', 'Favorites');
    fixture.componentRef.setInput('collapsed', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('span.flex-1')).toBeFalsy();
    expect(fixture.nativeElement.querySelector('button').title).toBe('Favorites');
  });

  it('shows the label when expanded', () => {
    const fixture = TestBed.createComponent(SidebarItemButton);
    fixture.componentRef.setInput('label', 'Favorites');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('span.flex-1')?.textContent).toContain('Favorites');
  });
});
