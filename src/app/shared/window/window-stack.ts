import { Injectable, signal } from '@angular/core';

/**
 * Floating windows sit above the app but below dialogs, menus and tooltips,
 * which are all `z-50`.
 */
const BASE_Z_INDEX = 30;

/**
 * Coordinates the floating `Window`s that can be open at once: which is in
 * front, and which bottom-right dock slot each minimized one occupies so they
 * stack up instead of covering each other.
 */
@Injectable({ providedIn: 'root' })
export class WindowStack {
  private readonly order = signal<string[]>([]);
  private readonly docked = signal<string[]>([]);

  raise(id: string): void {
    this.order.update((order) => (order[order.length - 1] === id ? order : [...order.filter((x) => x !== id), id]));
  }

  zIndex(id: string): number {
    return BASE_Z_INDEX + Math.max(0, this.order().indexOf(id));
  }

  dock(id: string): void {
    this.docked.update((docked) => (docked.includes(id) ? docked : [...docked, id]));
  }

  undock(id: string): void {
    this.docked.update((docked) => docked.filter((x) => x !== id));
  }

  /** 0 for the first minimized window (nearest the corner), 1 for the next, ... */
  dockSlot(id: string): number {
    return Math.max(0, this.docked().indexOf(id));
  }
}
