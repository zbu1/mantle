import { Component, computed, inject, input } from '@angular/core';
import { TabLayout, TabPane, TabSplit, TabsState } from '../../notes/tabs-state';
import { ContentArea } from '../content/content-area/content-area';
import { TAB_DRAG_MIME, TabStrip } from '../tab-strip/tab-strip';

/** Smallest share a pane can be dragged down to. */
const MIN_SHARE = 0.1;

/**
 * The editor area, split into panes as `TabsState.layout` says: a pane is a
 * `ContentArea` (with its own tab strip once there's more than one), a split
 * lays its children out side by side or stacked, with a divider between each
 * two to resize them. Nests to any depth by rendering itself.
 */
@Component({
  selector: 'app-pane-layout',
  imports: [ContentArea, TabStrip],
  host: { class: 'block h-full min-h-0 min-w-0' },
  template: `
    @if (pane(); as pane) {
      <div class="flex h-full min-h-0 min-w-0 flex-col" (pointerdown)="tabsState.focusPane(pane.id)"
        (focusin)="tabsState.focusPane(pane.id)" (dragover)="onDragOver($event)" (drop)="onDrop($event, pane)">
        @if (tabsState.split()) {
          <app-tab-strip [paneId]="pane.id" class="h-9 shrink-0 overflow-x-auto border-b border-border px-1"
            [class.bg-surface]="tabsState.activePaneId() !== pane.id" />
        }
        <app-content-area [paneId]="pane.id" class="block min-h-0 flex-1" />
      </div>
    } @else if (split(); as split) {
      <div #container class="flex h-full min-h-0 min-w-0" [class.flex-col]="split.direction === 'column'">
        @for (child of split.children; track child.id; let i = $index) {
          @if (i > 0) {
            <div role="separator" [attr.aria-orientation]="split.direction === 'row' ? 'vertical' : 'horizontal'"
              (pointerdown)="startResize($event, split, i, container)"
              class="shrink-0 bg-border transition-colors hover:bg-primary/60"
              [class.w-px]="split.direction === 'row'" [class.cursor-col-resize]="split.direction === 'row'"
              [class.h-px]="split.direction === 'column'" [class.cursor-row-resize]="split.direction === 'column'"
              [style.margin]="split.direction === 'row' ? '0 2px' : '2px 0'"></div>
          }
          <div class="min-h-0 min-w-0 overflow-hidden" [style.flex]="split.sizes[i] + ' 1 0'">
            <app-pane-layout [node]="child" />
          </div>
        }
      </div>
    }
  `,
})
export class PaneLayout {
  protected readonly tabsState = inject(TabsState);

  readonly node = input.required<TabLayout>();

  protected readonly pane = computed(() => {
    const node = this.node();
    return node.kind === 'pane' ? (node as TabPane) : null;
  });
  protected readonly split = computed(() => {
    const node = this.node();
    return node.kind === 'split' ? (node as TabSplit) : null;
  });

  /** A tab dragged onto a pane's body moves to the end of its strip. */
  protected onDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes(TAB_DRAG_MIME)) event.preventDefault();
  }

  protected onDrop(event: DragEvent, pane: TabPane): void {
    const tabId = event.dataTransfer?.getData(TAB_DRAG_MIME);
    if (!tabId) return;
    event.preventDefault();
    this.tabsState.moveTab(tabId, pane.id, pane.tabIds.length);
  }

  /** Drags the divider before child `index`, trading share between it and the child before. */
  protected startResize(event: PointerEvent, split: TabSplit, index: number, container: HTMLElement): void {
    event.preventDefault();
    const row = split.direction === 'row';
    const box = container.getBoundingClientRect();
    const total = row ? box.width : box.height;
    const start = row ? event.clientX : event.clientY;
    const sizes = [...split.sizes];
    const pair = sizes[index - 1] + sizes[index];
    const move = (e: PointerEvent) => {
      const delta = ((row ? e.clientX : e.clientY) - start) / (total || 1);
      const before = Math.min(Math.max(sizes[index - 1] + delta, MIN_SHARE), pair - MIN_SHARE);
      const next = [...sizes];
      next[index - 1] = before;
      next[index] = pair - before;
      this.tabsState.resize(split.id, next);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }
}
