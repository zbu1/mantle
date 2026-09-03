import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LucideCopy, LucideMinus, LucidePanelLeft, LucidePlus, LucideSquare, LucideX } from '@lucide/angular';
import { isTauri } from '../../core/tauri-env';
import { ICON_RAIL_WIDTH } from '../icon-rail/icon-rail';
import { SidebarState } from '../sidebar/sidebar-state';
import { TabsState } from '../../notes/tabs-state';
import { VaultState } from '../../notes/vault-state';
import { MainMenu } from './main-menu/main-menu';
import { VaultMenu } from '../vault-menu/vault-menu';

/** Size of the sidebar-toggle button (w-8 in header.html) — used to compute its animated position. */
const TOGGLE_BUTTON_WIDTH = 32;
/** Gap left between the relocated toggle button and the first tab when the sidebar is collapsed. */
const TOGGLE_BUTTON_GAP = 8;

@Component({
  selector: 'app-header',
  imports: [LucidePanelLeft, LucideMinus, LucideSquare, LucideCopy, LucideX, LucidePlus, MainMenu, VaultMenu],
  templateUrl: './header.html',
})
export class Header {
  protected readonly sidebarState = inject(SidebarState);
  protected readonly tabsState = inject(TabsState);
  private readonly vaultState = inject(VaultState);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly isMaximized = signal(false);
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

  constructor() {
    if (!isTauri()) return;

    const win = getCurrentWindow();
    win.isMaximized().then((maximized) => this.isMaximized.set(maximized));
    win.onResized(async () => this.isMaximized.set(await win.isMaximized())).then((unlisten) => {
      this.destroyRef.onDestroy(unlisten);
    });
  }

  toggleSidebar(): void {
    this.sidebarState.toggleCollapsed();
  }

  protected activateTab(id: string): void {
    this.tabsState.setActive(id);
  }

  protected closeTab(event: Event, id: string): void {
    event.stopPropagation();
    this.tabsState.closeTab(id);
  }

  protected async onNewNote(): Promise<void> {
    const base = 'Untitled';
    for (let i = 0; i < 50; i++) {
      const name = i === 0 ? base : `${base} ${i + 1}`;
      try {
        const created = await this.vaultState.createNote('', name);
        this.tabsState.openInNewTab({ id: created.relPath, title: created.name });
        return;
      } catch {
        // name collision — try the next candidate
      }
    }
  }

  minimize(): void {
    if (isTauri()) getCurrentWindow().minimize();
  }

  toggleMaximize(): void {
    if (isTauri()) getCurrentWindow().toggleMaximize();
  }

  close(): void {
    if (isTauri()) getCurrentWindow().close();
  }
}
