import { Injectable, signal } from '@angular/core';
import { isMobile } from '../../core/tauri-env';
import { ContextMenuHeader, ContextMenuItem } from './context-menu.model';

/** `items` less the desktop-only ones, and less the separators that leaves doubled or at an end. */
export function withoutDesktopOnly(items: ContextMenuItem[]): ContextMenuItem[] {
  const kept = items.filter((item) => !(item.kind === 'item' && item.desktopOnly));
  return kept.filter(
    (item, i) => item.kind !== 'separator' || (i > 0 && i < kept.length - 1 && kept[i + 1].kind !== 'separator'),
  );
}

export interface ContextMenuPosition {
  x: number;
  y: number;
  items: ContextMenuItem[];
  header: ContextMenuHeader | null;
}

@Injectable({ providedIn: 'root' })
export class ContextMenuState {
  readonly menu = signal<ContextMenuPosition | null>(null);

  open(event: MouseEvent, items: ContextMenuItem[], header: ContextMenuHeader | null = null): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ x: event.clientX, y: event.clientY, items: isMobile ? withoutDesktopOnly(items) : items, header: isMobile ? header : null });
  }

  close(): void {
    this.menu.set(null);
  }
}
