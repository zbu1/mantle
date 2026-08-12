import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import {
  LucideClipboardPaste,
  LucideCopy,
  LucideCopyPlus,
  LucideFileText,
  LucideFolderOpen,
  LucidePencil,
  LucideScissors,
  LucideSquarePlus,
  LucideStar,
  LucideStarOff,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { MenuItem } from '../menu/menu-item';
import { MenuSeparator } from '../menu/menu-separator';
import { MenuSurface } from '../menu/menu-surface';
import { ContextMenuState } from './context-menu-state';
import { ContextMenuAction } from './context-menu.model';

// Matches the w-56 on MenuSurface.
const MENU_WIDTH = 224;
const ITEM_HEIGHT = 28;
const SEPARATOR_HEIGHT = 9;
const MENU_PADDING = 8;
const VIEWPORT_MARGIN = 8;

@Component({
  selector: 'app-context-menu',
  imports: [
    MenuSurface,
    MenuItem,
    MenuSeparator,
    LucideFileText,
    LucideSquarePlus,
    LucideCopy,
    LucideScissors,
    LucideClipboardPaste,
    LucideFolderOpen,
    LucidePencil,
    LucideCopyPlus,
    LucideStar,
    LucideStarOff,
    LucideX,
    LucideTrash2,
  ],
  templateUrl: './context-menu.html',
})
export class ContextMenu {
  private readonly state = inject(ContextMenuState);

  protected readonly menu = this.state.menu;

  // Drives row highlighting in place of CSS `:hover` — see MenuItem.active.
  // Shared between mouse (hover) and keyboard (arrow keys) so only one row
  // is ever highlighted. Reset whenever a new (or no) menu is shown, so a
  // stale index from the last menu can't spuriously highlight a row.
  protected readonly selectedIndex = signal<number | null>(null);
  private readonly resetSelectionOnMenuChange = effect(() => {
    this.menu();
    this.selectedIndex.set(null);
  });

  // Indices of the selectable (non-separator, non-disabled) rows in the current menu, in order.
  private readonly actionIndices = computed(() =>
    (this.menu()?.items ?? []).reduce<number[]>((acc, item, i) => {
      if (item.kind === 'item' && !item.disabled) acc.push(i);
      return acc;
    }, []),
  );

  // #panel is an <app-menu-surface>, so read its host element rather than the
  // component instance — the pointerdown guard below needs to hit-test the DOM.
  protected readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });

  protected readonly style = computed(() => {
    const menu = this.menu();
    if (!menu) return {};

    const height =
      menu.items.reduce((sum, item) => sum + (item.kind === 'separator' ? SEPARATOR_HEIGHT : ITEM_HEIGHT), 0) + MENU_PADDING;

    const fitsRight = menu.x + MENU_WIDTH + VIEWPORT_MARGIN <= window.innerWidth;
    const x = fitsRight ? menu.x : menu.x - MENU_WIDTH;

    const fitsBelow = menu.y + height + VIEWPORT_MARGIN <= window.innerHeight;
    const y = fitsBelow ? menu.y : menu.y - height;

    return {
      left: `${Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN))}px`,
      top: `${Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - height - VIEWPORT_MARGIN))}px`,
    };
  });

  @HostListener('document:contextmenu', ['$event'])
  protected onDocumentContextMenu(event: MouseEvent): void {
    // Suppresses the native context menu anywhere that hasn't wired up a
    // custom one; handled targets already call preventDefault/stopPropagation
    // in ContextMenuState.open, so this only fires for unhandled areas.
    event.preventDefault();
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    const panel = this.panel()?.nativeElement;
    if (panel && event.target instanceof Node && panel.contains(event.target)) return;
    this.state.close();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.state.close();
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (!this.menu()) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveSelection(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelection(-1);
      return;
    }

    if (event.key === 'Enter') {
      const index = this.selectedIndex();
      const item = index === null ? undefined : this.menu()?.items[index];
      if (item?.kind !== 'item') return;
      event.preventDefault();
      this.select(item);
    }
  }

  @HostListener('window:blur')
  protected onBlur(): void {
    this.state.close();
  }

  private moveSelection(delta: number): void {
    const indices = this.actionIndices();
    if (indices.length === 0) return;

    const current = this.selectedIndex();
    if (current === null) {
      this.selectedIndex.set(delta > 0 ? indices[0] : indices[indices.length - 1]);
      return;
    }

    const currentPos = indices.indexOf(current);
    const nextPos = (currentPos + delta + indices.length) % indices.length;
    this.selectedIndex.set(indices[nextPos]);
  }

  protected select(item: ContextMenuAction): void {
    item.action();
    this.state.close();
  }
}
