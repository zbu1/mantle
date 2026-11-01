import { Injectable, signal } from '@angular/core';

type Resolve = (choice: string | null | undefined) => void;

/** Opens the icon or color picker (`ItemStylePicker`, rendered once at the layout root). */
@Injectable({ providedIn: 'root' })
export class ItemStylePickerState {
  readonly kind = signal<'icon' | 'color' | null>(null);
  private resolve: Resolve | null = null;

  /** Resolves to the chosen name, null for "remove", or undefined when dismissed. */
  pick(kind: 'icon' | 'color'): Promise<string | null | undefined> {
    this.dismiss();
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.kind.set(kind);
    });
  }

  choose(choice: string | null): void {
    this.close(choice);
  }

  dismiss(): void {
    this.close(undefined);
  }

  private close(choice: string | null | undefined): void {
    this.resolve?.(choice);
    this.resolve = null;
    this.kind.set(null);
  }
}
