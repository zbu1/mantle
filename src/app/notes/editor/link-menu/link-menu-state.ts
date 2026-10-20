import { Injectable, computed, signal } from '@angular/core';

/** A note the `[[` menu offers to link to. */
export interface LinkSuggestion {
  relPath: string;
  name: string;
  /** Its folder, to tell apart notes with the same name. */
  dir: string;
  /** What goes between the brackets. */
  link: string;
  /**
   * The target is encrypted (or hidden) while the note being edited isn't,
   * so the link's text would sit in plaintext beside it.
   */
  exposes: boolean;
}

/** The `[[` link menu's items and highlighted row, shared by the editor's plugin and the `LinkMenu` panel. */
@Injectable({ providedIn: 'root' })
export class LinkMenuState {
  readonly items = signal<LinkSuggestion[]>([]);
  readonly selectedIndex = signal(0);
  readonly selected = computed<LinkSuggestion | undefined>(() => this.items()[this.selectedIndex()]);

  private confirm: ((item: LinkSuggestion) => void) | undefined;

  show(items: LinkSuggestion[], confirm: (item: LinkSuggestion) => void): void {
    const keep = this.selected()?.relPath;
    this.items.set(items);
    this.selectedIndex.set(Math.max(0, items.findIndex((item) => item.relPath === keep)));
    this.confirm = confirm;
  }

  moveSelection(delta: number): void {
    const count = this.items().length;
    if (count > 0) this.selectedIndex.update((index) => (index + delta + count) % count);
  }

  select(item: LinkSuggestion): void {
    this.confirm?.(item);
  }

  hide(): void {
    this.items.set([]);
    this.selectedIndex.set(0);
    this.confirm = undefined;
  }
}
