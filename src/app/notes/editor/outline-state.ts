import { Injectable, signal } from '@angular/core';
import { EditorView } from 'prosemirror-view';
import { OutlineHeading, goToHeading, outline } from './prosemirror/outline';

/** The headings of the note in the editor last focused or switched to, for the sidebar's Outline. */
@Injectable({ providedIn: 'root' })
export class OutlineState {
  private view: EditorView | null = null;
  readonly headings = signal<OutlineHeading[]>([]);

  /** `view` is now the editor to outline. */
  show(view: EditorView): void {
    this.view = view;
    this.headings.set(outline(view.state.doc));
  }

  /** `view`'s doc changed. */
  changed(view: EditorView): void {
    if (view === this.view) this.headings.set(outline(view.state.doc));
  }

  /** `view` is going away. */
  forget(view: EditorView): void {
    if (view !== this.view) return;
    this.view = null;
    this.headings.set([]);
  }

  go(heading: OutlineHeading): void {
    if (this.view) goToHeading(this.view, heading.pos);
  }
}
