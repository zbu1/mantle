import { Component, computed, input, output } from '@angular/core';

const BASE = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs';

/**
 * A single row inside an <app-menu-surface>. Project the leading icon with the
 * `menuItemIcon` attribute, and an optional trailing indicator (e.g. a
 * checkmark on the active row) with `menuItemTrailing`:
 *
 *   <app-menu-item label="Delete" [danger]="true">
 *     <svg menuItemIcon lucideTrash2 [size]="14"></svg>
 *   </app-menu-item>
 */
@Component({
  selector: 'app-menu-item',
  template: `
    <button
      type="button"
      role="menuitem"
      [disabled]="disabled()"
      (click)="!disabled() && selected.emit()"
      (mouseenter)="!disabled() && hovered.emit()"
      [class]="buttonClass()"
    >
      <span class="flex size-3.5 shrink-0 items-center justify-center">
        <ng-content select="[menuItemIcon]" />
      </span>
      <span class="flex-1 truncate">{{ label() }}</span>
      @if (shortcut()) {
        <span class="shrink-0 text-[10px] tracking-wide text-muted-foreground">{{ shortcut() }}</span>
      }
      <span class="flex shrink-0 items-center justify-center">
        <ng-content select="[menuItemTrailing]" />
      </span>
    </button>
  `,
  host: { class: 'block' },
})
export class MenuItem {
  readonly label = input.required<string>();
  /** Destructive actions (delete, etc.) render in the destructive color. */
  readonly danger = input(false);
  /** Renders the row greyed out and non-interactive. */
  readonly disabled = input(false);
  /**
   * Highlights the row. This is the only thing that drives the highlight —
   * there's no CSS `:hover`, because that stays on whatever row the cursor
   * physically rests over even after keyboard nav moves `active` elsewhere.
   * Callers must listen to `hovered` and feed it back into whatever drives
   * `active`, so mouse and keyboard always agree on a single highlighted item.
   */
  readonly active = input(false);
  /** Key combination shown at the row's end, e.g. `Ctrl+Z`. */
  readonly shortcut = input<string | null>(null);

  readonly selected = output<void>();
  /** Emits when the pointer enters the row (i.e. the mouse moved onto it). */
  readonly hovered = output<void>();

  protected readonly buttonClass = computed(() => {
    if (this.disabled()) return `${BASE} cursor-not-allowed text-foreground/40`;
    if (this.danger()) return `${BASE} text-destructive hover:bg-destructive/10`;
    if (this.active()) return `${BASE} bg-accent text-accent-foreground`;
    return `${BASE} text-foreground/80`;
  });
}
