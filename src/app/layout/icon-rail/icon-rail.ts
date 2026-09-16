import { Component, inject } from '@angular/core';
import { LucideCalendar, LucideFileSearch2, LucideFolders, LucideNetwork, LucideSearch, LucideSettings } from '@lucide/angular';
import { QuickSwitcherState } from '../../shared/quick-switcher/quick-switcher-state';
import { SettingsModalState } from '../../shared/settings/settings-modal-state';
import { SidebarState } from '../sidebar/sidebar-state';

/** Fixed pixel width of the icon rail — exported so layout components can size around it. */
export const ICON_RAIL_WIDTH = 48;

/**
 * Persistent icon rail pinned to the far left of the window, to the left of
 * the note explorer sidebar. Vault, Quick Switcher, and Settings are the
 * wired-up icons; the rest are speculative stubs for panels that don't exist
 * yet. When the sidebar is collapsed, this rail is the only thing left
 * visible on the left edge.
 */
@Component({
  selector: 'app-icon-rail',
  imports: [LucideFolders, LucideFileSearch2, LucideSearch, LucideNetwork, LucideCalendar, LucideSettings],
  templateUrl: './icon-rail.html',
  host: { class: 'contents' },
})
export class IconRail {
  protected readonly sidebarState = inject(SidebarState);
  private readonly settingsModalState = inject(SettingsModalState);
  private readonly quickSwitcherState = inject(QuickSwitcherState);

  protected toggleVault(): void {
    this.sidebarState.toggleCollapsed();
  }

  protected openQuickSwitcher(): void {
    this.quickSwitcherState.open();
  }

  protected openSettings(): void {
    this.settingsModalState.open();
  }
}
