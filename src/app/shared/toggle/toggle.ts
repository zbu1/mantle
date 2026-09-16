import { Component, input, output } from '@angular/core';

/**
 * A small switch control. Generic UI atom (not settings-specific) — lives
 * beside `shared/menu/` rather than under `shared/settings/`.
 */
@Component({
  selector: 'app-toggle',
  template: `
    <button
      type="button"
      role="switch"
      [attr.aria-checked]="checked()"
      [disabled]="disabled()"
      (click)="!disabled() && changed.emit(!checked())"
      [class]="checked() ? 'bg-primary' : 'bg-muted'"
      class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        [class.translate-x-4]="checked()"
        [class.translate-x-1]="!checked()"
        class="inline-block size-3.5 rounded-full bg-background transition-transform"
      ></span>
    </button>
  `,
  host: { class: 'inline-flex' },
})
export class Toggle {
  readonly checked = input(false);
  readonly disabled = input(false);

  readonly changed = output<boolean>();
}
