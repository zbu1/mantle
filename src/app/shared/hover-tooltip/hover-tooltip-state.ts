import { Injectable, signal } from '@angular/core';

export interface HoverTooltipContent {
  label: string;
  sublabel: string | null;
  /** Bounding rect of the hovered element — only its vertical center is used, to line the tooltip up with the row. */
  anchor: DOMRect;
}

/**
 * Backs the single global tooltip rendered by `HoverTooltipHost`. Its
 * vertical position tracks the hovered element, but it always sits pinned at
 * the sidebar/editor boundary (registered once by `MainLayout`) rather than
 * next to the hovered element itself — so it reads consistently regardless
 * of how deeply nested the hovered row is, and isn't clipped by the
 * sidebar's `overflow-y-auto` scroll container.
 */
@Injectable({ providedIn: 'root' })
export class HoverTooltipState {
  readonly content = signal<HoverTooltipContent | null>(null);

  private editorBoundary: HTMLElement | null = null;

  registerEditorBoundary(el: HTMLElement): void {
    this.editorBoundary = el;
  }

  /** Left edge of the editor, i.e. the sidebar/editor border — read fresh each time so sidebar resizes are reflected. */
  editorBoundaryLeft(): number {
    return this.editorBoundary?.getBoundingClientRect().left ?? 0;
  }

  show(anchor: DOMRect, label: string, sublabel: string | null): void {
    this.content.set({ anchor, label, sublabel });
  }

  hide(): void {
    this.content.set(null);
  }
}
