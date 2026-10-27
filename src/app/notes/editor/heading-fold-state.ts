import { Injectable, effect, inject, signal } from '@angular/core';
import { TabsState } from '../tabs-state';

/** A note's folded headings, by their index among its top-level headings, and the Markdown they were counted in. */
export interface NoteFolds {
  headings: number[];
  markdown: string;
}

/**
 * Which headings are folded in each open note. In memory only: every tab and
 * pane showing a note shares its folds, and they're forgotten once the note's
 * last tab closes.
 */
@Injectable({ providedIn: 'root' })
export class HeadingFoldState {
  private readonly tabsState = inject(TabsState);

  readonly folds = signal<ReadonlyMap<string, NoteFolds>>(new Map());

  constructor() {
    effect(() => {
      const open = new Set(this.tabsState.tabs().map((tab) => tab.noteId));
      const folds = this.folds();
      if ([...folds.keys()].every((noteId) => open.has(noteId))) return;
      this.folds.set(new Map([...folds].filter(([noteId]) => open.has(noteId))));
    });
  }

  set(noteId: string, folds: NoteFolds): void {
    const current = this.folds().get(noteId);
    if (current?.markdown === folds.markdown && current.headings.join() === folds.headings.join()) return;
    this.folds.set(new Map(this.folds()).set(noteId, folds));
  }
}
