import { Component, input, output } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';

/**
 * The header row of an expandable sidebar entry — a rotating chevron, an
 * icon slot, a label, optional trailing content, and an optional external
 * action button — shared by the vault tree's folders, credential profiles,
 * and tag groups.
 *
 * Expansion state lives with the caller rather than in here: the vault tree
 * swaps this row out for a rename input while keeping the same expanded
 * state, which isn't possible if this component owned it.
 */
@Component({
  selector: 'app-explorer-row',
  imports: [LucideChevronRight],
  templateUrl: './explorer-row.html',
  host: { class: 'contents' },
})
export class ExplorerRow {
  readonly label = input.required<string>();
  readonly depth = input(0);
  readonly expanded = input(false);
  readonly draggable = input(false);

  readonly toggle = output<void>();
  readonly headerContextMenu = output<MouseEvent>();
  readonly headerDragStart = output<DragEvent>();

  protected onContextMenu(event: MouseEvent): void {
    this.headerContextMenu.emit(event);
  }

  protected onDragStart(event: DragEvent): void {
    this.headerDragStart.emit(event);
  }
}
