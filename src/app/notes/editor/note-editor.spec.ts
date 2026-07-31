import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { EditorView } from 'prosemirror-view';
import { NoteEditor } from './note-editor';
import { NotesState } from '../notes-state';
import { parseMarkdown } from './prosemirror/markdown-converter';

function getEditorView(component: NoteEditor): EditorView {
  return (component as unknown as { editorView: EditorView }).editorView;
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

  it('saves edits back into NotesState through transaction', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup');
    fixture.detectChanges();
    await fixture.whenStable();

    const notesState = TestBed.inject(NotesState);
    const view = getEditorView(fixture.componentInstance);

    const newDoc = parseMarkdown('Updated content');
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc);
    view.dispatch(tr);

    expect(notesState.getNote('daily-standup')?.content.trim()).toBe('Updated content');
  });

  it('swaps content when noteId changes without recreating the editor view', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup');
    fixture.detectChanges();
    await fixture.whenStable();

    const notesState = TestBed.inject(NotesState);
    const viewBefore = getEditorView(fixture.componentInstance);
    const otherNote = notesState.getNote('architecture-notes')!;

    fixture.componentRef.setInput('noteId', 'architecture-notes');
    fixture.detectChanges();
    await fixture.whenStable();

    const viewAfter = getEditorView(fixture.componentInstance);
    expect(viewAfter).toBe(viewBefore);
    expect(fixture.nativeElement.textContent).toContain(otherNote.content);
  });
});
