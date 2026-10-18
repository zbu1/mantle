import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { EditorView } from 'prosemirror-view';
import { NoteEditor, countText } from './note-editor';
import { undoDepth } from 'prosemirror-history';
import { NotePropertiesState } from '../note-properties-state';
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
    fixture.componentRef.setInput('noteId', 'daily-standup.mntl');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    const notesState = TestBed.inject(NotesState);
    const note = notesState.getNote('daily-standup.mntl')!;

    expect(fixture.nativeElement.querySelector('.ProseMirror')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain(note.content);
  });

  it('puts tag and property edits in its own undo history, but not loading the note', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup.mntl');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();

    const notesState = TestBed.inject(NotesState);
    const properties = TestBed.inject(NotePropertiesState);
    const view = getEditorView(fixture.componentInstance);
    expect(undoDepth(view.state)).toBe(0);

    properties.setProperties('daily-standup.mntl', [{ key: 'due', value: '2026-10-17' }]);
    properties.setTags('daily-standup.mntl', ['work']);
    expect(notesState.getNote('daily-standup.mntl')?.properties).toEqual([{ key: 'due', value: '2026-10-17' }]);
    expect(notesState.getNote('daily-standup.mntl')?.tags).toEqual(['work']);

    properties.undo('daily-standup.mntl');
    expect(notesState.getNote('daily-standup.mntl')?.tags).toEqual(['work', 'urgent']);
    properties.undo('daily-standup.mntl');
    expect(notesState.getNote('daily-standup.mntl')?.properties).toEqual([]);
    properties.redo('daily-standup.mntl');
    expect(notesState.getNote('daily-standup.mntl')?.properties).toEqual([{ key: 'due', value: '2026-10-17' }]);
  });

  it('shows tags changed elsewhere without making them an undo step', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup.mntl');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();

    TestBed.inject(NotesState).retagLoaded('work', 'job');
    fixture.detectChanges();
    await fixture.whenStable();

    const view = getEditorView(fixture.componentInstance);
    expect(view.state.doc.attrs['tags']).toEqual(['job', 'urgent']);
    expect(undoDepth(view.state)).toBe(0);
  });

  it('saves edits back into NotesState through transaction', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup.mntl');
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

    expect(notesState.getNote('daily-standup.mntl')?.content.trim()).toBe('Updated content');
  });

  it('swaps content when noteId changes without recreating the editor view', async () => {
    const fixture = TestBed.createComponent(NoteEditor);
    fixture.componentRef.setInput('noteId', 'daily-standup.mntl');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    const notesState = TestBed.inject(NotesState);
    const viewBefore = getEditorView(fixture.componentInstance);

    fixture.componentRef.setInput('noteId', 'architecture-notes.mntl');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();

    const otherNote = notesState.getNote('architecture-notes.mntl')!;
    const viewAfter = getEditorView(fixture.componentInstance);
    expect(viewAfter).toBe(viewBefore);
    expect(fixture.nativeElement.textContent).toContain(otherNote.content);
  });

  /** Mounts the editor on `daily-standup` inside the document (focus needs a connected element) and lets it load. */
  async function mountEditor() {
    const fixture = TestBed.createComponent(NoteEditor);
    document.body.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('noteId', 'daily-standup.mntl');
    fixture.detectChanges();
    await fixture.whenStable();
    await flushAsync();
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it('takes focus once its content is in, when asked to for that note', async () => {
    TestBed.inject(EditorFocusState).request('daily-standup.mntl');
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
    TestBed.inject(EditorFocusState).request('architecture-notes.mntl');
    const fixture = await mountEditor();

    expect(fixture.nativeElement.querySelector('.ProseMirror')).not.toBe(document.activeElement);
    fixture.nativeElement.remove();
  });
});

describe('countText', () => {
  it('counts the rendered text, not the Markdown, and skips whitespace in characters', () => {
    expect(countText(parseMarkdown('**bold** and *it*'))).toEqual({ words: 3, characters: 9 });
    expect(countText(parseMarkdown('# One\n\ntwo\n\n```\nthree four\n```'))).toEqual({ words: 4, characters: 15 });
    expect(countText(parseMarkdown(''))).toEqual({ words: 0, characters: 0 });
  });
});
