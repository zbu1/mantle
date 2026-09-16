import { Component, inject } from '@angular/core';
import { LucideCalendar, LucideFolders, LucideNetwork, LucideSearch, LucideSettings } from '@lucide/angular';
import { SettingsModalState } from '../../shared/settings/settings-modal-state';
import { SidebarState } from '../sidebar/sidebar-state';

/** Fixed pixel width of the icon rail — exported so layout components can size around it. */
export const ICON_RAIL_WIDTH = 48;

/**
 * Persistent icon rail pinned to the far left of the window, to the left of
 * the note explorer sidebar. Vault and Settings are the wired-up icons; the
 * rest are speculative stubs for panels that don't exist yet. When the
 * sidebar is collapsed, this rail is the only thing left visible on the
 * left edge.
 */
@Component({
  selector: 'app-icon-rail',
  imports: [LucideFolders, LucideSearch, LucideNetwork, LucideCalendar, LucideSettings],
  templateUrl: './icon-rail.html',
  host: { class: 'contents' },
})
export class IconRail {
  protected readonly sidebarState = inject(SidebarState);
  private readonly settingsModalState = inject(SettingsModalState);

  protected toggleVault(): void {
    this.sidebarState.toggleCollapsed();
  }

  protected openSettings(): void {
    this.settingsModalState.open();
  }
}
