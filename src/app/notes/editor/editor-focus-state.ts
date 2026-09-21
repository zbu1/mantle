import { Injectable } from '@angular/core';

/**
 * Lets code that opens a note ask for its editor to take keyboard focus once
 * it has rendered.
 *
 * The request outlives the call because the editor isn't there yet when the
 * note is opened: it's created (or re-pointed) on the next change-detection
 * pass, and only fills in once the note's content has loaded. A plain field
 * rather than a signal — the editor already reruns when the note loads, and
 * this only needs to be there when it does.
 */
@Injectable({ providedIn: 'root' })
export class EditorFocusState {
  private pendingNoteId: string | null = null;

  request(noteId: string): void {
    this.pendingNoteId = noteId;
  }

  /** True, once, if `noteId`'s editor was asked to take focus. */
  consume(noteId: string): boolean {
    if (this.pendingNoteId !== noteId) return false;
    this.pendingNoteId = null;
    return true;
  }
}
