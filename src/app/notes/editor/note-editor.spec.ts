import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { Editor } from '@tiptap/core';
import { NoteEditor } from './note-editor';
import { NotesState } from '../notes-state';

function getEditor(component: NoteEditor): Editor {
  return (component as unknown as { editor: Editor }).editor;
}

describe('NoteEditor', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [NoteEditor],
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('renders the seeded note content', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup');
    fixture.detectChanges();
    await fixture.whenStable();

    const notesState = TestBed.inject(NotesState);
    const note = notesState.getNote('daily-standup')!;

    expect(fixture.nativeElement.querySelector('.ProseMirror')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain(note.content);
  });

  it('saves edits back into NotesState through onUpdate', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup');
    fixture.detectChanges();
    await fixture.whenStable();

    const notesState = TestBed.inject(NotesState);
    const editor = getEditor(fixture.componentInstance);

    editor.commands.setContent('Updated content', { emitUpdate: true });

    expect(notesState.getNote('daily-standup')?.content.trim()).toBe('Updated content');
  });

  it('swaps content when noteId changes without recreating the editor', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup');
    fixture.detectChanges();
    await fixture.whenStable();

    const notesState = TestBed.inject(NotesState);
    const editorBefore = getEditor(fixture.componentInstance);
    const otherNote = notesState.getNote('architecture-notes')!;

    fixture.componentRef.setInput('noteId', 'architecture-notes');
    fixture.detectChanges();
    await fixture.whenStable();

    const editorAfter = getEditor(fixture.componentInstance);
    expect(editorAfter).toBe(editorBefore);
    expect(fixture.nativeElement.textContent).toContain(otherNote.content);
  });
});
