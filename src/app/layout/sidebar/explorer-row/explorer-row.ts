import { Component, input, output } from '@angular/core';
import { LucideChevronRight } from '@lucide/angular';
import { HoverTooltip } from '../../../shared/hover-tooltip/hover-tooltip';

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
  imports: [LucideChevronRight, HoverTooltip],
  templateUrl: './explorer-row.html',
  host: { class: 'contents' },
})
export class ExplorerRow {
  readonly label = input.required<string>();
  readonly depth = input(0);
  /** Left padding at depth 0, and per level of depth. */
  readonly baseIndent = input(24);
  readonly indentStep = input(16);
  /** A heavier label, for rows that carry structure (vault folders) rather than items. */
  readonly strong = input(false);
  readonly expanded = input(false);
  readonly draggable = input(false);
  /** Part of a multi-selection in the vault tree: the same faint fill as a selected note. */
  readonly selected = input(false);

  /** Click, Enter or Space on the row; the vault tree reads click modifiers off the event. */
  readonly toggle = output<Event>();
  readonly headerContextMenu = output<MouseEvent>();
  readonly headerDragStart = output<DragEvent>();

  protected onContextMenu(event: MouseEvent): void {
    this.headerContextMenu.emit(event);
  }

  protected onDragStart(event: DragEvent): void {
    this.headerDragStart.emit(event);
  }

  /** Space normally scrolls the page; the row's own role="button" needs it to toggle instead. */
  protected onSpaceKey(event: Event): void {
    event.preventDefault();
    this.toggle.emit(event);
  }
}
