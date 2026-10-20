import { Component, computed, inject } from '@angular/core';
import { VaultActions } from '../../notes/vault-actions';
import { LucidePanelLeft, LucidePlus } from '@lucide/angular';
import { ICON_RAIL_WIDTH } from '../icon-rail/icon-rail';
import { SidebarState } from '../sidebar/sidebar-state';
import { TabsState } from '../../notes/tabs-state';
import { MainMenu } from './main-menu/main-menu';
import { WindowControls } from '../window-controls/window-controls';
import { TabStrip } from '../tab-strip/tab-strip';

/** Size of the sidebar-toggle button (w-8 in header.html) — used to compute its animated position. */
const TOGGLE_BUTTON_WIDTH = 32;
/** Gap left between the relocated toggle button and the first tab when the sidebar is collapsed. */
const TOGGLE_BUTTON_GAP = 8;

@Component({
  selector: 'app-header',
  imports: [LucidePanelLeft, LucidePlus, MainMenu, WindowControls, TabStrip],
  templateUrl: './header.html',
})
export class Header {
  protected readonly sidebarState = inject(SidebarState);
  protected readonly tabsState = inject(TabsState);
  private readonly vaultActions = inject(VaultActions);
  protected readonly gridTemplateColumns = computed(
    () => `${ICON_RAIL_WIDTH + this.sidebarState.effectiveWidth()}px 1fr auto`,
  );

  // Toggle button lives to the right of the main-menu when the sidebar is
  // expanded, flush against the editor's left edge — but when the sidebar
  // collapses, the header's left column shrinks to just the icon rail, so
  // the button instead relocates to sit flush *before* the tab bar (still
  // aligned with the editor's edge, now from the other side).
  protected readonly toggleButtonLeft = computed(() =>
    this.sidebarState.collapsed()
      ? ICON_RAIL_WIDTH
      : ICON_RAIL_WIDTH + this.sidebarState.width() - TOGGLE_BUTTON_WIDTH,
  );
  protected readonly tabsPaddingLeft = computed(() =>
    this.sidebarState.collapsed() ? TOGGLE_BUTTON_WIDTH + TOGGLE_BUTTON_GAP : 4,
  );
  protected readonly layoutTransition = computed(() =>
    this.sidebarState.resizing() ? 'none' : 'grid-template-columns 200ms ease-out',
  );
  protected readonly toggleTransition = computed(() =>
    this.sidebarState.resizing() ? 'none' : 'left 200ms ease-out',
  );
  protected readonly tabsPaddingTransition = computed(() =>
    this.sidebarState.resizing() ? 'none' : 'padding-left 200ms ease-out',
  );

  toggleSidebar(): void {
    this.sidebarState.toggleCollapsed();
  }

  protected async onNewNote(): Promise<void> {
    await this.vaultActions.createAndOpenNote();
  }
}
