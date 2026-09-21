import { Component, input } from '@angular/core';

/**
 * The floating panel every menu sits in (right-click menus, the "More" menu,
 * the editor slash menu). Owns the surface styling so menus can't drift apart;
 * positioning stays with the caller.
 *
 * Keep the default width in sync with MENU_WIDTH in context-menu.ts, which
 * measures the panel to flip it away from the viewport edge.
 */
@Component({
  selector: 'app-menu-surface',
  template: '<ng-content />',
  host: {
    role: 'menu',
    class: 'animate-pop-in block rounded-md border border-border bg-surface py-1 text-surface-foreground shadow-lg',
    '[class.w-56]': '!wide()',
    '[class.w-72]': 'wide()',
    '[class.overflow-hidden]': '!scrollable()',
    '[class.scrollbar-thin]': 'scrollable()',
    '[class.max-h-72]': 'scrollable()',
    '[class.overflow-y-auto]': 'scrollable()',
  },
})
export class MenuSurface {
  /** Caps the panel height and lets it scroll, for menus with unbounded items. */
  readonly scrollable = input(false);
  /** Widens the panel (w-72) for menus that carry more than a plain item list, e.g. status/info rows. */
  readonly wide = input(false);
}
