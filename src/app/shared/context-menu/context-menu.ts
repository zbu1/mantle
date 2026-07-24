import { Component, ElementRef, HostListener, computed, inject, viewChild } from '@angular/core';
import {
  LucideCopy,
  LucideCopyPlus,
  LucideFileText,
  LucidePencil,
  LucideSquarePlus,
  LucideStar,
  LucideStarOff,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { ContextMenuState } from './context-menu-state';
import { ContextMenuAction } from './context-menu.model';

const MENU_WIDTH = 224;
const ITEM_HEIGHT = 28;
const SEPARATOR_HEIGHT = 9;
const MENU_PADDING = 8;
const VIEWPORT_MARGIN = 8;

@Component({
  selector: 'app-context-menu',
  imports: [LucideFileText, LucideSquarePlus, LucideCopy, LucidePencil, LucideCopyPlus, LucideStar, LucideStarOff, LucideX, LucideTrash2],
  templateUrl: './context-menu.html',
})
export class ContextMenu {
  private readonly state = inject(ContextMenuState);

  protected readonly menu = this.state.menu;

  protected readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

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

  @HostListener('window:blur')
  protected onBlur(): void {
    this.state.close();
  }

  protected select(item: ContextMenuAction): void {
    item.action();
    this.state.close();
  }
}
