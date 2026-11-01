import { Injectable, signal } from '@angular/core';

/** Asks the active note to open its find bar, from outside the content area (menus, the command palette). */
@Injectable({ providedIn: 'root' })
export class FindRequestState {
  readonly request = signal<{ replace: boolean; n: number } | null>(null);
  private n = 0;

  open(replace: boolean): void {
    this.request.set({ replace, n: ++this.n });
  }
}
