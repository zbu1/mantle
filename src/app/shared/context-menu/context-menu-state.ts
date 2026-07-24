import { Injectable, signal } from '@angular/core';
import { ContextMenuItem } from './context-menu.model';

export interface ContextMenuPosition {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

@Injectable({ providedIn: 'root' })
export class ContextMenuState {
  readonly menu = signal<ContextMenuPosition | null>(null);

  open(event: MouseEvent, items: ContextMenuItem[]): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ x: event.clientX, y: event.clientY, items });
  }

  close(): void {
    this.menu.set(null);
  }
}
