import { Component, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, inject, input, signal, viewChild } from '@angular/core';
import { LucideChevronLeft, LucideChevronRight, LucideX } from '@lucide/angular';
import { TabMenu } from '../../notes/tab-menu';
import { NoteTab, TabsState } from '../../notes/tabs-state';

/** dataTransfer type of a tab being dragged, holding its id. */
export const TAB_DRAG_MIME = 'application/x-mantle-tab';

/**
 * One pane's tabs: click to show, drag to reorder or into another pane's
 * strip, right-click for the tab menu. The header shows the only pane's;
 * once the editor area is split, each pane shows its own. Tabs that don't
 * fit scroll sideways (the wheel scrolls them too), with a button at each end.
 */
@Component({
  selector: 'app-tab-strip',
  imports: [LucideChevronLeft, LucideChevronRight, LucideX],
  host: {
    class: 'flex min-w-0 items-stretch gap-1',
    '(dragover)': 'onDragOver($event, tabs().length)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
  template: `
    @if (overflowing()) {
      <button type="button" title="Scroll tabs left" [disabled]="!canScrollLeft()" (click)="scrollBy(-1)"
        class="my-1 flex w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background/60 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent [app-region:no-drag]">
        <svg lucideChevronLeft [size]="14"></svg>
      </button>
    }
    <div #scroller (scroll)="measure()" (wheel)="onWheel($event)"
      class="flex min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
    <div #content class="flex w-max items-stretch gap-1">
    @for (tab of tabs(); track tab.id; let i = $index) {
      @let active = tab.id === activeTabId();
      <button type="button" draggable="true" (dragstart)="onDragStart($event, tab)" (dragend)="dropIndex.set(null)"
        (dragover)="onDragOver($event, i, $event.currentTarget)" (click)="tabsState.setActive(tab.id)"
        (auxclick)="$event.button === 1 && tabsState.closeTab(tab.id)" (contextmenu)="tabMenu.open($event, tab)"
        [title]="tab.missing ? tab.title + ' (file not found, moved or deleted outside Mantle)' : tab.title"
        class="group my-1 flex min-w-0 max-w-48 shrink-0 items-center gap-2 rounded-md border border-input px-3 text-xs [app-region:no-drag]"
        [class.bg-background]="active" [class.text-foreground]="active" [class.tab-active-rule]="active && paneActive()"
        [class.text-muted-foreground]="!active" [class.hover:bg-background/60]="!active" [class.opacity-60]="tab.missing"
        [style.box-shadow]="dropIndex() === i ? 'inset 2px 0 0 var(--primary)' : null">
        <span class="min-w-0 flex-1 truncate text-left" [class.line-through]="tab.missing">{{ tab.title }}</span>
        <span (click)="close($event, tab.id)"
          class="flex shrink-0 items-center justify-center rounded p-0.5 opacity-0 hover:bg-border group-hover:opacity-100">
          <svg lucideX [size]="12"></svg>
        </span>
      </button>
    }
    <span class="w-1 shrink-0 self-stretch rounded" [class.bg-primary]="dropIndex() === tabs().length"></span>
    </div>
    </div>
    @if (overflowing()) {
      <button type="button" title="Scroll tabs right" [disabled]="!canScrollRight()" (click)="scrollBy(1)"
        class="my-1 flex w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background/60 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent [app-region:no-drag]">
        <svg lucideChevronRight [size]="14"></svg>
      </button>
    }
  `,
})
export class TabStrip {
  protected readonly tabsState = inject(TabsState);
  protected readonly tabMenu = inject(TabMenu);

  readonly paneId = input.required<string>();

  protected readonly tabs = computed(() => this.tabsState.tabsOf(this.paneId()));
  protected readonly activeTabId = computed(() => this.tabsState.panes().find((p) => p.id === this.paneId())?.activeTabId);
  protected readonly paneActive = computed(() => this.tabsState.activePaneId() === this.paneId() || !this.tabsState.split());
  /** Where a dragged tab would land. */
  protected readonly dropIndex = signal<number | null>(null);

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly content = viewChild.required<ElementRef<HTMLElement>>('content');
  protected readonly canScrollLeft = signal(false);
  protected readonly canScrollRight = signal(false);
  protected readonly overflowing = computed(() => this.canScrollLeft() || this.canScrollRight());

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const observer = new ResizeObserver(() => this.measure());
      observer.observe(this.scroller().nativeElement);
      observer.observe(this.content().nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
    // Keep the active tab in view, e.g. one just opened past the right edge.
    afterRenderEffect(() => {
      const id = this.activeTabId();
      const index = this.tabs().findIndex((t) => t.id === id);
      this.content().nativeElement.children[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  protected measure(): void {
    const el = this.scroller().nativeElement;
    this.canScrollLeft.set(el.scrollLeft > 0);
    this.canScrollRight.set(Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth);
  }

  protected scrollBy(direction: number): void {
    const el = this.scroller().nativeElement;
    el.scrollBy({ left: direction * el.clientWidth * 0.75, behavior: 'smooth' });
  }

  /** A vertical wheel scrolls the strip sideways. */
  protected onWheel(event: WheelEvent): void {
    if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    this.scroller().nativeElement.scrollLeft += event.deltaY;
  }

  protected close(event: Event, id: string): void {
    event.stopPropagation();
    this.tabsState.closeTab(id);
  }

  protected onDragStart(event: DragEvent, tab: NoteTab): void {
    event.dataTransfer?.setData(TAB_DRAG_MIME, tab.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  /** Over a tab, the drop lands before or after it by which half the pointer is in; elsewhere, at the end. */
  protected onDragOver(event: DragEvent, index: number, over?: EventTarget | null): void {
    if (!event.dataTransfer?.types.includes(TAB_DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    if (over instanceof HTMLElement) {
      const box = over.getBoundingClientRect();
      if (event.clientX > box.left + box.width / 2) index++;
    }
    this.dropIndex.set(index);
  }

  protected onDragLeave(event: DragEvent): void {
    const host = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))) this.dropIndex.set(null);
  }

  protected onDrop(event: DragEvent): void {
    const tabId = event.dataTransfer?.getData(TAB_DRAG_MIME);
    const index = this.dropIndex();
    this.dropIndex.set(null);
    if (!tabId || index === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.tabsState.moveTab(tabId, this.paneId(), index);
  }
}
