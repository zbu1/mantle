import { Injectable, signal } from '@angular/core';
import { Note } from './note.model';
import { MOCK_NOTES } from './notes-data';

function seedNotes(): Record<string, Note> {
  return Object.fromEntries(MOCK_NOTES.map((note) => [note.id, note]));
}

@Injectable({ providedIn: 'root' })
export class NotesState {
  private readonly notes = signal<Record<string, Note>>(seedNotes());

  getNote(id: string): Note | undefined {
    return this.notes()[id];
  }

  updateContent(id: string, content: string): void {
    this.notes.update((notes) => {
      const note = notes[id];
      if (!note || note.content === content) return notes;
      return { ...notes, [id]: { ...note, content } };
    });
  }
}
