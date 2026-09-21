import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { EditorView } from 'prosemirror-view';
import { NoteEditor } from './note-editor';
import { NotesState } from '../notes-state';
import { EditorFocusState } from './editor-focus-state';
import { VaultState } from '../vault-state';
import { flushAsync, installMockVaultInvoke } from '../../../testing/mock-vault';
import { parseMarkdown } from './prosemirror/markdown-converter';

function getEditorView(component: NoteEditor): EditorView {
  return (component as unknown as { editorView: EditorView }).editorView;
}

describe('NoteEditor', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [NoteEditor],
      providers: [provideZonelessChangeDetection()],
    });
    installMockVaultInvoke();
    TestBed.inject(VaultState).rootPath.set('/fake/vault');
  });

  it('renders the loaded note content', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
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
    await flushAsync();
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
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    const notesState = TestBed.inject(NotesState);
    const viewBefore = getEditorView(fixture.componentInstance);

    fixture.componentRef.setInput('noteId', 'architecture-notes');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    const otherNote = notesState.getNote('architecture-notes')!;
    const viewAfter = getEditorView(fixture.componentInstance);
    expect(viewAfter).toBe(viewBefore);
    expect(fixture.nativeElement.textContent).toContain(otherNote.content);
  });

  /** Mounts the editor on `daily-standup` inside the document (focus needs a connected element) and lets it load. */
  async function mountEditor() {
    const fixture = TestBed.createComponent(NoteEditor);
    document.body.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('noteId', 'daily-standup');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it('takes focus once its content is in, when asked to for that note', async () => {
    TestBed.inject(EditorFocusState).request('daily-standup');
    const fixture = await mountEditor();

    expect(fixture.nativeElement.querySelector('.ProseMirror')).toBe(document.activeElement);
    fixture.nativeElement.remove();
  });

  it('leaves focus alone when it was not asked to take it', async () => {
    const fixture = await mountEditor();

    expect(fixture.nativeElement.querySelector('.ProseMirror')).not.toBe(document.activeElement);
    fixture.nativeElement.remove();
  });

  it('does not steal focus for a note other than the one it was asked about', async () => {
    TestBed.inject(EditorFocusState).request('architecture-notes');
    const fixture = await mountEditor();

    expect(fixture.nativeElement.querySelector('.ProseMirror')).not.toBe(document.activeElement);
    fixture.nativeElement.remove();
  });
});
