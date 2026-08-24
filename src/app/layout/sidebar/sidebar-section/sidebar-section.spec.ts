import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SidebarSection } from './sidebar-section';
import { SidebarState } from '../sidebar-state';

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
    button.click();
    fixture.detectChanges();

    expect(state.isSectionExpanded('tags')).toBe(false);
    const content: HTMLElement = fixture.nativeElement.querySelector('[class*="mt-0.5"]').parentElement.parentElement;
    expect(content.style.gridTemplateRows).toBe('0fr');
  });
});
