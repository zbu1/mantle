import { Injectable, signal } from '@angular/core';

/** Drives the single Quick Switcher overlay, rendered once at the layout root (see `Dialog`/`DialogState` for the same pattern). */
@Injectable({ providedIn: 'root' })
export class QuickSwitcherState {
  readonly isOpen = signal(false);
  readonly query = signal('');

  open(): void {
    this.query.set('');
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }
}
