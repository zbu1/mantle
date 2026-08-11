import { Component, computed, input, output } from '@angular/core';

const BASE = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs';

/**
 * A single row inside an <app-menu-surface>. Project the leading icon with the
 * `menuItemIcon` attribute:
 *
 *   <app-menu-item label="Delete" [danger]="true">
 *     <svg menuItemIcon lucideTrash2 [size]="14"></svg>
 *   </app-menu-item>
 */
@Component({
  selector: 'app-menu-item',
  template: `
    <button type="button" role="menuitem" (click)="selected.emit()" [class]="buttonClass()">
      <span class="flex size-3.5 shrink-0 items-center justify-center">
        <ng-content select="[menuItemIcon]" />
      </span>
      <span class="flex-1 truncate">{{ label() }}</span>
    </button>
  `,
  host: { class: 'block' },
})
export class MenuItem {
  readonly label = input.required<string>();
  /** Destructive actions (delete, etc.) render in the destructive color. */
  readonly danger = input(false);
  /** Highlights the row without hovering it — used for keyboard selection. */
  readonly active = input(false);

  readonly selected = output<void>();

  protected readonly buttonClass = computed(() => {
    if (this.danger()) return `${BASE} text-destructive hover:bg-destructive/10`;
    if (this.active()) return `${BASE} bg-accent text-accent-foreground`;
    return `${BASE} text-foreground/80 hover:bg-accent hover:text-accent-foreground`;
  });
}
