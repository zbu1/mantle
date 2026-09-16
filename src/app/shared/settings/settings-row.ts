import { Component, input } from '@angular/core';

/**
 * A single label/description/control row inside a settings category. Project
 * the trailing control (toggle, select, button, ...) as plain content.
 */
@Component({
  selector: 'app-settings-row',
  template: `
    <div class="flex items-center justify-between gap-4 py-3">
      <div class="min-w-0 pr-4">
        <p class="text-xs font-medium text-foreground">{{ label() }}</p>
        @if (description()) {
        <p class="mt-0.5 text-[11px] text-muted-foreground">{{ description() }}</p>
        }
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <ng-content />
      </div>
    </div>
  `,
  host: { class: 'block border-b border-border last:border-b-0' },
})
export class SettingsRow {
  readonly label = input.required<string>();
  readonly description = input<string>();
}
