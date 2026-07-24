import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ContentArea } from './content-area';
import { TabsState } from '../../../notes/tabs-state';
import { findNote } from '../../../notes/notes-data';

describe('ContentArea', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [ContentArea],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('shows the empty state when no tabs are open', () => {
    const fixture = TestBed.createComponent(ContentArea);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No notes open');
  });

  it('renders the active note title and content', async () => {
    const fixture = TestBed.createComponent(ContentArea);
    const tabsState = TestBed.inject(TabsState);
    const note = findNote('daily-standup')!;
    tabsState.openNote(note);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain(note.title);
    expect(fixture.nativeElement.querySelector('.ProseMirror')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain(note.content);
  });
});
