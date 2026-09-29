import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SidebarSection } from './sidebar-section';
import { SidebarState } from '../sidebar-state';
import { ContextMenuState } from '../../../shared/context-menu/context-menu-state';
import { ContextMenuAction } from '../../../shared/context-menu/context-menu.model';

describe('SidebarSection', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [SidebarSection],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(SidebarSection);
    fixture.componentRef.setInput('id', 'favorites');
    fixture.componentRef.setInput('label', 'Favorites');
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('toggles expanded state through the shared SidebarState', () => {
    const fixture = TestBed.createComponent(SidebarSection);
    fixture.componentRef.setInput('id', 'tags');
    fixture.componentRef.setInput('label', 'Tags');
    fixture.detectChanges();

    const state = TestBed.inject(SidebarState);
    expect(state.isSectionExpanded('tags')).toBe(true);
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    expect(button.getAttribute('aria-expanded')).toBe('true');

    button.click();
    fixture.detectChanges();

    expect(state.isSectionExpanded('tags')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a count after the label, but not a zero', () => {
    const fixture = TestBed.createComponent(SidebarSection);
    fixture.componentRef.setInput('id', 'tags');
    fixture.componentRef.setInput('label', 'Tags');
    fixture.componentRef.setInput('count', 5);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button').textContent.replace(/\s+/g, '')).toBe('Tags5');

    fixture.componentRef.setInput('count', 0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button').textContent.trim()).toBe('Tags');
  });

  it('right-clicking the header opens a checklist of the sections', () => {
    const fixture = TestBed.createComponent(SidebarSection);
    fixture.componentRef.setInput('id', 'tags');
    fixture.componentRef.setInput('label', 'Tags');
    fixture.detectChanges();

    const state = TestBed.inject(SidebarState);
    state.toggleSectionVisibility('recent');

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    const items = TestBed.inject(ContextMenuState).menu()?.items as ContextMenuAction[];
    expect(items.map((i) => [i.label, i.checked, !!i.disabled])).toEqual([
      ['Favorites', true, false],
      ['Recent Files', false, false],
      ['Tags', true, false],
      ['Credential Profiles', true, false],
    ]);

    items[2].action();
    expect(state.isSectionVisible('tags')).toBe(false);
  });
});
