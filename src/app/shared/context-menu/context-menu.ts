import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, HostListener, WritableSignal, computed, effect, inject, signal, viewChild } from '@angular/core';
import {
  LucideCheck,
  LucideChevronRight,
  LucideClipboardPaste,
  LucideCopy,
  LucideFilePlus,
  LucideFolderPlus,
  LucideLock,
  LucideLockOpen,
  LucidePencil,
  LucideScissors,
  LucideStar,
  LucideStarOff,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { MenuItem } from '../menu/menu-item';
import { MenuSeparator } from '../menu/menu-separator';
import { MenuSurface } from '../menu/menu-surface';
import { ContextMenuState } from './context-menu-state';
import { ContextMenuAction, ContextMenuItem } from './context-menu.model';

// Matches the w-56 on MenuSurface.
const MENU_WIDTH = 224;
const ITEM_HEIGHT = 28;
const SEPARATOR_HEIGHT = 9;
const MENU_PADDING = 8;
const VIEWPORT_MARGIN = 8;
// Matches max-h-72 on a scrollable MenuSurface.
const SUBMENU_MAX_HEIGHT = 288;

/** Indices of the rows keyboard navigation can land on: not separators, not disabled. */
function selectableIndices(items: readonly ContextMenuItem[]): number[] {
  return items.reduce<number[]>((acc, item, i) => {
    if (item.kind === 'submenu' || (item.kind === 'item' && !item.disabled)) acc.push(i);
    return acc;
  }, []);
}

@Component({
  selector: 'app-context-menu',
  imports: [
    NgTemplateOutlet,
    MenuSurface,
    MenuItem,
    MenuSeparator,
    LucideCopy,
    LucideScissors,
    LucideClipboardPaste,
    LucideFilePlus,
    LucideFolderPlus,
    LucidePencil,
    LucideStar,
    LucideStarOff,
    LucideX,
    LucideTrash2,
    LucideCheck,
    LucideChevronRight,
    LucideLock,
    LucideLockOpen,
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
  /** The open submenu: which row it belongs to, and where it sits. */
  protected readonly submenu = signal<{ index: number; style: Record<string, string> } | null>(null);
  /** The highlighted row inside the submenu; non-null means the keyboard is in there. */
  protected readonly subIndex = signal<number | null>(null);
  private readonly resetSelectionOnMenuChange = effect(() => {
    this.menu();
    this.selectedIndex.set(null);
    this.submenu.set(null);
    this.subIndex.set(null);
  });

  protected readonly submenuItems = computed(() => {
    const open = this.submenu();
    const item = open && this.menu()?.items[open.index];
    return item?.kind === 'submenu' ? item.items : null;
  });

  // #panel is an <app-menu-surface>, so read its host element rather than the
  // component instance — the pointerdown guard below needs to hit-test the DOM.
  protected readonly panel = viewChild('panel', { read: ElementRef<HTMLElement> });
  protected readonly subPanel = viewChild('subPanel', { read: ElementRef<HTMLElement> });

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
    const inside = [this.panel(), this.subPanel()].some(
      (panel) => panel && event.target instanceof Node && panel.nativeElement.contains(event.target),
    );
    if (!inside) this.state.close();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.state.close();
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    const menu = this.menu();
    if (!menu) return;
    const subItems = this.submenuItems();
    const inSubmenu = subItems !== null && this.subIndex() !== null;
    const [items, selected] = inSubmenu ? [subItems, this.subIndex] : [menu.items, this.selectedIndex];

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelection(selected, selectableIndices(items), event.key === 'ArrowDown' ? 1 : -1);
      if (!inSubmenu) this.submenu.set(null);
      return;
    }

    if (event.key === 'ArrowLeft' && inSubmenu) {
      event.preventDefault();
      this.submenu.set(null);
      this.subIndex.set(null);
      return;
    }

    const index = selected();
    const item = index === null ? undefined : items[index];
    if (item?.kind === 'submenu' && (event.key === 'ArrowRight' || event.key === 'Enter')) {
      event.preventDefault();
      this.openSubmenu(index!, true);
      return;
    }
    if (event.key === 'Enter' && item?.kind === 'item') {
      event.preventDefault();
      this.select(item);
    }
  }

  /** The pointer moved onto row `index` of the main menu: highlight it, and open or close its submenu. */
  protected onHover(index: number): void {
    this.selectedIndex.set(index);
    if (this.menu()?.items[index]?.kind === 'submenu') this.openSubmenu(index, false);
    else this.submenu.set(null);
    this.subIndex.set(null);
  }

  /** Opens row `index`'s submenu beside it; `focus` moves the keyboard into it (ArrowRight / Enter). */
  protected openSubmenu(index: number, focus: boolean): void {
    const item = this.menu()?.items[index];
    const row = this.panel()?.nativeElement.children[index];
    if (item?.kind !== 'submenu' || !row) return;
    const rect = row.getBoundingClientRect();
    const height = Math.min(
      item.items.reduce((sum, sub) => sum + (sub.kind === 'separator' ? SEPARATOR_HEIGHT : ITEM_HEIGHT), 0) + MENU_PADDING,
      SUBMENU_MAX_HEIGHT,
    );
    const fitsRight = rect.right + MENU_WIDTH + VIEWPORT_MARGIN <= window.innerWidth;
    const left = fitsRight ? rect.right : rect.left - MENU_WIDTH;
    const top = Math.max(VIEWPORT_MARGIN, Math.min(rect.top - 4, window.innerHeight - height - VIEWPORT_MARGIN));
    if (this.submenu()?.index !== index) this.submenu.set({ index, style: { left: `${left}px`, top: `${top}px` } });
    this.selectedIndex.set(index);
    this.subIndex.set(focus ? (selectableIndices(item.items)[0] ?? null) : null);
  }

  @HostListener('window:blur')
  protected onBlur(): void {
    this.state.close();
  }

  private moveSelection(selected: WritableSignal<number | null>, indices: number[], delta: number): void {
    if (indices.length === 0) return;

    const current = selected();
    if (current === null) {
      selected.set(delta > 0 ? indices[0] : indices[indices.length - 1]);
      return;
    }

    const currentPos = indices.indexOf(current);
    const nextPos = (currentPos + delta + indices.length) % indices.length;
    selected.set(indices[nextPos]);
  }

  protected select(item: ContextMenuAction): void {
    item.action();
    this.state.close();
  }
}
